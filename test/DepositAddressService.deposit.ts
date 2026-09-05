import { AddressInfo } from "net";
import { Server } from "http";
import { expect, winston } from "./utils";
import { AcrossApiHttpError } from "../src/clients/AcrossApiBaseClient";
import { AcrossSwapApiClient, DepositAddressExecuteResponse } from "../src/clients/AcrossSwapApiClient";
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
import { createApp } from "../src/deposit-address-service/app";
import { DepositAddressServiceConfig } from "../src/deposit-address-service/config";
import { createDepositHandler } from "../src/deposit-address-service/depositHandler";
import { RequestLifecycle } from "../src/deposit-address-service/lifecycle";
import { TransferStore, TransferStoreRedis } from "../src/deposit-address-service/transferState";

/**
 * The v3 deposit execute path over the real Express boundary and the real store, with only the chain, the
 * quote-api and the submission client faked. Every case below is a failure point from the plan's verification
 * list, and each asserts the **queue disposition** as well as the state left in Redis, because those two
 * together are what stop a transfer being swept twice.
 */
describe("DepositAddressService v3 deposit execution", function () {
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
      counterfactualMaterials: [],
      depositAddressNamespace: "evm",
      refundAddress: { namespace: "evm", address: "0x9A6e5F1B8C7D0E3a2b4c5D6e7F8A9b0c1D2E3f40" },
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
    } as unknown as AcrossSwapApiClient;
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

    const baseSigner = Wallet.createRandom();
    signerAddress = await baseSigner.getAddress();

    const logger = recordingLogger();
    const config = new DepositAddressServiceConfig({
      EXECUTION_ENABLED: "true",
      RELAYER_ORIGIN_CHAINS: `[${ARBITRUM}]`,
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
  });

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
    it("NACKs a below-minimum rejection until the withdraw fallback exists", async function () {
      quote.error = new AcrossApiHttpError("amount below minimum", 422, "AMOUNT_BELOW_MINIMUM");

      const response = await post(message());

      expect(response.status).to.equal(500);
      expect(state()).to.equal(undefined);
      expect(failure()).to.include({ code: "AMOUNT_BELOW_MINIMUM" });
    });

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
    it("NACKs a mis_route until the withdraw path exists", async function () {
      const misRoute = message({
        erc20Transfer: { ...(message().erc20Transfer as object), transferClassification: "mis_route" },
      });

      const response = await post(misRoute);

      expect(response.status).to.equal(500);
      expect(state()).to.equal(undefined);
      expect(failure()).to.include({ code: "WITHDRAW_ROUTE_NOT_IMPLEMENTED" });
    });

    // NACK, not ACK. The chain may be re-enabled and the funds are still on the deposit address, so ACKing
    // would destroy the only delivery that could ever sweep them — the polling bot skipped and revisited.
    // An expired intent refunds to the deposit address itself, so it needs the same second hop as a
    // mis_route. Diverted by exclusion, so it cannot fall through to the deposit path.
    it("NACKs an intent_refund until the withdraw path exists", async function () {
      const intentRefund = message({
        erc20Transfer: { ...(message().erc20Transfer as object), transferClassification: "intent_refund" },
      });

      const response = await post(intentRefund);

      expect(response.status).to.equal(500);
      expect(state()).to.equal(undefined);
      expect(failure()).to.include({ code: "WITHDRAW_ROUTE_NOT_IMPLEMENTED" });
    });

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
});
