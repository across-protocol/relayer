import { ethers } from "ethers";
import sinon from "sinon";
import { expect, createSpyLogger, randomAddress, winston } from "./utils";
import { MemoryPubSub } from "./mocks/MemoryPubSub";
import { Backend, requestTopic, responseTopic, type AugmentedTransaction } from "../src/clients/TransactionClient";
import { encodeAck, encodeFinal, decodeRequest } from "../src/transactionManager/wire";

const eoa = "0xAbC0000000000000000000000000000000000001";
const contractAddress = "0x0000000000000000000000000000000000000002";
const chainId = 1;

function fakeContract(): { contract: ethers.Contract; eoa: string } {
  // Minimal stub: only signer.getAddress, address, interface.getFunction, method are used.
  const iface = new ethers.utils.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
  const signer = { getAddress: async () => eoa } as unknown as ethers.Signer;
  const contract = {
    address: contractAddress,
    signer,
    interface: iface,
  } as unknown as ethers.Contract;
  return { contract, eoa };
}

function fakeTxn(): AugmentedTransaction {
  const { contract } = fakeContract();
  return {
    contract,
    chainId,
    method: "transfer",
    args: [randomAddress(), 1],
    message: "test",
    mrkdwn: "test",
  } as AugmentedTransaction;
}

describe("TransactionBackend", function () {
  let pubsub: MemoryPubSub;
  let backend: Backend;
  let logger: winston.Logger;

  beforeEach(function () {
    ({ spyLogger: logger } = createSpyLogger());
    // For tests we use a single MemoryPubSub for both publisher and subscriber:
    // there's no SUBSCRIBE-state restriction in the mock, so one instance is fine.
    pubsub = new MemoryPubSub();
    backend = new Backend(pubsub, pubsub, logger, { callerId: "test-caller" });
  });

  afterEach(async function () {
    await backend.disconnect();
  });

  describe("submit + ack/final flow", function () {
    it("resolves submit on ack success and wait() on final success", async function () {
      const txn = fakeTxn();
      const reqChannel = requestTopic(chainId, eoa);
      const respChannel = responseTopic(chainId, eoa);

      // Capture the request the backend publishes so we can build a matching response.
      const published: string[] = [];
      await pubsub.sub(reqChannel, (msg) => {
        published.push(msg);
      });

      const submitPromise = backend.submit(txn);

      // Wait a tick for backend to subscribe + publish.
      await new Promise((r) => setTimeout(r, 5));
      expect(published.length).to.equal(1);
      const req = decodeRequest(published[0]);
      expect(req.chainId).to.equal(chainId);
      expect(req.method).to.equal("transfer");

      // Publish ack success on the response channel.
      const hash = "0x" + "ab".repeat(32);
      await pubsub.pub(respChannel, encodeAck({ id: req.id, phase: "ack", ok: true, hash, nonce: 42 }));

      const response = await submitPromise;
      expect(response.hash).to.equal(hash);
      expect(response.nonce).to.equal(42);

      // Publish final success and verify wait() resolves with the receipt.
      const blockHash = "0x" + "bb".repeat(32);
      await pubsub.pub(
        respChannel,
        encodeFinal({
          id: req.id,
          phase: "final",
          ok: true,
          hash,
          receipt: {
            blockNumber: 100,
            blockHash,
            status: 1,
            gasUsed: "0x5208",
            effectiveGasPrice: "0x3b9aca00",
            logs: [],
          },
        })
      );

      const receipt = await response.wait();
      expect(receipt.transactionHash).to.equal(hash);
      expect(receipt.blockNumber).to.equal(100);
      expect(receipt.status).to.equal(1);
    });

    it("rejects submit when ack reports failure", async function () {
      const txn = fakeTxn();
      const reqChannel = requestTopic(chainId, eoa);
      const respChannel = responseTopic(chainId, eoa);

      const published: string[] = [];
      await pubsub.sub(reqChannel, (msg) => {
        published.push(msg);
      });

      const submitPromise = backend.submit(txn);
      await new Promise((r) => setTimeout(r, 5));
      const req = decodeRequest(published[0]);

      await pubsub.pub(
        respChannel,
        encodeAck({ id: req.id, phase: "ack", ok: false, reason: "simulation", error: "revert: foo" })
      );

      let err: Error | undefined;
      try {
        await submitPromise;
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.exist;
      expect(err?.message).to.match(/simulation.*revert: foo/);
    });

    it("rejects wait() when final reports failure", async function () {
      const txn = fakeTxn();
      const reqChannel = requestTopic(chainId, eoa);
      const respChannel = responseTopic(chainId, eoa);

      const published: string[] = [];
      await pubsub.sub(reqChannel, (msg) => {
        published.push(msg);
      });

      const submitPromise = backend.submit(txn);
      await new Promise((r) => setTimeout(r, 5));
      const req = decodeRequest(published[0]);

      const hash = "0x" + "ab".repeat(32);
      await pubsub.pub(respChannel, encodeAck({ id: req.id, phase: "ack", ok: true, hash, nonce: 7 }));
      const response = await submitPromise;

      await pubsub.pub(
        respChannel,
        encodeFinal({ id: req.id, phase: "final", ok: false, reason: "reverted", error: "status=0", hash })
      );

      let err: Error | undefined;
      try {
        await response.wait();
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.exist;
      expect(err?.message).to.match(/reverted.*status=0/);
    });
  });

  describe("subscription lifecycle", function () {
    it("subscribes to each (chain, eoa) response topic exactly once across concurrent submits", async function () {
      const subSpy = sinon.spy(pubsub, "sub");
      const txn = fakeTxn();

      // Fire three concurrent submits before any ack arrives.
      const p1 = backend.submit(txn);
      const p2 = backend.submit(txn);
      const p3 = backend.submit(txn);

      // Wait for them to publish their requests.
      await new Promise((r) => setTimeout(r, 5));

      // Only one sub() call for the response channel.
      const respChannel = responseTopic(chainId, eoa);
      const subCalls = subSpy.getCalls().filter((c) => c.args[0] === respChannel);
      expect(subCalls.length).to.equal(1);

      // Don't leak the pending submits.
      void p1.catch(() => undefined);
      void p2.catch(() => undefined);
      void p3.catch(() => undefined);
    });

    it("unsubscribes on disconnect", async function () {
      const txn = fakeTxn();
      void backend.submit(txn).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 5));

      const respChannel = responseTopic(chainId, eoa);
      // Manual external subscriber to detect whether backend's listener is still active.
      const received: string[] = [];
      await pubsub.sub(respChannel, (msg) => received.push(msg));

      const unsubSpy = sinon.spy(pubsub, "unsub");
      await backend.disconnect();

      const unsubCalls = unsubSpy.getCalls().filter((c) => c.args[0] === respChannel);
      expect(unsubCalls.length).to.equal(1);
    });

    it("rejects pending submits on disconnect", async function () {
      const txn = fakeTxn();
      const submitPromise = backend.submit(txn);
      await new Promise((r) => setTimeout(r, 5));

      await backend.disconnect();

      let err: Error | undefined;
      try {
        await submitPromise;
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.exist;
      expect(err?.message).to.equal("Backend closed");
    });

    it("rejects new submits after disconnect", async function () {
      await backend.disconnect();
      let err: Error | undefined;
      try {
        await backend.submit(fakeTxn());
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).to.equal("Backend is closed");
    });
  });
});
