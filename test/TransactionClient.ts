import { AugmentedTransaction } from "../src/clients";
import {
  BigNumber,
  CHAIN_IDs,
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
    function makeEthersError(code: string, extra: Record<string, unknown> = {}): Error {
      return Object.assign(new Error(code), { code, reason: code, ...extra });
    }

    function makeConfirmationTxn(chainId: number, provider?: ethers.providers.Provider): AugmentedTransaction {
      return {
        chainId,
        contract: { address, signer, provider } as Contract,
        method,
        args: [],
        message: "",
        mrkdwn: "",
        ensureConfirmation: true,
      };
    }

    it("Confirms transaction receipt on success", async function () {
      // The wait must be bounded, with a longer timeout on mainnet.
      for (const [chainId, expectedTimeout] of [
        [chainIds[0], 6_000],
        [CHAIN_IDs.MAINNET, 24_000],
      ]) {
        let waitCalls = 0;
        let waitTimeout: number | undefined;
        txnClient.waitOverride = (_confirmations, timeout) => {
          ++waitCalls;
          waitTimeout = timeout;
          return Promise.resolve({ status: 1 } as TransactionReceipt);
        };

        const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
        expect(txnResponses.length).to.equal(1);
        expect(waitCalls).to.equal(1);
        expect(waitTimeout).to.equal(expectedTimeout);
      }
    });

    it("Throws on CALL_EXCEPTION", async function () {
      const chainId = chainIds[0];
      txnClient.waitOverride = (_confirmations, _timeout) => {
        return Promise.reject(makeEthersError(ethers.errors.CALL_EXCEPTION));
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(0);
    });

    it("Resubmits on TRANSACTION_REPLACED", async function () {
      const chainId = chainIds[0];
      let waitCalls = 0;
      txnClient.waitOverride = (_confirmations, _timeout) => {
        if (++waitCalls === 1) {
          return Promise.reject(makeEthersError(ethers.errors.TRANSACTION_REPLACED));
        }
        return Promise.resolve({ status: 1 } as TransactionReceipt);
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(1);
      // First call rejected with TRANSACTION_REPLACED, _submit recursed, second call succeeded.
      expect(waitCalls).to.equal(2);
    });

    it("Resubmits on confirmation timeout", async function () {
      const chainId = chainIds[0];
      // Seed the nonce cache so a pinned resubmission (nonce 42) is distinguishable from a
      // re-synced one (the mock defaults to nonce 1).
      const nonce = 42;
      txnClient.noncesBySigner[chainId] = { [await signer.getAddress()]: nonce - 1 };

      let waitCalls = 0;
      txnClient.waitOverride = (_confirmations, _timeout) => {
        if (++waitCalls === 1) {
          return Promise.reject(makeEthersError(ethers.errors.TIMEOUT));
        }
        return Promise.resolve({ status: 1 } as TransactionReceipt);
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(1);
      // First wait timed out, _submit resubmitted, second wait succeeded.
      expect(waitCalls).to.equal(2);
      // The resubmission must pin the original nonce in order to replace the stuck transaction.
      expect(txnResponses[0].nonce).to.equal(nonce);
    });

    it("Adopts a repriced replacement instead of resubmitting", async function () {
      const chainId = chainIds[0];
      const replacement = { hash: ethers.utils.id("repriced"), nonce: 1 } as TransactionResponse;
      let waitCalls = 0;
      txnClient.waitOverride = (_confirmations, _timeout) => {
        return Promise.reject(
          ++waitCalls === 1
            ? makeEthersError(ethers.errors.TIMEOUT)
            : makeEthersError(ethers.errors.TRANSACTION_REPLACED, {
                reason: "repriced",
                receipt: { status: 1, blockNumber: 100 } as TransactionReceipt,
                replacement,
              })
        );
      };

      // The original wins the race against its own timeout resubmission; the mined transaction
      // carries identical calldata, so it is adopted rather than resubmitted at a new nonce.
      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(1);
      expect(txnResponses[0].hash).to.equal(replacement.hash);
      expect(waitCalls).to.equal(2);
    });

    it("Gives up after timeout resubmissions exhausted", async function () {
      const chainId = chainIds[0];
      let waitCalls = 0;
      txnClient.waitOverride = (_confirmations, _timeout) => {
        ++waitCalls;
        return Promise.reject(makeEthersError(ethers.errors.TIMEOUT));
      };

      // Confirmation failure is alerted via error-level log; the response is still returned.
      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(1);
      // Initial submission + one resubmission per remaining maxTries (default is 10).
      expect(waitCalls).to.equal(11);
    });

    it("Retries on transient error then succeeds", async function () {
      const chainId = chainIds[0];
      let waitCalls = 0;
      txnClient.waitOverride = (_confirmations, _timeout) => {
        if (++waitCalls === 1) {
          return Promise.reject(makeEthersError(ethers.errors.SERVER_ERROR));
        }
        return Promise.resolve({ status: 1 } as TransactionReceipt);
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(1);
      expect(waitCalls).to.equal(2);
    });

    it("Gives up after maxTries exhausted", async function () {
      const chainId = chainIds[0];
      let waitCalls = 0;
      txnClient.waitOverride = (_confirmations, _timeout) => {
        ++waitCalls;
        return Promise.reject(makeEthersError(ethers.errors.SERVER_ERROR));
      };

      // Confirmation failure is alerted via error-level log; the response is still returned.
      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(1);
      // wait() was called maxTries times (default is 10).
      expect(waitCalls).to.equal(10);
    });

    // Responses without the two-arg wait() implementation (i.e. the TVM shim) fall back to a
    // hash-blind provider.waitForTransaction(), which resolves reverted receipts without throwing.
    it("Falls back to waitForTransaction without a two-arg wait", async function () {
      const chainId = chainIds[0];
      txnClient.waitOverride = (_confirmations) => Promise.reject(new Error("wait() must not be used"));

      for (const status of [1, 0]) {
        let waitCalls = 0;
        const provider = {
          waitForTransaction: (hash: string, _confirmations?: number, _timeout?: number) => {
            ++waitCalls;
            return Promise.resolve({ status, transactionHash: hash } as TransactionReceipt);
          },
        } as unknown as ethers.providers.Provider;

        const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId, provider)]);
        expect(txnResponses.length).to.equal(status === 1 ? 1 : 0); // Reverted receipts throw.
        expect(waitCalls).to.equal(1);
      }
    });
  });
});
