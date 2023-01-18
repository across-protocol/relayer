import { ethers } from "ethers";
import { AugmentedTransaction, TransactionClient } from "../src/clients";
import { TransactionResponse, TransactionSimulationResult } from "../src/utils";
import { CHAIN_ID_TEST_LIST as chainIds } from "./constants";
import { createSpyLogger, Contract, expect, randomAddress, winston, toBN } from "./utils";

const passResult = "pass";

class MockedTransactionClient extends TransactionClient {

  constructor(logger: winston.Logger) {
    super(logger);
  }

  protected async _simulate(txn: AugmentedTransaction): Promise<TransactionSimulationResult> {
    const result = txn.args[0]?.result;
    const pass = !(result && result !== passResult);

    return {
      transaction: txn,
      succeed: pass,
      reason: pass ? null : result,
    };
  }

  protected async _submit(txn: AugmentedTransaction, nonce: number | null = null): Promise<TransactionResponse> {
    const result = txn.args[0]?.result;
    if (result && result !== "pass") return Promise.reject(result);

    const txnResponse = {
      chainId: txn.chainId,
      nonce: nonce ?? 1,
      hash: "0x4321",
    } as TransactionResponse;

    this.logger.debug({
      at: "MockMultiCallerClient#submitTxns",
      message: "Transaction submission succeeded!",
      txn: txnResponse,
    });

    return txnResponse;
  }
}

const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
const txnClient: MockedTransactionClient = new MockedTransactionClient(spyLogger);
const provider = new ethers.providers.StaticJsonRpcProvider("127.0.0.1");
const address = randomAddress(); // Test contract address
const method = "testMethod";

describe("TransactionClient", async function () {
  beforeEach(async function () {});

  it("Correctly excludes simulation failures", async function () {
    for (const result of ["Forced simulation failure", passResult]) {
      const fail = (result !== passResult);
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
    for (const result of [passResult, "Forced submission failure", passResult]) {
      const txn: AugmentedTransaction = {
        chainId,
        contract: { address } as Contract,
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
        contract: { address } as Contract,
        method,
        args: [],
      } as AugmentedTransaction;
      txns.push(txnRequest);
    }

    const txnResponses: TransactionResponse[] = await txnClient.submit(chainId, txns);
    let nonce = txnResponses[0].nonce;
    txnResponses.slice(1).forEach((txnResponse) => {
      expect(txnResponse.nonce).to.equal(++nonce);
    });
  });
});
