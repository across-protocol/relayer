import { ethers } from "ethers";
import {
  AugmentedTransaction,
  MultiCallerClient, // tested
  knownRevertReasons,
  unknownRevertReason,
  unknownRevertReasonMethodsToIgnore,
} from "../src/clients";
import { TransactionResponse, TransactionSimulationResult } from "../src/utils";
import { CHAIN_ID_TEST_LIST as chainIds } from "./constants";
import { createSpyLogger, Contract, expect, randomAddress, winston, toBN } from "./utils";

class MockedMultiCallerClient extends MultiCallerClient {
  public failSimulate = "";
  public failSubmit = "";
  public ignoredSimulationFailures: TransactionSimulationResult[] = [];
  public loggedSimulationFailures: TransactionSimulationResult[] = [];

  constructor(logger: winston.Logger, chunkSize: { [chainId: number]: number } = {}) {
    super(logger, chunkSize);
  }

  private txnCount(txnQueue: { [chainId: number]: AugmentedTransaction[] }): number {
    let nTxns = 0;
    Object.values(txnQueue).forEach((txnQueue) => (nTxns += txnQueue.length));
    return nTxns;
  }

  valueTxnCount(): number {
    return this.txnCount(this.valueTxns);
  }

  multiCallTransactionCount(): number {
    return this.txnCount(this.txns);
  }

  simulationFailureCount(): number {
    return this.loggedSimulationFailures.length + this.ignoredSimulationFailures.length;
  }

  clearSimulationFailures(): void {
    this.ignoredSimulationFailures = [];
    this.loggedSimulationFailures = [];
  }

  protected override async simulateTxn(txn: AugmentedTransaction): Promise<TransactionSimulationResult> {
    this.logger.debug({
      at: "MockMultiCallerClient#simulateTxn",
      message: `Forcing simulation ${this.failSimulate ? "failure" : "success"}.`,
      txn,
    });
    return {
      transaction: txn,
      succeed: this.failSimulate === "",
      reason: this.failSimulate ?? null,
    };
  }

  protected override async submitTxn(
    txn: AugmentedTransaction,
    nonce: number | null = null
  ): Promise<TransactionResponse> {
    if (this.failSubmit !== "") return Promise.reject(this.failSubmit);

    this.logger.debug({
      at: "MockMultiCallerClient#submitTxn",
      message: "Transaction submission succeeded!",
      txn,
    });

    return {
      chainId: txn.chainId,
      nonce: nonce || 1,
      hash: "0x4321",
    } as TransactionResponse;
  }

  protected override logSimulationFailures(txns: TransactionSimulationResult[]): void {
    this.clearSimulationFailures();
    txns.forEach((txn) => {
      (this.canIgnoreRevertReason(txn) ? this.ignoredSimulationFailures : this.loggedSimulationFailures).push(txn);
    });
  }
}

// encodeFunctionData is called from within MultiCallerClient.buildMultiCallBundle.
function encodeFunctionData(method: string, args?: ReadonlyArray<any>): string {
  return args.join(" ");
}

const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
const multiCaller: MockedMultiCallerClient = new MockedMultiCallerClient(spyLogger);
const provider = new ethers.providers.StaticJsonRpcProvider("127.0.0.1");
const address = randomAddress(); // Test contract address

describe("MultiCallerClient", async function () {
  beforeEach(async function () {
    multiCaller.clearTransactionQueue();
    expect(multiCaller.transactionCount()).to.equal(0);

    multiCaller.clearSimulationFailures();
    expect(multiCaller.simulationFailureCount()).to.equal(0);

    multiCaller.failSimulate = "";
    multiCaller.failSubmit = "";
  });

  it("Correctly enqueues value transactions", async function () {
    chainIds.forEach((chainId) => multiCaller.enqueueTransaction({ chainId, value: toBN(1) } as AugmentedTransaction));
    expect(multiCaller.valueTxnCount()).to.equal(chainIds.length);
    expect(multiCaller.transactionCount()).to.equal(chainIds.length);
  });

  it("Correctly enqueues non-value transactions", async function () {
    [undefined, toBN(0)].forEach((value) => {
      multiCaller.clearTransactionQueue();
      expect(multiCaller.transactionCount()).to.equal(0);

      chainIds.forEach((chainId) => multiCaller.enqueueTransaction({ chainId, value } as AugmentedTransaction));
      expect(multiCaller.multiCallTransactionCount()).to.equal(chainIds.length);
      expect(multiCaller.transactionCount()).to.equal(chainIds.length);
    });
  });

  it("Correctly enqueues mixed transactions", async function () {
    chainIds.forEach((chainId) => {
      multiCaller.enqueueTransaction({ chainId } as AugmentedTransaction);
      multiCaller.enqueueTransaction({ chainId, value: toBN(1) } as AugmentedTransaction);
    });
    expect(multiCaller.valueTxnCount()).to.equal(chainIds.length);
    expect(multiCaller.multiCallTransactionCount()).to.equal(chainIds.length);
    expect(multiCaller.transactionCount()).to.equal(2 * chainIds.length);
  });

  it("Correctly excludes simulation failures", async function () {
    for (const fail of [true, false]) {
      const txns: AugmentedTransaction[] = chainIds.map((_chainId) => {
        const chainId = Number(_chainId);
        return {
          chainId: chainId,
          contract: { address },
          message: `Test transaction on chain ${chainId}`,
          mrkdwn: `This transaction is expected to ${fail ? "fail" : "pass"} simulation.`,
        } as AugmentedTransaction;
      });

      multiCaller.failSimulate = fail ? "Forced simulation failure" : "";
      expect(txns.length).to.equal(chainIds.length);
      const result: AugmentedTransaction[] = await multiCaller.simulateTransactionQueue(txns);
      expect(result.length).to.equal(fail ? 0 : txns.length);

      // Verify that the failed simulations were filtered out.
      expect(multiCaller.simulationFailureCount()).to.equal(fail ? txns.length : 0);
      multiCaller.clearSimulationFailures();
    }
  });

  it("Handles submission success & failure", async function () {
    const nTxns = 4;
    for (const fail of ["Forced submission failure", ""]) {
      multiCaller.failSubmit = fail;

      for (const value of [0, 1]) {
        const txnType = value > 0 ? "value" : "multicall";

        for (let txn = 1; txn <= nTxns; ++txn) {
          multiCaller.failSubmit = fail;

          chainIds.forEach((_chainId) => {
            const chainId = Number(_chainId);
            const txnRequest: AugmentedTransaction = {
              chainId: chainId,
              contract: {
                address,
                interface: { encodeFunctionData },
              },
              method: "test",
              args: ["0", "1", "2", "3"],
              value: toBN(value),
              message: `Test ${txnType} transaction (${txn}/${nTxns}) on chain ${chainId}`,
              mrkdwn: `Sample markdown string for chain ${chainId} ${txnType} transaction`,
            } as AugmentedTransaction;

            multiCaller.enqueueTransaction(txnRequest);
          });
        }
      }

      expect(multiCaller.transactionCount()).to.equal(nTxns * 2 * chainIds.length);

      // Note: Half of the txns should be consolidated into a single multicall txn.
      const result: string[] = await multiCaller.executeTransactionQueue();
      expect(result.length).to.equal(fail ? 0 : (nTxns + 1) * chainIds.length);

      // Simulation succeeded but submission failed => multiCaller.simulationFailures should be empty.
      expect(multiCaller.simulationFailureCount()).to.equal(0);
    }
  });

  it("Correctly filters loggable vs. ignorable simulation failures", async function () {
    const txn: AugmentedTransaction = {
      chainId: chainIds[0],
      contract: { address },
    } as AugmentedTransaction;

    // Verify that all known revert reasons are ignored.
    for (const revertReason of knownRevertReasons) {
      multiCaller.failSimulate = revertReason;
      txn.message = `Transaction simulation failure; expected to fail with: ${revertReason}.`;

      const result: AugmentedTransaction[] = await multiCaller.simulateTransactionQueue([txn]);
      expect(result.length).to.equal(0);
      expect(multiCaller.ignoredSimulationFailures.length).to.equal(1);
      expect(multiCaller.loggedSimulationFailures.length).to.equal(0);
    }

    // Verify that the defined "unknown" revert reason against known methods is ignored.
    multiCaller.failSimulate = unknownRevertReason;
    for (const method of unknownRevertReasonMethodsToIgnore) {
      txn.method = method;
      txn.message = `${txn.method} simulation; expected to fail with: ${unknownRevertReason}.`;

      const result: AugmentedTransaction[] = await multiCaller.simulateTransactionQueue([txn]);
      expect(result.length).to.equal(0);
      expect(multiCaller.ignoredSimulationFailures.length).to.equal(1);
      expect(multiCaller.loggedSimulationFailures.length).to.equal(0);
    }

    // Verify that unexpected revert reason against both known and "unknown" methods are logged.
    for (const method of [...unknownRevertReasonMethodsToIgnore, "randomMethod"]) {
      txn.method = method;

      for (const revertReason of ["unexpected revert reasons", "should not be ignored!"]) {
        multiCaller.failSimulate = revertReason;
        txn.message = `${txn.method} simulation; expected to fail with: ${unknownRevertReason}.`;

        const result: AugmentedTransaction[] = await multiCaller.simulateTransactionQueue([txn]);
        expect(result.length).to.equal(0);
        expect(multiCaller.ignoredSimulationFailures.length).to.equal(0);
        expect(multiCaller.loggedSimulationFailures.length).to.equal(1);
      }
    }
  });

  it("Validates transaction data before multicall bundle generation", async function () {
    const chainId = chainIds[0];

    for (const badField of ["address", "chainId"]) {
      const txns: AugmentedTransaction[] = [];

      for (const idx of [1, 2, 3, 4, 5]) {
        const txn = {
          chainId: chainId,
          contract: {
            address,
            interface: { encodeFunctionData },
          } as Contract,
          method: "test",
          args: ["2"],
          value: toBN(0),
          message: `Test multicall candidate on chain ${chainId}`,
        } as AugmentedTransaction;
        txns.push(txn);
      }

      expect(txns.length).to.not.equal(0);
      expect(() => multiCaller.buildMultiCallBundle(txns)).to.not.throw();

      const badTxn: AugmentedTransaction = txns.pop();
      switch (badField) {
        case "address":
          badTxn.contract = {
            address: randomAddress(),
            interface: { encodeFunctionData },
          } as Contract;
          break;

        case "chainId":
          badTxn.chainId += 1;
          break;
      }

      txns.push(badTxn);
      expect(() => multiCaller.buildMultiCallBundle(txns)).to.throw("Multicall bundle data mismatch");
    }
  });

  it("Validates that multicall bundle generation respects chunk size configurations", async function () {
    const chunkSize: { [chainId: number]: number } = Object.fromEntries(
      chainIds.map((_chainId, idx) => {
        const chainId = Number(_chainId);
        return [chainId, 2 + idx * 2];
      })
    );
    const _multiCaller = new MockedMultiCallerClient(spyLogger, chunkSize);

    const testMethod = "test";
    const nFullBundles = 3;
    for (const chainId of chainIds) {
      const multicallTxns: AugmentedTransaction[] = [];
      const _chunkSize = chunkSize[chainId];

      const sampleTxn = {
        chainId,
        contract: {
          address,
          interface: { encodeFunctionData },
        } as Contract,
        method: testMethod,
        args: [],
      } as AugmentedTransaction;

      const nTxns = nFullBundles * _chunkSize + 1;
      for (let txn = 0; txn < nTxns; ++txn) {
        expect(sampleTxn.method).to.not.equal("multicall");
        multicallTxns.push(sampleTxn);
      }

      const txnQueue: AugmentedTransaction[] = await _multiCaller.buildMultiCallBundles(multicallTxns, _chunkSize);
      expect(txnQueue.length).to.equal(nFullBundles + 1);

      txnQueue.slice(0, nFullBundles).forEach((txn) => {
        // If chunkSize is 1, no multiCall txns will be bundled.
        expect(txn.method).to.equal(_chunkSize > 1 ? "multicall" : testMethod);
      });
      // txnQueue deliberately has one "spare" txn appended, so it should never be bundled.
      txnQueue.slice(-1).forEach((txn) => expect(txn.method).to.equal(testMethod));
    }
  });

  it("Validates that successive transactions increment their nonce", async function () {
    const chainId = chainIds[0];

    const nTxns = 5;
    for (let txn = 1; txn <= nTxns; ++txn) {
      for (const value of [0, 1]) {
        const txnType = value > 0 ? "value" : "multicall";

        const txnRequest: AugmentedTransaction = {
          chainId,
          contract: {
            address,
            interface: { encodeFunctionData },
          },
          method: "test",
          args: [],
          value: toBN(value),
        } as AugmentedTransaction;

        multiCaller.enqueueTransaction(txnRequest);
      }
    }

    const txnResponses: TransactionResponse[] = await multiCaller.executeChainTxnQueue(chainId);
    let nonce = txnResponses[0].nonce;
    txnResponses.slice(1).forEach((txnResponse) => {
      expect(txnResponse.nonce).to.equal(nonce + 1);
      nonce = txnResponse.nonce;
    });
  });
});
