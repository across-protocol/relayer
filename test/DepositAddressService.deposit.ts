import { AddressInfo } from "net";
import { Server } from "http";
import { expect, winston } from "./utils";
import { AcrossApiHttpError } from "../src/clients/AcrossApiBaseClient";
import {
  AcrossSwapApiClient,
  DepositAddressExecuteResponse,
  DepositAddressSignWithdrawRequest,
  DepositAddressSignWithdrawResponse,
} from "../src/clients/AcrossSwapApiClient";
import { AugmentedTransaction, TransactionClient } from "../src/clients/TransactionClient";
import {
  CHAIN_IDs,
  EvmAddress,
  Provider,
  TransactionReceipt,
  TransactionResponse,
  Wallet,
  ethers,
  toBN,
} from "../src/utils";
import { GcpPubSubPublisher } from "../src/messaging/gcp";
import { createApp } from "../src/deposit-address-service/app";
import { DepositAddressServiceConfig } from "../src/deposit-address-service/config";
import { createDepositHandler } from "../src/deposit-address-service/depositHandler";
import { RequestLifecycle } from "../src/deposit-address-service/lifecycle";
import { TransferStore, TransferStoreRedis } from "../src/deposit-address-service/transferState";

/**
 * The v3 deposit execute and refund-withdraw paths over the real Express boundary and the real store, with
 * only the chain, the quote-api and the submission client faked. Every case below is a failure point from the
 * plan's verification list, and each asserts the **queue disposition** as well as the state left in Redis,
 * because those two together are what stop a transfer being swept — or refunded — twice.
 */
describe("DepositAddressService v3 execution", function () {
  const ARBITRUM = CHAIN_IDs.ARBITRUM;
  const FUNDING_TX = "0xa3f1c7d40e9b6852f1ad0c3b7e94f628a1d5c09e3b7a2d8f4c6e1b0a9d8c7f6e5";
  const FUNDING_BLOCK = 312884201;
  const DEPOSIT_ADDRESS = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
  const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  const TRANSFER_ID = `${ARBITRUM}:${FUNDING_TX}:7`;
  const STATE_KEY = `deposit-address:state:${TRANSFER_ID}`;
  const LOCK_KEY = `deposit-address:lock:${TRANSFER_ID}`;
  const AMOUNT = "10000000";
  const EXECUTE_HASH = "0xbb11c7d40e9b6852f1ad0c3b7e94f628a1d5c09e3b7a2d8f4c6e1b0a9d8c7f600";
  const ORIGINAL_HASH = "0xaa22c7d40e9b6852f1ad0c3b7e94f628a1d5c09e3b7a2d8f4c6e1b0a9d8c7f611";
  const SIGNER_NONCE = 41;
  const METADATA_TOPIC = ethers.utils.id("MetadataEmitted(bytes)");
  const TRANSFER_TOPIC = ethers.utils.id("Transfer(address,address,uint256)");
  const REFUND_ADDRESS = "0x9A6e5F1B8C7D0E3a2b4c5D6e7F8A9b0c1D2E3f40";
  const LIFECYCLE_TOPIC = "topic-deposit-address-execution-test";
  const LIFECYCLE_MESSAGE_ID = "pubsub-99123";
  const SETTLEMENT_LOG_INDEX = 3;
  const WITHDRAW_LEAF = {
    kind: "withdraw",
    implementationAddress: "0x00000000000000000000000000000000000000e1",
    encodedParams: "0x",
    leafHash: "0x01",
    merkleProof: ["0x0000000000000000000000000000000000000000000000000000000000000002"],
  };

  let server: Server;
  let baseUrl: string;
  let logs: { level: string; payload: Record<string, unknown> }[];
  let redisStore: Map<string, string>;
  let signerAddress: string;

  /** 1-based `set` call indices that reject. Models a Redis blip at a precise point in the broadcast. */
  let redisFaults: { failSetCalls: number[]; setCalls: number };

  /** What the fake chain reports. Each test reshapes only the part it is about. */
  let chain: {
    fundingReceipt: TransactionReceipt | null;
    balance: string;
    executeReceipt: TransactionReceipt | null;
    latestNonce: number;
    receiptError?: Error;
  };

  /** What the fake submission client does once it has been handed the transaction. */
  let submission: {
    mode: "broadcast" | "throwBeforeBroadcast" | "throwAfterBroadcast" | "noHash" | "repriced";
    hash: string;
  };

  /** What the quote-api answers. */
  let quote: { response?: Partial<DepositAddressExecuteResponse>; error?: Error };

  /** Every lifecycle announcement the handler published, and an optional failure to inject. */
  let lifecycle: { published: { topic: string; payload: unknown }[]; error?: Error };

  /** What the sign-withdraw endpoint answers, plus every request it received. */
  let withdraw: {
    response?: Partial<DepositAddressSignWithdrawResponse>;
    error?: Error;
    requests: DepositAddressSignWithdrawRequest[];
  };

  /**
   * The lock value observed inside each quote-api call. Asserting the two are the same defined token is what
   * pins "one lock held across both actions" for the below-minimum fallback — a release-and-reacquire (or a
   * release-then-withdraw) would be invisible to the state assertions alone.
   */
  let lockSeen: { atExecute?: string; atSignWithdraw?: string };

  function message(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      depositAddress: DEPOSIT_ADDRESS,
      version: 3,
      salt: "0x00",
      initialRoot: "0x00",
      counterfactualBeaconContractAddress: "0x00000000000000000000000000000000000000b1",
      counterfactualFactoryContractAddress: "0x00000000000000000000000000000000000000f1",
      adminWithdrawManagerContractAddress: "0x00000000000000000000000000000000000000a1",
      shouldSponsorAccountCreation: false,
      counterfactualMaterials: [WITHDRAW_LEAF],
      depositAddressNamespace: "evm",
      refundAddress: { namespace: "evm", address: REFUND_ADDRESS },
      routeParams: {
        outputToken: USDC,
        destinationChainId: "8453",
        recipient: { namespace: "evm", address: "0x9A6e5F1B8C7D0E3a2b4c5D6e7F8A9b0c1D2E3f40" },
      },
      erc20Transfer: {
        chainId: String(ARBITRUM),
        blockNumber: FUNDING_BLOCK,
        logIndex: 7,
        from: "0x9A6e5F1B8C7D0E3a2b4c5D6e7F8A9b0c1D2E3f40",
        to: DEPOSIT_ADDRESS,
        amount: AMOUNT,
        contractAddress: USDC,
        transactionHash: FUNDING_TX,
        transferClassification: "correct_transfer",
      },
      integrator: { name: "test", integratorId: "0x1dc0" },
      ...over,
    };
  }

  function receipt(over: Partial<TransactionReceipt> = {}): TransactionReceipt {
    return { blockNumber: FUNDING_BLOCK, status: 1, logs: [], ...over } as TransactionReceipt;
  }

  /**
   * The ERC20 `Transfer` a settled refund leaves behind — token contract, `from` the deposit address, `to` the
   * refund address. `buildWithdrawExecutedPayload` matches on all three and takes its `logIndex` from the log,
   * which is why the announcement needs the receipt and cannot be rebuilt from the state record.
   */
  function settlementLog(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      address: USDC,
      topics: [
        TRANSFER_TOPIC,
        ethers.utils.hexZeroPad(DEPOSIT_ADDRESS.toLowerCase(), 32),
        ethers.utils.hexZeroPad(REFUND_ADDRESS.toLowerCase(), 32),
      ],
      logIndex: SETTLEMENT_LOG_INDEX,
      ...over,
    };
  }

  function recordingLogger(): winston.Logger {
    const record = (level: string) => (payload: Record<string, unknown>) => void logs.push({ level, payload });
    return {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    } as unknown as winston.Logger;
  }

  /** Only the commands `TransferStore` issues, so this can `satisfies` rather than be cast. */
  function fakeRedis(): TransferStoreRedis {
    return {
      async acquireLock(key: string, token: string) {
        if (redisStore.has(key)) {
          return false;
        }
        redisStore.set(key, token);
        return true;
      },
      async releaseLock(key: string, token: string) {
        if (redisStore.get(key) !== token) {
          return false;
        }
        redisStore.delete(key);
        return true;
      },
      async get<T>(key?: string) {
        return (redisStore.get(key ?? "") ?? null) as T | null;
      },
      async set<T>(key: string, val: T) {
        redisFaults.setCalls += 1;
        if (redisFaults.failSetCalls.includes(redisFaults.setCalls)) {
          throw new Error("READONLY You can't write against a read only replica");
        }
        redisStore.set(key, String(val));
        return "OK";
      },
      async del(key: string) {
        return redisStore.delete(key) ? 1 : 0;
      },
    } satisfies TransferStoreRedis;
  }

  /**
   * A real `JsonRpcProvider` with its methods replaced, not a plain object: `new Contract(addr, abi, provider)`
   * checks `Provider.isProvider()`, so a bare fake would make every non-native balance read throw and look like
   * a transient RPC failure rather than exercising the guard.
   */
  function fakeProvider(): Provider {
    const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:1/never-called");
    return Object.assign(provider, {
      getTransactionReceipt: async (hash: string) => {
        if (chain.receiptError) {
          throw chain.receiptError;
        }
        // The funding lookup and the execute lookup share this method; distinguish by hash.
        return hash.toLowerCase() === FUNDING_TX ? chain.fundingReceipt : chain.executeReceipt;
      },
      getBalance: async () => toBN(chain.balance),
      getTransactionCount: async () => chain.latestNonce,
      // `readDepositAddressBalance` reads a real ERC20 contract for non-native tokens: answer `balanceOf`.
      call: async () => ethers.utils.defaultAbiCoder.encode(["uint256"], [toBN(chain.balance)]),
      getNetwork: async () => ({ chainId: ARBITRUM, name: "arbitrum" }),
    }) as unknown as Provider;
  }

  /**
   * Stands in for `TransactionClient` at the two methods `submitTransaction` uses. Crucially it invokes
   * `onBroadcast` exactly where the real client does — once the hash exists and **before** the confirmation
   * wait — so the tests exercise the seam the design depends on rather than a convenient approximation.
   */
  function fakeTransactionClient(): TransactionClient {
    return {
      async simulate(txns: AugmentedTransaction[]) {
        return txns.map((transaction) => ({ transaction, succeed: true }));
      },
      async submit(_chainId: number, txns: AugmentedTransaction[]) {
        const txn = txns[0];
        if (submission.mode === "throwBeforeBroadcast") {
          throw new Error("nonce too low");
        }

        // A repriced transaction notifies the original hash first, then the replacement — exactly where the
        // real client re-notifies, so the record has to follow it.
        if (submission.mode === "repriced") {
          await txn.onBroadcast?.({
            hash: ORIGINAL_HASH,
            nonce: SIGNER_NONCE,
            from: signerAddress,
          } as unknown as TransactionResponse);
        }

        const response = {
          hash: submission.hash,
          nonce: SIGNER_NONCE,
          from: signerAddress,
        } as unknown as TransactionResponse;
        await txn.onBroadcast?.(response);

        if (submission.mode === "throwAfterBroadcast") {
          throw new Error("Arbitrum transaction reverted");
        }
        // An empty array is what `submit()` returns when `_submit` threw; `submitTransaction` turns it into a
        // generic Error, which is precisely why the outcome is read from the chain instead.
        return submission.mode === "noHash" ? [] : [response];
      },
    } as unknown as TransactionClient;
  }

  function fakeApi(): AcrossSwapApiClient {
    return {
      async executeDepositAddress(): Promise<DepositAddressExecuteResponse> {
        lockSeen.atExecute = redisStore.get(LOCK_KEY);
        if (quote.error) {
          throw quote.error;
        }
        return {
          depositAddress: DEPOSIT_ADDRESS,
          executeTx: {
            ecosystem: "evm",
            chainId: ARBITRUM,
            to: "0x0000000000000000000000000000000000000ca1",
            data: "0xdeadbeef",
            value: "0",
          },
          signer: signerAddress,
          signatureDeadline: Math.floor(Date.now() / 1000) + 600,
          isPlaceholder: false,
          ...quote.response,
        };
      },
      async signWithdrawDepositAddressV3(
        request: DepositAddressSignWithdrawRequest
      ): Promise<DepositAddressSignWithdrawResponse> {
        withdraw.requests.push(request);
        lockSeen.atSignWithdraw = redisStore.get(LOCK_KEY);
        if (withdraw.error) {
          throw withdraw.error;
        }
        return {
          signedWithdrawTx: {
            ecosystem: "evm",
            chainId: ARBITRUM,
            to: "0x0000000000000000000000000000000000000ca1",
            data: "0xfeedface",
            value: "0",
          },
          bundledDeploy: false,
          signer: signerAddress,
          deadline: Math.floor(Date.now() / 1000) + 600,
          requestedAmount: AMOUNT,
          appliedGasFee: "2000",
          netAmount: "9998000",
          ...withdraw.response,
        };
      },
    } as unknown as AcrossSwapApiClient;
  }

  /**
   * Stands in for `GcpPubSubPublisher`, which `getGcpPubSubPublisher` refuses to build under `RELAYER_TEST`.
   * Records what was announced and where, so a test can assert the envelope the indexer consumer is keyed on.
   */
  function fakePublisher(): GcpPubSubPublisher {
    return {
      async publishJson(topic: string, payload: unknown) {
        if (lifecycle.error) {
          throw lifecycle.error;
        }
        lifecycle.published.push({ topic, payload });
        return LIFECYCLE_MESSAGE_ID;
      },
    } as unknown as GcpPubSubPublisher;
  }

  function pushBody(payload: Record<string, unknown>): string {
    return JSON.stringify({
      message: {
        data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
        messageId: "msg-4412",
        publishTime: "2026-08-11T10:00:00.000Z",
      },
      subscription: "projects/p/subscriptions/s",
    });
  }

  async function post(payload: Record<string, unknown>): Promise<Response> {
    return fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: pushBody(payload),
    });
  }

  function state(): Record<string, unknown> | undefined {
    const raw = redisStore.get(STATE_KEY);
    return raw === undefined ? undefined : JSON.parse(raw);
  }

  function lastLine(): Record<string, unknown> {
    expect(logs.length).to.be.greaterThan(0);
    return logs[logs.length - 1].payload;
  }

  /** The structured failure block from the one log line. Named `failure`, not `error`, so the logger keeps it. */
  function failure(): Record<string, unknown> {
    const block = lastLine().failure;
    expect(block, "expected a failure block on the outcome line").to.not.equal(undefined);
    return block as Record<string, unknown>;
  }

  beforeEach(async function () {
    logs = [];
    redisStore = new Map();
    redisFaults = { failSetCalls: [], setCalls: 0 };
    chain = {
      fundingReceipt: receipt(),
      balance: AMOUNT,
      executeReceipt: receipt({ blockNumber: FUNDING_BLOCK + 10, logs: [{ topics: [METADATA_TOPIC] }] as never }),
      latestNonce: SIGNER_NONCE,
    };
    submission = { mode: "broadcast", hash: EXECUTE_HASH };
    quote = {};
    withdraw = { requests: [] };
    lockSeen = {};
    lifecycle = { published: [] };

    await startServer({
      ENABLE_V3_WITHDRAWALS: "true",
      ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER: "true",
      PUBSUB_GCP_PROJECT_ID: "test-project",
      PUBSUB_DEPOSIT_ADDRESS_WITHDRAW_TOPIC: LIFECYCLE_TOPIC,
    });
  });

  /**
   * Builds the handler and binds the app. Re-callable inside a test that needs different env, e.g. the
   * withdraw gate off. `publisher` defaults on so every withdraw test exercises the announcement rather than
   * passing because publishing happened to be disabled; pass `false` for the unconfigured case.
   */
  async function startServer(env: Record<string, string>, publisher = true): Promise<void> {
    const baseSigner = Wallet.createRandom();
    signerAddress = await baseSigner.getAddress();

    const logger = recordingLogger();
    const config = new DepositAddressServiceConfig({
      EXECUTION_ENABLED: "true",
      RELAYER_ORIGIN_CHAINS: `[${ARBITRUM}]`,
      ...env,
    } as never);

    const handler = createDepositHandler({
      logger,
      config,
      store: new TransferStore(fakeRedis()),
      api: fakeApi(),
      transactionClient: fakeTransactionClient(),
      baseSigner,
      signerAddress: EvmAddress.from(signerAddress),
      dispatcherSigners: [],
      publisher: publisher ? fakePublisher() : undefined,
      // Throws for any chain but the configured one, because the real `getProvider` throws
      // `No RPC providers defined` for a chain with no RPC configuration. A fake that answered for every
      // chain would be more forgiving than production and would mask a guard running *after* the provider
      // is built — which it did, until review caught it.
      getProvider: async (chainId: number) => {
        if (chainId !== ARBITRUM) {
          throw new Error(`No RPC providers defined for chain ${chainId}`);
        }
        return fakeProvider();
      },
    });

    const app = createApp({ logger, config, lifecycle: new RequestLifecycle(), handler });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }

  afterEach(function () {
    server?.close();
  });

  describe("the happy path", function () {
    it("executes, records deposit_executed and ACKs", async function () {
      const response = await post(message());

      expect(response.status).to.equal(204);
      expect(state()).to.deep.include({
        status: "deposit_executed",
        txHash: EXECUTE_HASH,
        chainId: ARBITRUM,
        blockNumber: FUNDING_BLOCK + 10,
      });
      expect(lastLine()).to.include({ outcome: "deposit_executed", metadataEmitted: true });
    });

    // The lock is what stops two live consumers both passing the guards; holding it after a finished request
    // would block the transfer for the whole TTL for nothing.
    it("releases the lock on the way out", async function () {
      await post(message());
      expect(redisStore.has(LOCK_KEY)).to.equal(false);
    });

    it("warns but still records the sweep when the provenance event is missing", async function () {
      chain.executeReceipt = receipt({ blockNumber: FUNDING_BLOCK + 10, logs: [] as never });

      const response = await post(message());

      expect(response.status).to.equal(204);
      // Never a cause of re-execution: the funds have already moved.
      expect(state()).to.include({ status: "deposit_executed" });
      expect(logs.some((l) => l.level === "warn")).to.equal(true);
      expect(lastLine()).to.include({ metadataEmitted: false });
    });
  });

  describe("broadcast_pending is durable before the confirmation wait", function () {
    it("records the hash from the onBroadcast hook", async function () {
      // Left unresolved so the record is observed as the hook wrote it, before any terminal write.
      chain.executeReceipt = null;

      const response = await post(message());

      expect(response.status).to.equal(500);
      expect(state()).to.deep.include({
        status: "broadcast_pending",
        operation: "deposit",
        txHash: EXECUTE_HASH,
        chainId: ARBITRUM,
      });
    });

    // The regression test for the failure this whole service exists to close. `TransactionClient` swallows a
    // failing onBroadcast hook, so if the hash were only captured *after* a successful write, a Redis blip
    // would leave a confirmed sweep with no record anywhere — and a redelivery free to sweep the next
    // unrelated transfer's money with the same calldata. Both set calls fail here (the hook's and the
    // post-submit retry's), so nothing is recorded until the terminal write.
    it("records the terminal state when both pending writes failed but the transaction confirmed", async function () {
      redisFaults.failSetCalls = [1, 2, 3, 4];

      const response = await post(message());

      expect(response.status).to.equal(204);
      expect(state()).to.include({ status: "deposit_executed", txHash: EXECUTE_HASH });
      // The swallowed write is visible, rather than silent.
      expect(logs.some((l) => l.level === "warn")).to.equal(true);
    });

    it("retries the pending write after submission when the hook's write failed", async function () {
      // Only the hook's write fails; the retry lands. Left unresolved so the retry's result is what is observed.
      redisFaults.failSetCalls = [1];
      chain.executeReceipt = null;

      const response = await post(message());

      expect(response.status).to.equal(500);
      // Durable before the NACK, so the redelivery resolves this hash instead of re-executing.
      expect(state()).to.include({ status: "broadcast_pending", txHash: EXECUTE_HASH });
    });

    // The sharp case. The original hash persisted, the client repriced, and the replacement's write failed —
    // so Redis names a transaction that will never mine while `pending` names the live one. `canReplace` then
    // refuses the terminal write because the hashes differ, and every later delivery resolves the dead hash
    // instead. Failing the first retry too proves the backoff is doing the work: one attempt would not save it.
    it("re-persists a repriced replacement so its terminal state is accepted", async function () {
      submission.mode = "repriced";
      // set #1 = the original hash (lands), #2 = the replacement's hook write, #3 = its first retry.
      redisFaults.failSetCalls = [2, 3];

      const response = await post(message());

      expect(response.status).to.equal(204);
      expect(state()).to.include({ status: "deposit_executed", txHash: EXECUTE_HASH });
    });

    it("warns that the terminal write will be refused when a replacement can never be persisted", async function () {
      submission.mode = "repriced";
      // The original lands; every write for the replacement fails, including all of the retries.
      redisFaults.failSetCalls = [2, 3, 4, 5];

      const response = await post(message());

      // Stuck on the dead hash — the accepted residual — but named rather than silent.
      expect(response.status).to.equal(500);
      expect(state()).to.include({ status: "broadcast_pending", txHash: ORIGINAL_HASH });
      expect(
        logs.some((l) => l.level === "warn" && /terminal write will be refused/.test(String(l.payload.message)))
      ).to.equal(true);
    });

    // Nothing reached the wire, so there is nothing to reconcile and nothing to record.
    it("writes no state when submission fails before any broadcast", async function () {
      submission.mode = "throwBeforeBroadcast";

      const response = await post(message());

      expect(response.status).to.equal(500);
      expect(state()).to.equal(undefined);
      expect(failure()).to.include({ code: "TRANSIENT_DEPENDENCY_FAILURE" });
    });
  });

  describe("the outcome comes from the chain, not the exception", function () {
    // `submit()` flattens revert, exhausted retries and RPC failure into one untyped Error, so a throw with a
    // hash in hand means "ask the chain", not "assume the worst".
    it("still records success when submission throws after the transaction confirmed", async function () {
      submission.mode = "throwAfterBroadcast";

      const response = await post(message());

      expect(response.status).to.equal(204);
      expect(state()).to.include({ status: "deposit_executed" });
    });

    it("clears the record and NACKs on an on-chain revert", async function () {
      chain.executeReceipt = receipt({ blockNumber: FUNDING_BLOCK + 10, status: 0 });

      const response = await post(message());

      expect(response.status).to.equal(500);
      // Nothing moved, so the transfer may be attempted again.
      expect(state()).to.equal(undefined);
      expect(failure()).to.include({ code: "BROADCAST_REVERTED" });
    });

    it("retains the record and NACKs while a transaction might still land", async function () {
      chain.executeReceipt = null;

      const response = await post(message());

      expect(response.status).to.equal(500);
      expect(state()).to.include({ status: "broadcast_pending" });
      expect(failure()).to.include({ code: "UNRESOLVED_BROADCAST" });
    });

    it("retains the record when the receipt lookup itself fails", async function () {
      // An RPC failure is not evidence of anything. Guessing "gone" here is the irreversible direction.
      chain.receiptError = new Error("upstream connect error");

      const response = await post(message());

      expect(response.status).to.equal(500);
      expect(failure()).to.include({ code: "TRANSIENT_DEPENDENCY_FAILURE" });
    });
  });

  describe("an unresolved transaction is retained, never cleared", function () {
    // Every reason a receipt can be missing gets the same answer: unmined, dropped, replaced at its nonce,
    // already mined behind a lagging RPC node, or reorged out. Retaining is safe in all of them and clearing
    // is unrecoverable in some, so the service does not try to tell them apart — and nonce management stays
    // TransactionClient's concern.
    it("retains the record when the transaction has no receipt", async function () {
      chain.executeReceipt = null;

      const response = await post(message());

      expect(response.status).to.equal(500);
      expect(state()).to.include({ status: "broadcast_pending" });
      expect(failure()).to.include({ code: "UNRESOLVED_BROADCAST" });
    });

    it("retains the record even once the signer has moved past this nonce", async function () {
      // The transaction was replaced and will never mine. Still retained: the service does not read nonces to
      // work that out, so the transfer stays blocked until an operator clears the key. Accepted.
      chain.executeReceipt = null;
      chain.latestNonce = SIGNER_NONCE + 5;

      const response = await post(message());

      expect(response.status).to.equal(500);
      expect(state()).to.include({ status: "broadcast_pending" });
      expect(failure()).to.include({ code: "UNRESOLVED_BROADCAST" });
    });
  });

  describe("redelivery", function () {
    it("ACKs a transfer that already reached a terminal state without touching the chain", async function () {
      redisStore.set(
        STATE_KEY,
        JSON.stringify({
          status: "deposit_executed",
          txHash: EXECUTE_HASH,
          chainId: ARBITRUM,
          blockNumber: FUNDING_BLOCK + 10,
          completedAtMs: 1_700_000_000_000,
        })
      );
      // Would fail every guard if the path were re-entered.
      chain.fundingReceipt = null;
      chain.balance = "0";

      const response = await post(message());

      expect(response.status).to.equal(204);
      expect(lastLine()).to.include({ outcome: "already_deposit_executed" });
    });

    it("resolves a pending record instead of re-executing", async function () {
      redisStore.set(
        STATE_KEY,
        JSON.stringify({
          status: "broadcast_pending",
          operation: "deposit",
          txHash: EXECUTE_HASH,
          chainId: ARBITRUM,
          submittedAtMs: 1_700_000_000_000,
        })
      );
      // A second broadcast would answer with this hash; the recorded one is what must be resolved.
      submission.hash = "0xdeadbeef";

      const response = await post(message());

      expect(response.status).to.equal(204);
      expect(state()).to.include({ status: "deposit_executed", txHash: EXECUTE_HASH });
      // Resolving a pending record announces a settled withdrawal, but never a deposit: the indexer reads
      // the deposit's provenance event on-chain.
      expect(lifecycle.published).to.have.length(0);
    });

    it("NACKs while another consumer holds the lock", async function () {
      redisStore.set(LOCK_KEY, "some-other-attempt-uuid");

      const response = await post(message());

      expect(response.status).to.equal(500);
      expect(state()).to.equal(undefined);
      expect(failure()).to.include({ code: "LOCK_CONTENTION" });
    });
  });

  describe("guards that need the chain", function () {
    // Ordered before the balance check on purpose: this one can tell a real funding transfer from money that
    // merely happens to be sitting at a shared-pot address.
    it("ACKs a transfer whose funding transaction is mined at a different block", async function () {
      chain.fundingReceipt = receipt({ blockNumber: FUNDING_BLOCK + 1 });

      const response = await post(message());

      expect(response.status).to.equal(204);
      expect(state()).to.equal(undefined);
      expect(failure()).to.include({ code: "NON_CANONICAL_TRANSFER" });
    });

    // Ambiguous between reorged-away and our RPC lagging the indexer, and re-reading a receipt is harmless —
    // so this must NOT ACK, or every lag would silently discard a live transfer.
    it("NACKs when the funding transaction is not yet visible", async function () {
      chain.fundingReceipt = null;

      const response = await post(message());

      expect(response.status).to.equal(500);
      expect(failure()).to.include({ code: "TRANSIENT_DEPENDENCY_FAILURE" });
    });

    it("ACKs and writes no state when the balance is short", async function () {
      chain.balance = "9999999";

      const response = await post(message());

      // ACK deliberately: without a dead-letter topic a NACK would retry a condition that may never clear.
      expect(response.status).to.equal(204);
      expect(state()).to.equal(undefined);
      expect(failure()).to.include({ code: "INSUFFICIENT_BALANCE" });
    });

    it("does not reach the balance check when canonicality fails", async function () {
      chain.fundingReceipt = receipt({ blockNumber: FUNDING_BLOCK + 1 });
      chain.balance = "0";

      const response = await post(message());

      expect(failure()).to.include({ code: "NON_CANONICAL_TRANSFER" });
      expect(response.status).to.equal(204);
    });
  });

  describe("quote-api outcomes", function () {
    it("NACKs any other quote failure", async function () {
      quote.error = new Error("gateway timeout");

      const response = await post(message());

      expect(response.status).to.equal(500);
      expect(failure()).to.include({ code: "TRANSIENT_DEPENDENCY_FAILURE" });
    });

    it("NACKs a response whose derived address is not the funded one", async function () {
      quote.response = { depositAddress: "0x00000000000000000000000000000000000000ff" };

      const response = await post(message());

      expect(response.status).to.equal(500);
      expect(state()).to.equal(undefined);
      expect(failure()).to.include({ code: "INVALID_EXECUTE_RESPONSE" });
    });
  });

  describe("routing", function () {
    // NACK, not ACK. The chain may be re-enabled and the funds are still on the deposit address, so ACKing
    // would destroy the only delivery that could ever sweep them — the polling bot skipped and revisited.
    it("NACKs an origin chain that is not enabled", async function () {
      const otherChain = message({
        erc20Transfer: { ...(message().erc20Transfer as object), chainId: String(CHAIN_IDs.BASE) },
      });

      const response = await post(otherChain);

      expect(response.status).to.equal(500);
      expect(state()).to.equal(undefined);
      expect(failure()).to.include({ code: "ORIGIN_CHAIN_DISABLED" });
    });

    // A chain family with no v3 path is a property of the code, so no redelivery can change it.
    it("ACKs an origin chain whose family has no v3 execute path", async function () {
      const svm = message({
        erc20Transfer: { ...(message().erc20Transfer as object), chainId: String(CHAIN_IDs.SOLANA) },
      });

      const response = await post(svm);

      expect(response.status).to.equal(204);
      expect(failure()).to.include({ code: "UNSUPPORTED_CHAIN_FAMILY" });
    });

    // Rejected at the schema, before any provider lookup: `Number("bogus")` is NaN, which would otherwise
    // reach getProvider(NaN) as an unrecognised throw — alerting *and* retried forever — and would corrupt
    // the transferId into "NaN:<hash>:<logIndex>", colliding two malformed messages onto one lock.
    it("ACKs a payload whose chainId is not numeric", async function () {
      const bogus = message({
        erc20Transfer: { ...(message().erc20Transfer as object), chainId: "bogus" },
      });

      const response = await post(bogus);

      expect(response.status).to.equal(204);
      expect(failure()).to.include({ code: "MESSAGE_VALIDATION_FAILED" });
      expect(redisStore.size).to.equal(0);
    });
  });

  describe("the v3 refund withdrawal", function () {
    function misRoute(over: Record<string, unknown> = {}): Record<string, unknown> {
      return message({
        erc20Transfer: { ...(message().erc20Transfer as object), transferClassification: "mis_route" },
        ...over,
      });
    }

    beforeEach(function () {
      // Withdraw transactions carry no provenance event — only executes do — so the default receipt here has
      // no metadata topic, and the tests assert that never produces a warning. It does carry the settlement
      // log the lifecycle announcement is built from, as a real refund's receipt would.
      chain.executeReceipt = receipt({
        blockNumber: FUNDING_BLOCK + 10,
        transactionHash: EXECUTE_HASH,
        logs: [settlementLog()] as never,
      });
    });

    it("refunds a mis_route, records withdraw_executed and ACKs", async function () {
      const response = await post(misRoute());

      expect(response.status).to.equal(204);
      expect(state()).to.deep.include({
        status: "withdraw_executed",
        txHash: EXECUTE_HASH,
        chainId: ARBITRUM,
        blockNumber: FUNDING_BLOCK + 10,
      });
      expect(redisStore.has(LOCK_KEY)).to.equal(false);
      expect(lastLine()).to.include({ outcome: "withdraw_executed" });
    });

    // An expired intent refunds to the deposit address itself — the SpokePool depositor of record — so it
    // needs the same second hop out to the committed refund address as a mis_route. Diverted by exclusion,
    // so it cannot fall through to the deposit path.
    it("refunds an intent_refund through the same withdraw path", async function () {
      const intentRefund = message({
        erc20Transfer: { ...(message().erc20Transfer as object), transferClassification: "intent_refund" },
      });

      const response = await post(intentRefund);

      expect(response.status).to.equal(204);
      expect(state()).to.include({ status: "withdraw_executed", txHash: EXECUTE_HASH });
      expect(withdraw.requests).to.have.length(1);
      // It is a withdrawal, so it is announced like one — the announcement follows the settled refund, not
      // the classification that produced it.
      expect(lifecycle.published).to.have.length(1);
    });

    it("relays the funding context and deducts gas from the refund", async function () {
      await post(misRoute());

      expect(withdraw.requests).to.have.length(1);
      // The refund chain is erc20Transfer.chainId — where the funds landed — and the amount, token and user
      // are the funded ones. `deductGasFromRefund: true` is deliberate and differs from v1's full refund.
      expect(withdraw.requests[0]).to.deep.include({
        chainId: ARBITRUM,
        depositAddress: DEPOSIT_ADDRESS,
        token: USDC,
        amount: AMOUNT,
        user: (message().refundAddress as { address: string }).address,
        proof: WITHDRAW_LEAF.merkleProof,
        withdrawImplementation: WITHDRAW_LEAF.implementationAddress,
        deductGasFromRefund: true,
      });
    });

    // A confirmed withdraw never carries the MetadataEmitted event, so warning about its absence — as the
    // deposit path must — would fire on every successful refund.
    it("does not warn about missing provenance metadata on a confirmed withdraw", async function () {
      const response = await post(misRoute());

      expect(response.status).to.equal(204);
      expect(logs.some((l) => l.level === "warn")).to.equal(false);
      expect(lastLine()).to.not.have.property("metadataEmitted");
    });

    it("falls through to the withdraw when the execute endpoint rejects the amount as below minimum", async function () {
      quote.error = new AcrossApiHttpError(422, "amount below minimum", "AMOUNT_BELOW_MINIMUM");

      const response = await post(message());

      expect(response.status).to.equal(204);
      expect(state()).to.include({ status: "withdraw_executed", txHash: EXECUTE_HASH });
    });

    // The review focus: one lock held across both actions. The fake API records the lock value it observed
    // inside each call — a release between the execute rejection and the withdraw would show up here as a
    // missing or different token, invisible to the state assertions alone.
    it("holds the same lock across the execute rejection and the withdraw", async function () {
      quote.error = new AcrossApiHttpError(422, "amount below minimum", "AMOUNT_BELOW_MINIMUM");

      await post(message());

      expect(lockSeen.atExecute, "execute ran without the lock").to.not.equal(undefined);
      expect(lockSeen.atSignWithdraw, "sign-withdraw ran without the lock").to.not.equal(undefined);
      expect(lockSeen.atSignWithdraw).to.equal(lockSeen.atExecute);
    });

    // Only the AMOUNT_BELOW_MINIMUM code falls through — any other 422 from /execute stays a NACK, since
    // nothing says a refund is the right handling for it.
    it("does not fall through on a 422 with a different code", async function () {
      quote.error = new AcrossApiHttpError(422, "unprocessable", "SOMETHING_ELSE");

      const response = await post(message());

      expect(response.status).to.equal(500);
      expect(withdraw.requests).to.have.length(0);
      expect(failure()).to.include({ code: "TRANSIENT_DEPENDENCY_FAILURE" });
    });

    it("NACKs while v3 withdrawals are disabled", async function () {
      server.close();
      await startServer({});

      const response = await post(misRoute());

      // NACK: the gate is an operator switch and the funds are still on the deposit address, so an ACK
      // would discard the only delivery that could ever refund them.
      expect(response.status).to.equal(500);
      expect(state()).to.equal(undefined);
      expect(withdraw.requests).to.have.length(0);
      expect(failure()).to.include({ code: "V3_WITHDRAWALS_DISABLED" });
    });

    // Stricter than the deposit path: withdrawals are EVM-only, so even a namespace the deposit path would
    // accept as chain-native has no route here. Deterministic, so ACK.
    it("ACKs a non-EVM refund namespace", async function () {
      const tron = misRoute({ refundAddress: { namespace: "tron", address: "TQ5NMqJjW8sSjhWkrGheJHnWvpJPMdKMzn" } });

      const response = await post(tron);

      expect(response.status).to.equal(204);
      expect(state()).to.equal(undefined);
      expect(failure()).to.include({ code: "UNSUPPORTED_NAMESPACE" });
    });

    it("ACKs a message carrying no withdraw leaf", async function () {
      const response = await post(misRoute({ counterfactualMaterials: [] }));

      expect(response.status).to.equal(204);
      expect(state()).to.equal(undefined);
      expect(failure()).to.include({ code: "MISSING_WITHDRAW_MATERIALS" });
    });

    // Same order as the deposit path, for the same reason: only canonicality can tell "this funding
    // transfer is real" from "there happens to be money at this address".
    it("does not reach the balance check when canonicality fails", async function () {
      chain.fundingReceipt = receipt({ blockNumber: FUNDING_BLOCK + 1 });
      chain.balance = "0";

      const response = await post(misRoute());

      expect(response.status).to.equal(204);
      expect(failure()).to.include({ code: "NON_CANONICAL_TRANSFER" });
    });

    it("NACKs when the funding transaction is not yet visible", async function () {
      chain.fundingReceipt = null;

      const response = await post(misRoute());

      expect(response.status).to.equal(500);
      expect(failure()).to.include({ code: "TRANSIENT_DEPENDENCY_FAILURE" });
    });

    it("ACKs and writes no state when the balance is short", async function () {
      chain.balance = "9999999";

      const response = await post(misRoute());

      expect(response.status).to.equal(204);
      expect(state()).to.equal(undefined);
      expect(failure()).to.include({ code: "INSUFFICIENT_BALANCE" });
    });

    describe("the sign-withdraw response decides on the HTTP status alone", function () {
      it("records withdraw_failed and ACKs on a terminal 422", async function () {
        withdraw.error = new AcrossApiHttpError(422, "gas exceeds refund");

        const response = await post(misRoute());

        expect(response.status).to.equal(204);
        // No `code`: the client posts through `_postOrThrow`, which discards the API's discriminator.
        expect(state()).to.include({ status: "withdraw_failed", reason: "gas exceeds refund" });
        expect(state()).to.not.have.property("code");
        expect(lastLine()).to.include({ outcome: "withdraw_failed" });
      });

      it("NACKs any non-422 failure without writing state", async function () {
        for (const error of [new Error("gateway timeout"), new AcrossApiHttpError(500, "upstream error")]) {
          withdraw.error = error;

          const response = await post(misRoute());

          expect(response.status, error.message).to.equal(500);
          expect(state(), error.message).to.equal(undefined);
          expect(failure()).to.include({ code: "TRANSIENT_DEPENDENCY_FAILURE" });
        }
      });

      it("ACKs a redelivery after withdraw_failed without calling the API again", async function () {
        redisStore.set(
          STATE_KEY,
          JSON.stringify({ status: "withdraw_failed", reason: "gas exceeds refund", recordedAtMs: 1_700_000_000_000 })
        );

        const response = await post(misRoute());

        expect(response.status).to.equal(204);
        expect(withdraw.requests).to.have.length(0);
        expect(lastLine()).to.include({ outcome: "already_withdraw_failed" });
      });
    });

    it("NACKs a response signed for a different chain than the refund chain", async function () {
      withdraw.response = {
        signedWithdrawTx: {
          ecosystem: "evm",
          chainId: CHAIN_IDs.BASE,
          to: "0x0000000000000000000000000000000000000ca1",
          data: "0xfeedface",
          value: "0",
        },
      };

      const response = await post(misRoute());

      expect(response.status).to.equal(500);
      expect(state()).to.equal(undefined);
      expect(failure()).to.include({ code: "INVALID_WITHDRAW_RESPONSE" });
    });

    it("records broadcast_pending with the withdraw operation before the confirmation wait", async function () {
      chain.executeReceipt = null;

      const response = await post(misRoute());

      expect(response.status).to.equal(500);
      expect(state()).to.deep.include({
        status: "broadcast_pending",
        operation: "withdraw",
        txHash: EXECUTE_HASH,
        chainId: ARBITRUM,
      });
    });

    it("resolves a pending withdraw on redelivery instead of re-signing", async function () {
      redisStore.set(
        STATE_KEY,
        JSON.stringify({
          status: "broadcast_pending",
          operation: "withdraw",
          txHash: EXECUTE_HASH,
          chainId: ARBITRUM,
          submittedAtMs: 1_700_000_000_000,
        })
      );

      const response = await post(misRoute());

      expect(response.status).to.equal(204);
      expect(state()).to.include({ status: "withdraw_executed", txHash: EXECUTE_HASH });
      expect(withdraw.requests).to.have.length(0);
    });

    /**
     * A withdrawal leaves no on-chain provenance event, so the Pub/Sub announcement is the only way the
     * indexer learns it settled — which is why a dropped one is retried rather than logged and forgotten, as
     * the polling bot does. Every case here asserts both halves: what was announced, and what the state record
     * says was announced.
     */
    describe("the lifecycle announcement", function () {
      /** Seeds a settled withdrawal, optionally already announced. */
      function settled(over: Record<string, unknown> = {}): void {
        redisStore.set(
          STATE_KEY,
          JSON.stringify({
            status: "withdraw_executed",
            txHash: EXECUTE_HASH,
            chainId: ARBITRUM,
            blockNumber: FUNDING_BLOCK + 10,
            completedAtMs: 1_700_000_000_000,
            ...over,
          })
        );
      }

      it("announces the settled withdrawal and records that it did", async function () {
        const response = await post(misRoute());

        expect(response.status).to.equal(204);
        expect(lifecycle.published).to.have.length(1);
        expect(lifecycle.published[0].topic).to.equal(LIFECYCLE_TOPIC);
        // The envelope is locked by the indexer consumer, which keys on `type` and validates `data`. The
        // logIndex is the settlement log's, which is why the receipt has to be read rather than the record.
        expect(lifecycle.published[0].payload).to.deep.equal({
          type: "withdraw_executed",
          data: {
            chainId: ARBITRUM,
            blockNumber: FUNDING_BLOCK + 10,
            txHash: EXECUTE_HASH,
            logIndex: SETTLEMENT_LOG_INDEX,
            erc20Transfer: {
              chainId: ARBITRUM,
              blockNumber: FUNDING_BLOCK,
              txHash: FUNDING_TX,
              logIndex: 7,
            },
          },
        });
        expect(state()).to.have.property("withdrawLifecyclePublishedAt").that.is.a("number");
        expect(lastLine()).to.include({ withdrawLifecyclePublished: true, lifecycleMessageId: LIFECYCLE_MESSAGE_ID });
      });

      // The point of the whole change. A dropped announcement must survive as work still owed, which means
      // the timestamp is written only *after* the publish returns — the reverse order would discard the
      // evidence that it never happened.
      it("preserves the unannounced withdrawal and NACKs when the publish fails", async function () {
        lifecycle.error = new Error("Total timeout of API google.pubsub.v1.Publisher exceeded");

        const response = await post(misRoute());

        expect(response.status).to.equal(500);
        expect(state()).to.include({ status: "withdraw_executed", txHash: EXECUTE_HASH });
        expect(state()).to.not.have.property("withdrawLifecyclePublishedAt");
        expect(failure()).to.include({ code: "WITHDRAW_PUBLICATION_FAILED" });
      });

      // Retries the announcement and *only* the announcement: the funds already moved, so re-signing or
      // re-broadcasting would be the double-sweep this service exists to prevent.
      it("announces on redelivery without re-withdrawing", async function () {
        settled();

        const response = await post(misRoute());

        expect(response.status).to.equal(204);
        expect(lifecycle.published).to.have.length(1);
        expect(withdraw.requests).to.have.length(0);
        expect(state()).to.have.property("withdrawLifecyclePublishedAt").that.is.a("number");
        // Taken and given back: the announcement runs under the transfer's lock, like everything else.
        expect(redisStore.has(LOCK_KEY)).to.equal(false);
        expect(lastLine()).to.include({ outcome: "already_withdraw_executed" });
      });

      // The other way a withdrawal reaches `withdraw_executed`: an earlier request broadcast it and died
      // before the receipt landed. This delivery is the one that resolves the record — and it ACKs, so it is
      // also the last one that could ever announce it.
      it("announces a withdrawal it resolved from a pending record", async function () {
        redisStore.set(
          STATE_KEY,
          JSON.stringify({
            status: "broadcast_pending",
            operation: "withdraw",
            txHash: EXECUTE_HASH,
            chainId: ARBITRUM,
            submittedAtMs: 1_700_000_000_000,
          })
        );

        const response = await post(misRoute());

        expect(response.status).to.equal(204);
        expect(lifecycle.published).to.have.length(1);
        expect(state()).to.have.property("withdrawLifecyclePublishedAt").that.is.a("number");
        expect(withdraw.requests).to.have.length(0);
      });

      // A `correct_transfer` the execute endpoint rejected below the minimum was refunded too, so recovery
      // has to key on the recorded state rather than on the message's classification.
      it("announces a below-minimum refund's withdrawal, not just a mis_route's", async function () {
        settled();

        const response = await post(message());

        expect(response.status).to.equal(204);
        expect(lifecycle.published).to.have.length(1);
        expect(withdraw.requests).to.have.length(0);
      });

      it("ACKs a redelivery of an already-announced withdrawal without announcing again", async function () {
        settled({ withdrawLifecyclePublishedAt: 1_700_000_001_000 });
        // Would fail every guard if any path beyond the short-circuit were re-entered.
        chain.fundingReceipt = null;
        chain.balance = "0";

        const response = await post(misRoute());

        expect(response.status).to.equal(204);
        expect(lifecycle.published).to.have.length(0);
        expect(withdraw.requests).to.have.length(0);
      });

      // The funds moved correctly and no redelivery can conjure a log that is not in the receipt, so this
      // acknowledges. It stays unstamped: the timestamp means "announced", and claiming one here would be a
      // lie, where repeating the warning is merely noise.
      it("warns and ACKs when the receipt carries no settlement log", async function () {
        chain.executeReceipt = receipt({
          blockNumber: FUNDING_BLOCK + 10,
          transactionHash: EXECUTE_HASH,
          logs: [settlementLog({ topics: [TRANSFER_TOPIC] })] as never,
        });

        const response = await post(misRoute());

        expect(response.status).to.equal(204);
        expect(lifecycle.published).to.have.length(0);
        expect(state()).to.not.have.property("withdrawLifecyclePublishedAt");
        expect(logs.some((l) => l.level === "warn")).to.equal(true);
      });

      // Announcing something Redis does not hold would tell the indexer a refund is done while every later
      // delivery still believes it is owed one.
      it("announces nothing when the terminal write itself failed", async function () {
        // set #1 = broadcast_pending from the hook, #2 = the terminal write.
        redisFaults.failSetCalls = [2];

        const response = await post(misRoute());

        expect(response.status).to.equal(500);
        expect(lifecycle.published).to.have.length(0);
      });

      // With the gate off nothing is announced and nothing claims to have been, so turning it on later lets a
      // redelivery finish the job.
      it("records no announcement when no publisher is configured", async function () {
        server.close();
        await startServer({ ENABLE_V3_WITHDRAWALS: "true" }, false);

        expect((await post(misRoute())).status).to.equal(204);
        expect(state()).to.include({ status: "withdraw_executed" });
        expect(state()).to.not.have.property("withdrawLifecyclePublishedAt");

        // And the terminal short-circuit still ACKs it rather than taking the lock every time.
        expect((await post(misRoute())).status).to.equal(204);
        expect(lastLine()).to.include({ outcome: "already_withdraw_executed" });
      });

      it("never announces a deposit, whose provenance the indexer reads on-chain", async function () {
        redisStore.set(
          STATE_KEY,
          JSON.stringify({
            status: "deposit_executed",
            txHash: EXECUTE_HASH,
            chainId: ARBITRUM,
            blockNumber: FUNDING_BLOCK + 10,
            completedAtMs: 1_700_000_000_000,
          })
        );

        expect((await post(message())).status).to.equal(204);
        expect(lifecycle.published).to.have.length(0);
      });
    });
  });
});
