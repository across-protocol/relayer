import { AugmentedTransaction } from "../src/clients";
import {
  BigNumber,
  ethers,
  isDefined,
  sendAndConfirmTransaction,
  TransactionReceipt,
  TransactionResponse,
  TransactionSimulationResult,
  TransactionSubmissionFailedError,
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

    function makeConfirmationTxn(chainId: number): AugmentedTransaction {
      return {
        chainId,
        contract: { address, signer } as Contract,
        method,
        args: [],
        message: "",
        mrkdwn: "",
        ensureConfirmation: true,
      };
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
  });

  describe("sendAndConfirmTransaction outcome typing", function () {
    function makeTxn(chainId: number, result: string): AugmentedTransaction {
      return {
        chainId,
        contract: { address, signer } as Contract,
        method,
        args: [{ result }],
        message: "",
        mrkdwn: "",
      };
    }

    it("Returns confirmed when simulation passes and wait resolves", async function () {
      const chainId = chainIds[0];
      txnClient.waitOverride = () => Promise.resolve({} as TransactionReceipt);

      const outcome = await sendAndConfirmTransaction(makeTxn(chainId, txnClientPassResult), txnClient);
      expect(outcome.status).to.equal("confirmed");
      if (outcome.status === "confirmed") {
        expect(outcome.receipt).to.exist;
      }
    });

    it("Returns simulation_failed (typed) when willSucceed rejects", async function () {
      const chainId = chainIds[0];
      const reason = "Forced simulation failure";

      const outcome = await sendAndConfirmTransaction(makeTxn(chainId, reason), txnClient);
      expect(outcome.status).to.equal("simulation_failed");
      if (outcome.status === "simulation_failed") {
        expect(outcome.reason).to.equal(reason);
      }
    });

    it("Returns submission_failed (typed) when on-chain submit returns empty", async function () {
      const chainId = chainIds[0];
      // Pass simulation, fail submit by making _getTransactionPromise reject. Then submit() in
      // TransactionClient catches and returns []; submitTransaction wraps that as the typed
      // submission failure error which sendAndConfirmTransaction converts to the tagged outcome.
      const failing: AugmentedTransaction = makeTxn(chainId, "force submit failure");
      // First simulate must pass so willSucceed reports succeed=true. Override _simulate via
      // a small lie: stub the mock to pass simulation but still reject the underlying tx.
      const original = txnClient["_simulate"].bind(txnClient);
      (txnClient as unknown as { _simulate: typeof original })._simulate = async (txn) => ({
        transaction: { ...txn, gasLimit: txnClient.randomGasLimit() },
        succeed: true,
      });
      try {
        const outcome = await sendAndConfirmTransaction(failing, txnClient);
        expect(outcome.status).to.equal("submission_failed");
        if (outcome.status === "submission_failed") {
          expect(outcome.error).to.be.instanceOf(TransactionSubmissionFailedError);
        }
      } finally {
        (txnClient as unknown as { _simulate: typeof original })._simulate = original;
      }
    });

    it("Returns skipped when txResponse.wait() rejects after _submit gave up", async function () {
      const chainId = chainIds[0];
      // Inner _submit confirmation loop exhausts its retries (10 undefined receipts) and
      // still returns the TransactionResponse, then the outer wait() in
      // sendAndConfirmTransaction rejects with a transient provider error. Verify the run
      // isn't aborted (callers were previously getting `undefined` from a `catch {}` and
      // we must preserve that "skipped → release locks / retry" path).
      let waitCalls = 0;
      txnClient.waitOverride = () => {
        if (++waitCalls <= 10) {
          return Promise.resolve(undefined as unknown as TransactionReceipt);
        }
        return Promise.reject(new Error("ECONNRESET"));
      };

      const outcome = await sendAndConfirmTransaction(makeTxn(chainId, txnClientPassResult), txnClient);
      expect(outcome.status).to.equal("skipped");
      expect(waitCalls).to.be.greaterThan(10);
    });

    it("Returns unexpected_error (typed) for non-typed thrown errors", async function () {
      const chainId = chainIds[0];
      // Pass-by-throw: have `_simulate` reject with a generic error (e.g. a programming bug
      // inside `willSucceed`). Callers take in-memory locks before awaiting and rely on a settled
      // outcome (not a thrown exception) to release them, so `sendAndConfirmTransaction` must
      // surface a typed outcome rather than rethrowing.
      const original = txnClient["_simulate"].bind(txnClient);
      (txnClient as unknown as { _simulate: typeof original })._simulate = async () => {
        throw new Error("unexpected boom");
      };
      try {
        const outcome = await sendAndConfirmTransaction(makeTxn(chainId, txnClientPassResult), txnClient);
        expect(outcome.status).to.equal("unexpected_error");
        if (outcome.status === "unexpected_error") {
          expect((outcome.error as Error)?.message).to.equal("unexpected boom");
        }
      } finally {
        (txnClient as unknown as { _simulate: typeof original })._simulate = original;
      }
    });
  });
});
