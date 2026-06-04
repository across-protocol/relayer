import { AugmentedTransaction } from "../src/clients";
import { extractErrorCause } from "../src/clients/TransactionClient";
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

  describe("extractErrorCause", function () {
    it("parses a strict JSON-RPC body on the immediate inner error", function () {
      const inner = {
        reason: "processing response error",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "Insufficient funds for gas", data: null },
        }),
      };
      const outer = Object.assign(new Error("cannot estimate gas; transaction may fail"), {
        code: ethers.errors.UNPREDICTABLE_GAS_LIMIT,
        reason: "cannot estimate gas; transaction may fail",
        error: inner,
      });
      expect(extractErrorCause(outer)).to.equal("insufficient funds for gas");
    });

    it("walks one wrapper deeper to find the JSON-RPC body", function () {
      // ethers commonly nests one extra layer (SERVER_ERROR wrapping the raw RPC response).
      const rpc = {
        reason: "processing response error",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "nonce too low", data: null },
        }),
      };
      const middle = { error: rpc };
      const outer = Object.assign(new Error("outer"), {
        code: ethers.errors.SERVER_ERROR,
        reason: "outer",
        error: middle,
      });
      expect(extractErrorCause(outer)).to.equal("nonce too low");
    });

    it("prefers a deeper JSON-RPC body over a wrapper layer's own reason/message", function () {
      // RetryProvider/QuorumProvider often stack their own generic `reason` / `message`
      // on top of the real RPC response. A single-pass walk that short-circuits on the
      // wrapper's `reason` would return "processing response error" and miss the deeper
      // body — this test pins the two-pass behavior.
      const rpc = {
        reason: "processing response error",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "nonce too low", data: null },
        }),
      };
      const middle = {
        reason: "processing response error",
        message: "wrapper message",
        error: rpc,
      };
      const outer = Object.assign(new Error("outer"), {
        code: ethers.errors.SERVER_ERROR,
        reason: "outer",
        error: middle,
      });
      expect(extractErrorCause(outer)).to.equal("nonce too low");
    });

    it("falls back to the inner error's reason when no JSON-RPC body is present", function () {
      const inner = { reason: "execution reverted: RelayFilled" };
      const outer = Object.assign(new Error("outer"), {
        code: ethers.errors.UNPREDICTABLE_GAS_LIMIT,
        reason: "cannot estimate gas",
        error: inner,
      });
      expect(extractErrorCause(outer)).to.equal("execution reverted: relayfilled");
    });

    it("falls back to the inner error's message when no reason or body is present", function () {
      const inner = { message: "could not coalesce error" };
      const outer = Object.assign(new Error("outer"), {
        code: ethers.errors.SERVER_ERROR,
        reason: "outer",
        error: inner,
      });
      expect(extractErrorCause(outer)).to.equal("could not coalesce error");
    });

    it("falls back to the outer error when no inner error is attached", function () {
      const outer = Object.assign(new Error("nonce has already been used"), {
        code: ethers.errors.NONCE_EXPIRED,
        reason: "nonce has already been used",
      });
      expect(extractErrorCause(outer)).to.equal("nonce has already been used");
    });

    it("returns 'unknown error' only when every layer is empty", function () {
      const outer = Object.assign(new Error(""), {
        code: ethers.errors.SERVER_ERROR,
        reason: "",
        error: { reason: "", message: "", error: {} },
      });
      expect(extractErrorCause(outer)).to.equal("unknown error");
    });

    it("rejects a non-JSON-RPC body but still returns the wrapper's reason", function () {
      const inner = {
        reason: "bad gateway",
        body: "<html>502 Bad Gateway</html>",
      };
      const outer = Object.assign(new Error("outer"), {
        code: ethers.errors.SERVER_ERROR,
        reason: "outer",
        error: inner,
      });
      expect(extractErrorCause(outer)).to.equal("bad gateway");
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
});
