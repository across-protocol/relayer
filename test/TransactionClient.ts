import { AugmentedTransaction } from "../src/clients";
import {
  BigNumber,
  ethers,
  isDefined,
  TransactionReceipt,
  TransactionResponse,
  TransactionSimulationResult,
} from "../src/utils";
import { CHAIN_ID_TEST_LIST as chainIds } from "./constants";
import { MockedTransactionClient, txnClientPassResult } from "./mocks/MockTransactionClient";
import { createSpyLogger, Contract, expect, randomAddress, toBN, winston, ethers as testEthers } from "./utils";

const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
const address = randomAddress(); // Test contract address
const method = "testMethod";
let txnClient: MockedTransactionClient;
let signer;

describe("TransactionClient", function () {
  beforeEach(async function () {
    txnClient = new MockedTransactionClient(spyLogger);
    [signer] = await testEthers.getSigners();
  });

  it("Correctly excludes simulation failures", async function () {
    for (const result of ["Forced simulation failure", txnClientPassResult]) {
      const fail = result !== txnClientPassResult;
      const txns: AugmentedTransaction[] = chainIds.map((_chainId) => {
        const chainId = Number(_chainId);
        return {
          chainId: chainId,
          contract: { address },
          args: [{ result }],
          message: `Test transaction on chain ${chainId}`,
          mrkdwn: `This transaction is expected to ${fail ? "fail" : "pass"} simulation.`,
        } as AugmentedTransaction;
      });

      expect(txns.length).to.equal(chainIds.length);
      const results: TransactionSimulationResult[] = await txnClient.simulate(txns);
      expect(results.length).to.equal(txns.length);

      // Verify that the failed simulations were filtered out.
      expect(results.filter((txn) => txn.succeed).length).to.equal(fail ? 0 : txns.length);
      expect(results.filter((txn) => !txn.succeed).length).to.equal(fail ? txns.length : 0);
    }
  });

  it("Handles submission success & failure", async function () {
    const chainId = chainIds[0];

    const nTxns = 4;
    const txns: AugmentedTransaction[] = [];
    for (const result of [txnClientPassResult, "Forced submission failure", txnClientPassResult]) {
      const txn: AugmentedTransaction = {
        chainId,
        contract: { address, signer } as Contract,
        method,
        args: [{ result }],
        value: toBN(0),
        mrkdwn: `Sample markdown string for chain ${chainId} transaction`,
      } as AugmentedTransaction;

      for (let nTxn = 1; nTxn <= nTxns; ++nTxn) {
        const message = `Test transaction (${nTxn}/${nTxns}) on chain ${chainId}`;
        txns.push({ ...txn, message } as AugmentedTransaction);
      }
    }

    // Should have 4 txn responses before the first bad transaction.
    let txnResponses: TransactionResponse[];
    txnResponses = await txnClient.submit(chainId, txns);
    expect(txnResponses.length).to.equal(nTxns);

    // Skip over the bad txns in the middle; all should pass.
    txnResponses = await txnClient.submit(chainId, txns.slice(0, nTxns).concat(txns.slice(-nTxns)));
    expect(txnResponses.length).to.equal(2 * nTxns);

    // The bad txns in the middle should exclusively fail.
    txnResponses = await txnClient.submit(chainId, txns.slice(nTxns, nTxns + nTxns));
    expect(txnResponses.length).to.equal(0);
  });

  it("Validates that successive transactions increment their nonce", async function () {
    const chainId = chainIds[0];

    const nTxns = 10;
    const txns: AugmentedTransaction[] = [];
    for (let txn = 1; txn <= nTxns; ++txn) {
      const txnRequest: AugmentedTransaction = {
        chainId,
        contract: { address, signer } as Contract,
        method,
        args: [],
        message: "",
        mrkdwn: "",
      };
      txns.push(txnRequest);
    }

    const txnResponses: TransactionResponse[] = await txnClient.submit(chainId, txns);
    let nonce = txnResponses[0].nonce;
    txnResponses.slice(1).forEach((txnResponse) => expect(txnResponse.nonce).to.equal(++nonce));
  });

  it("Transaction simulation result includes gasLimit", async function () {
    const chainId = chainIds[0];

    const nTxns = 10;
    const txns: AugmentedTransaction[] = [];
    for (let txn = 1; txn <= nTxns; ++txn) {
      const txnRequest: AugmentedTransaction = {
        chainId,
        contract: { address, signer } as Contract,
        method,
        args: [],
        message: "",
        mrkdwn: "",
      };
      txns.push(txnRequest);
    }
    const simResults = await txnClient.simulate([txns[0]]);
    const gasLimit = simResults[0]?.transaction?.gasLimit;
    expect(isDefined(gasLimit)).to.be.true;
    expect((gasLimit as BigNumber).gt(0)).to.be.true;
  });

  it("Transaction submission applies gasLimitMultiplier", async function () {
    const chainId = chainIds[0];
    const gasLimit = txnClient.randomGasLimit();

    const nTxns = 10;
    const txns: AugmentedTransaction[] = [];
    for (let txn = 1; txn <= nTxns; ++txn) {
      const txnRequest: AugmentedTransaction = {
        chainId,
        contract: { address, signer } as Contract,
        method,
        args: [],
        gasLimit,
        gasLimitMultiplier: txn, // number
        message: "",
        mrkdwn: "",
      };
      txns.push(txnRequest);
    }

    const txnResponses = await txnClient.submit(chainId, txns);
    txnResponses.forEach((txnResponse, idx) => {
      expect(txnResponse.gasLimit).to.equal(gasLimit.mul(idx + 1));
    });
  });

  describe("ensureConfirmation", function () {
    // The subset of Provider consumed by the confirmation loop.
    type MockProvider = Partial<Pick<ethers.providers.Provider, "getBlockNumber" | "getTransactionCount">>;

    function makeEthersError(code: string, extra: Record<string, unknown> = {}): Error {
      return Object.assign(new Error(code), { code, reason: code, ...extra });
    }

    function makeConfirmationTxn(chainId: number, provider?: MockProvider): AugmentedTransaction {
      return {
        chainId,
        // A static block number satisfies the confirmation baseline; timeout tests override it.
        contract: {
          address,
          signer,
          provider: { getBlockNumber: () => Promise.resolve(100), ...provider },
        } as Contract,
        method,
        args: [],
        message: "",
        mrkdwn: "",
        ensureConfirmation: true,
      };
    }

    class CountingClient extends MockedTransactionClient {
      public submissions = 0;
      protected override _getTransactionPromise(
        txn: AugmentedTransaction,
        nonce: number | null
      ): Promise<TransactionResponse> {
        ++this.submissions;
        return super._getTransactionPromise(txn, nonce);
      }
    }

    it("Confirms transaction receipt on success", async function () {
      const chainId = chainIds[0];
      let waitCalls = 0;
      txnClient.waitOverride = () => {
        ++waitCalls;
        return Promise.resolve({} as TransactionReceipt);
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(1);
      expect(waitCalls).to.equal(1);
    });

    it("Throws on CALL_EXCEPTION", async function () {
      const chainId = chainIds[0];
      txnClient.waitOverride = () => {
        return Promise.reject(makeEthersError(ethers.errors.CALL_EXCEPTION));
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(0);
    });

    it("Resubmits on TRANSACTION_REPLACED", async function () {
      const chainId = chainIds[0];
      let waitCalls = 0;
      txnClient.waitOverride = () => {
        if (++waitCalls === 1) {
          return Promise.reject(makeEthersError(ethers.errors.TRANSACTION_REPLACED));
        }
        return Promise.resolve({} as TransactionReceipt);
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(1);
      // First call rejected with TRANSACTION_REPLACED, _submit recursed, second call succeeded.
      expect(waitCalls).to.equal(2);
    });

    it("Adopts a repriced replacement instead of resubmitting", async function () {
      const chainId = chainIds[0];
      const replacement = { hash: ethers.utils.id("repriced"), nonce: 1 } as TransactionResponse;
      txnClient.waitOverride = () => {
        return Promise.reject(
          makeEthersError(ethers.errors.TRANSACTION_REPLACED, {
            reason: "repriced",
            receipt: { status: 1, blockNumber: 100 } as TransactionReceipt,
            replacement,
          })
        );
      };

      // A mined transaction with identical calldata (i.e. our own raced resubmission) is adopted.
      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(1);
      expect(txnResponses[0].hash).to.equal(replacement.hash);
    });

    it("Resubmits on confirmation timeout", async function () {
      const chainId = chainIds[0];
      // Seed the nonce cache so a pinned resubmission (nonce 42) is distinguishable from a
      // re-synced one (the mock defaults to nonce 1).
      const nonce = 42;
      txnClient.noncesBySigner[chainId] = { [await signer.getAddress()]: nonce - 1 };
      let blockNumber = 100;
      const provider: MockProvider = {
        getBlockNumber: () => Promise.resolve((blockNumber += 2)), // Blocks are produced without inclusion.
        getTransactionCount: () => Promise.resolve(nonce),
      };

      let waitCalls = 0;
      txnClient.waitOverride = () => {
        if (++waitCalls === 1) {
          return Promise.reject(makeEthersError(ethers.errors.TIMEOUT));
        }
        return Promise.resolve({} as TransactionReceipt);
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId, provider)]);
      expect(txnResponses.length).to.equal(1);
      expect(waitCalls).to.equal(2);
      // The resubmission must pin the original nonce in order to replace the stuck transaction.
      expect(txnResponses[0].nonce).to.equal(nonce);
    });

    it("Tolerates transient RPC errors while confirming", async function () {
      const chainId = chainIds[0];
      const client = new CountingClient(spyLogger);

      // The baseline read and the first timeout probe fail transiently; neither must be
      // classified as a submission failure (the transaction is live).
      let [blockCalls, countCalls, waitCalls] = [0, 0, 0];
      let blockNumber = 100;
      const provider: MockProvider = {
        getBlockNumber: () =>
          ++blockCalls === 1 ? Promise.reject(new Error("rpc error")) : Promise.resolve((blockNumber += 2)),
        getTransactionCount: () => (++countCalls === 1 ? Promise.reject(new Error("rpc error")) : Promise.resolve(0)),
      };
      client.waitOverride = () => {
        return ++waitCalls <= 3
          ? Promise.reject(makeEthersError(ethers.errors.TIMEOUT))
          : Promise.resolve({} as TransactionReceipt);
      };

      const txnResponses = await client.submit(chainId, [makeConfirmationTxn(chainId, provider)]);
      expect(txnResponses.length).to.equal(1);
      // Failed baseline ⇒ baseline on the first successful probe, then one block-gate deferral,
      // then replacement.
      expect(client.submissions).to.equal(2);
      expect(waitCalls).to.equal(4);
    });

    it("Verifies the outcome when the nonce was consumed before replacement", async function () {
      const chainId = chainIds[0];
      const client = new CountingClient(spyLogger);
      const provider: MockProvider = { getTransactionCount: () => Promise.resolve(2) };
      let waitCalls = 0;
      client.waitOverride = () => {
        return ++waitCalls === 1
          ? Promise.reject(makeEthersError(ethers.errors.TIMEOUT))
          : Promise.resolve({} as TransactionReceipt);
      };

      // The original (mock nonce 1) was mined during the timeout; verify it, don't resubmit.
      const txnResponses = await client.submit(chainId, [makeConfirmationTxn(chainId, provider)]);
      expect(txnResponses.length).to.equal(1);
      expect(client.submissions).to.equal(1);
      expect(waitCalls).to.equal(2);
    });

    it("Defers replacement until blocks are produced", async function () {
      const chainId = chainIds[0];
      const client = new CountingClient(spyLogger);
      const provider: MockProvider = { getTransactionCount: () => Promise.resolve(0) };
      let waitCalls = 0;
      client.waitOverride = () => {
        return ++waitCalls <= 2
          ? Promise.reject(makeEthersError(ethers.errors.TIMEOUT))
          : Promise.resolve({} as TransactionReceipt);
      };

      // The static block number simulates a chain producing no blocks: timeouts alone must not
      // trigger replacement.
      const txnResponses = await client.submit(chainId, [makeConfirmationTxn(chainId, provider)]);
      expect(txnResponses.length).to.equal(1);
      expect(client.submissions).to.equal(1);
      expect(waitCalls).to.equal(3);
    });

    it("Gives up after timeout resubmissions exhausted", async function () {
      const chainId = chainIds[0];
      let blockNumber = 100;
      const provider: MockProvider = {
        getBlockNumber: () => Promise.resolve((blockNumber += 2)),
        getTransactionCount: () => Promise.resolve(0),
      };
      let waitCalls = 0;
      txnClient.waitOverride = () => {
        ++waitCalls;
        return Promise.reject(makeEthersError(ethers.errors.TIMEOUT));
      };

      // Confirmation failure is alerted via error-level log; the response is still returned.
      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId, provider)]);
      expect(txnResponses.length).to.equal(1);
      // Initial submission + one resubmission per remaining maxTries (default is 10).
      expect(waitCalls).to.equal(11);
    });

    it("Retries on transient error then succeeds", async function () {
      const chainId = chainIds[0];
      let waitCalls = 0;
      txnClient.waitOverride = () => {
        if (++waitCalls === 1) {
          return Promise.reject(makeEthersError(ethers.errors.SERVER_ERROR));
        }
        return Promise.resolve({} as TransactionReceipt);
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(1);
      expect(waitCalls).to.equal(2);
    });

    it("Gives up after maxTries exhausted", async function () {
      const chainId = chainIds[0];
      let waitCalls = 0;
      txnClient.waitOverride = () => {
        ++waitCalls;
        return Promise.reject(makeEthersError(ethers.errors.SERVER_ERROR));
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      // The transaction still returns because _submit returns txnPromise even when confirmation fails.
      expect(txnResponses.length).to.equal(1);
      // wait() was called maxTries times (default is 10).
      expect(waitCalls).to.equal(10);
    });

    it("Honours a caller-supplied maxTries", async function () {
      const chainId = chainIds[0];
      let waitCalls = 0;
      txnClient.waitOverride = () => {
        ++waitCalls;
        return Promise.reject(makeEthersError(ethers.errors.SERVER_ERROR));
      };

      // Callers working to a deadline need this: at the default the worst case is M(M+1)/2 waits, which on
      // mainnet's 24s cadence is ~22 minutes.
      await txnClient.submit(chainId, [{ ...makeConfirmationTxn(chainId), maxTries: 3 }]);
      expect(waitCalls).to.equal(3);
    });

    describe("onBroadcast", function () {
      it("Fires once the hash exists and before the confirmation wait", async function () {
        const chainId = chainIds[0];
        const order: string[] = [];
        txnClient.waitOverride = () => {
          order.push("wait");
          return Promise.resolve({} as TransactionReceipt);
        };

        const seen: TransactionResponse[] = [];
        await txnClient.submit(chainId, [
          {
            ...makeConfirmationTxn(chainId),
            onBroadcast: async (response) => {
              order.push("onBroadcast");
              seen.push(response);
            },
          },
        ]);

        // The ordering is the whole point: a caller recording only after the receipt has no record of a
        // transaction already on the wire.
        expect(order).to.deep.equal(["onBroadcast", "wait"]);
        expect(seen.length).to.equal(1);
        expect(isDefined(seen[0].hash)).to.equal(true);
      });

      it("Fires even without ensureConfirmation", async function () {
        const chainId = chainIds[0];
        let calls = 0;

        await txnClient.submit(chainId, [
          { ...makeConfirmationTxn(chainId), ensureConfirmation: false, onBroadcast: async () => void ++calls },
        ]);
        expect(calls).to.equal(1);
      });

      it("Re-notifies with the replacement hash when a transaction is repriced", async function () {
        const chainId = chainIds[0];
        const replacement = { hash: ethers.utils.id("repriced"), nonce: 1 } as TransactionResponse;
        txnClient.waitOverride = () =>
          Promise.reject(
            makeEthersError(ethers.errors.TRANSACTION_REPLACED, {
              reason: "repriced",
              receipt: { status: 1, blockNumber: 100 } as TransactionReceipt,
              replacement,
            })
          );

        const hashes: string[] = [];
        const txnResponses = await txnClient.submit(chainId, [
          { ...makeConfirmationTxn(chainId), onBroadcast: async (r) => void hashes.push(r.hash) },
        ]);

        // Only the replacement will ever have a receipt, so a caller left holding the original hash could not
        // resolve its record against the chain.
        expect(hashes.length).to.equal(2);
        expect(hashes[1]).to.equal(replacement.hash);
        expect(txnResponses[0].hash).to.equal(replacement.hash);
      });

      it("Re-notifies for the client's own resubmission", async function () {
        const chainId = chainIds[0];
        let waitCalls = 0;
        txnClient.waitOverride = () => {
          if (++waitCalls === 1) {
            return Promise.reject(makeEthersError(ethers.errors.TRANSACTION_REPLACED));
          }
          return Promise.resolve({} as TransactionReceipt);
        };

        let calls = 0;
        await txnClient.submit(chainId, [{ ...makeConfirmationTxn(chainId), onBroadcast: async () => void ++calls }]);

        // The resubmission recurses into _submit, which notifies from its own entry point.
        expect(calls).to.equal(2);
      });

      it("Swallows a failing hook and still confirms", async function () {
        const chainId = chainIds[0];
        let waitCalls = 0;
        txnClient.waitOverride = () => {
          ++waitCalls;
          return Promise.resolve({} as TransactionReceipt);
        };

        // The transaction is already on the wire, so losing the caller's record must not lose the transaction.
        const txnResponses = await txnClient.submit(chainId, [
          { ...makeConfirmationTxn(chainId), onBroadcast: () => Promise.reject(new Error("redis unavailable")) },
        ]);

        expect(txnResponses.length).to.equal(1);
        expect(waitCalls).to.equal(1);
      });
    });
  });
});
