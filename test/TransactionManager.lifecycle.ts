import { ethers } from "ethers";
import { expect, createSpyLogger, winston } from "./utils";
import { TransactionReceipt } from "@ethersproject/abstract-provider";
import { MemoryPubSub } from "./mocks/MemoryPubSub";
import { MemoryCache } from "./mocks/MemoryCache";
import { MockedTransactionClient } from "./mocks/MockTransactionClient";
import { TransactionManager, requestTopic, responseTopic } from "../src/transactionManager/TransactionManager";
import {
  AckMessage,
  decodeResponse,
  encodeRequest,
  FinalMessage,
  ResponseMessage,
  SubmissionRequest,
} from "../src/transactionManager/wire";

// Build a SubmissionRequest. By default the mocked TransactionClient returns
// success; appending an object with `{ result }` to args steers it to a
// failure path with the given reason.
function buildRequest(opts: { id?: string; chainId?: number; failureReason?: string } = {}): SubmissionRequest {
  const id = opts.id ?? `test-${Math.random().toString(36).slice(2, 10)}`;
  const chainId = opts.chainId ?? 1;
  const args: unknown[] = ["0x0000000000000000000000000000000000000001", 0];
  if (opts.failureReason !== undefined) {
    args.push({ result: opts.failureReason });
  }
  return {
    id,
    chainId,
    to: "0x0000000000000000000000000000000000000002",
    abi: '[{"name":"transfer","type":"function","inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"type":"bool"}],"stateMutability":"nonpayable"}]',
    method: "transfer",
    args,
    value: undefined,
    gasLimit: undefined,
    gasLimitMultiplier: undefined,
    confirmations: undefined,
    message: undefined,
    mrkdwn: undefined,
  };
}

function fakeReceipt(hash: string, status: 0 | 1 = 1): TransactionReceipt {
  return {
    transactionHash: hash,
    blockHash: "0x" + "bb".repeat(32),
    blockNumber: 100,
    status,
    gasUsed: ethers.BigNumber.from(21_000),
    effectiveGasPrice: ethers.BigNumber.from(1_000_000_000),
    logs: [],
    confirmations: 1,
    cumulativeGasUsed: ethers.BigNumber.from(21_000),
    transactionIndex: 0,
    contractAddress: "",
    type: 0,
    byzantium: true,
    from: "0x0",
    to: "0x0",
    logsBloom: "0x",
  } as unknown as TransactionReceipt;
}

async function collectResponses(
  pubsub: MemoryPubSub,
  topic: string,
  predicate: (msgs: ResponseMessage[]) => boolean,
  timeoutMs = 500
): Promise<ResponseMessage[]> {
  const received: ResponseMessage[] = [];
  const listener = (payload: string): void => {
    received.push(decodeResponse(payload));
  };
  await pubsub.sub(topic, listener);
  const start = Date.now();
  try {
    while (!predicate(received) && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 5));
    }
  } finally {
    await pubsub.unsub(topic, listener);
  }
  return received;
}

describe("TransactionManager lifecycle", function () {
  let logger: winston.Logger;
  // Single shared broker — in real Redis everything routes through one server.
  // The publisher/subscriber pair exists only to dodge Redis's SUBSCRIBE-state
  // restriction; the in-memory mock has no such restriction.
  let broker: MemoryPubSub;
  let cache: MemoryCache;
  let txnClient: MockedTransactionClient;
  let abortController: AbortController;
  let wallet: ethers.Wallet;
  let reqTopic: string;
  let respTopic: string;
  const chainId = 1;

  beforeEach(function () {
    ({ spyLogger: logger } = createSpyLogger());
    broker = new MemoryPubSub();
    cache = new MemoryCache();
    txnClient = new MockedTransactionClient(logger);
    abortController = new AbortController();
    wallet = ethers.Wallet.createRandom();
    reqTopic = requestTopic(chainId, wallet.address.toLowerCase());
    respTopic = responseTopic(chainId, wallet.address.toLowerCase());
  });

  function newManager(overrides: Partial<Parameters<typeof makeOpts>[0]> = {}) {
    const opts = makeOpts(overrides);
    return new TransactionManager(opts);
  }

  function makeOpts(overrides: Partial<{ runIdentifier: string; leaseRenewIntervalSec: number }> = {}) {
    return {
      chainId,
      signer: wallet,
      runIdentifier: overrides.runIdentifier ?? "test-run-1",
      publisher: broker,
      subscriber: broker,
      cache,
      logger,
      abortController,
      txnClient,
      // Short renewal so any lease loss is detectable within test timeouts.
      leaseRenewIntervalSec: overrides.leaseRenewIntervalSec ?? 60,
      leaseTtlSec: 120,
    };
  }

  it("emits ack success + final success on happy path", async function () {
    const hash = ethers.utils.id("happy-path");
    txnClient.waitOverride = async () => fakeReceipt(hash, 1);

    const manager = newManager();
    const running = manager.start();
    // Wait until manager has subscribed to its request topic.
    await new Promise((r) => setTimeout(r, 20));

    const req = buildRequest();
    const responsesPromise = collectResponses(broker, respTopic, (msgs) => msgs.length >= 2, 1000);
    await broker.pub(reqTopic, encodeRequest(req));
    const responses = await responsesPromise;

    abortController.abort();
    await running;

    expect(responses).to.have.length(2);
    const ack = responses[0] as AckMessage;
    const final = responses[1] as FinalMessage;
    expect(ack.phase).to.equal("ack");
    expect(ack.ok).to.equal(true);
    if (ack.ok) {
      expect(ack.id).to.equal(req.id);
      expect(ack.hash).to.be.a("string");
    }
    expect(final.phase).to.equal("final");
    expect(final.ok).to.equal(true);
    if (final.ok) {
      expect(final.receipt.status).to.equal(1);
    }
  });

  it("emits ack failure on simulation failure", async function () {
    const manager = newManager();
    const running = manager.start();
    await new Promise((r) => setTimeout(r, 20));

    const req = buildRequest({ failureReason: "revert: bad state" });
    const responsesPromise = collectResponses(broker, respTopic, (msgs) => msgs.length >= 1, 500);
    await broker.pub(reqTopic, encodeRequest(req));
    const responses = await responsesPromise;

    abortController.abort();
    await running;

    expect(responses).to.have.length(1);
    const ack = responses[0] as AckMessage;
    expect(ack.phase).to.equal("ack");
    expect(ack.ok).to.equal(false);
    if (!ack.ok) {
      expect(ack.reason).to.equal("simulation");
      expect(ack.error).to.match(/bad state/);
    }
  });

  it("emits final failure on reverted receipt", async function () {
    const hash = ethers.utils.id("reverted-path");
    txnClient.waitOverride = async () => fakeReceipt(hash, 0);

    const manager = newManager();
    const running = manager.start();
    await new Promise((r) => setTimeout(r, 20));

    const req = buildRequest();
    const responsesPromise = collectResponses(broker, respTopic, (msgs) => msgs.length >= 2, 1000);
    await broker.pub(reqTopic, encodeRequest(req));
    const responses = await responsesPromise;

    abortController.abort();
    await running;

    const final = responses[1] as FinalMessage;
    expect(final.phase).to.equal("final");
    expect(final.ok).to.equal(false);
    if (!final.ok) {
      expect(final.reason).to.equal("reverted");
    }
  });

  it("processes multiple concurrent requests sequentially", async function () {
    txnClient.waitOverride = async () => fakeReceipt(ethers.utils.id("multi"), 1);

    const manager = newManager();
    const running = manager.start();
    await new Promise((r) => setTimeout(r, 20));

    const reqs = [buildRequest({ id: "r1" }), buildRequest({ id: "r2" }), buildRequest({ id: "r3" })];
    const responsesPromise = collectResponses(
      broker,
      respTopic,
      (msgs) => msgs.filter((m) => m.phase === "ack").length >= 3,
      1500
    );
    await Promise.all(reqs.map((r) => broker.pub(reqTopic, encodeRequest(r))));
    const responses = await responsesPromise;

    abortController.abort();
    await running;

    const acks = responses.filter((m) => m.phase === "ack");
    expect(acks.length).to.equal(3);
    // ACKs preserve arrival order (chain serialisation).
    expect(acks.map((m) => m.id)).to.deep.equal(["r1", "r2", "r3"]);
  });

  it("drains in-flight work when aborted mid-stream", async function () {
    txnClient.waitOverride = async () => fakeReceipt(ethers.utils.id("drain"), 1);

    const manager = newManager();
    const running = manager.start();
    await new Promise((r) => setTimeout(r, 20));

    const responsesPromise = collectResponses(
      broker,
      respTopic,
      (msgs) => msgs.filter((m) => m.phase === "final").length >= 2,
      1500
    );

    await broker.pub(reqTopic, encodeRequest(buildRequest({ id: "drain-1" })));
    await broker.pub(reqTopic, encodeRequest(buildRequest({ id: "drain-2" })));

    // Abort almost immediately — both requests should still drain through the
    // chain and inFlight, emitting their finals before start() resolves.
    await new Promise((r) => setTimeout(r, 5));
    abortController.abort();

    const responses = await responsesPromise;
    await running;

    const finals = responses.filter((m) => m.phase === "final");
    expect(finals.length).to.equal(2);
    expect(finals.map((m) => m.id).sort()).to.deep.equal(["drain-1", "drain-2"]);
  });
});
