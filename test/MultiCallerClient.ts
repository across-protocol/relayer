import { ethers } from "ethers";
import {
  AugmentedTransaction,
  MultiCallerClient, // tested
  knownRevertReasons,
  unknownRevertReason,
  unknownRevertReasonMethodsToIgnore,
} from "../src/clients";
import { TransactionResponse, TransactionSimulationResult } from "../src/utils";
import { MockedTransactionClient, txnClientPassResult } from "./mocks/MockTransactionClient";
import { CHAIN_ID_TEST_LIST as chainIds } from "./constants";
import { createSpyLogger, Contract, expect, randomAddress, winston, toBN } from "./utils";

class MockedMultiCallerClient extends MultiCallerClient {
  public ignoredSimulationFailures: TransactionSimulationResult[] = [];
  public loggedSimulationFailures: TransactionSimulationResult[] = [];

  constructor(logger: winston.Logger, chunkSize: { [chainId: number]: number } = {}) {
    super(logger, chunkSize);
    this.txnClient = new MockedTransactionClient(logger);
  }

  simulationFailureCount(): number {
    return this.loggedSimulationFailures.length + this.ignoredSimulationFailures.length;
  }

  clearSimulationFailures(): void {
    this.ignoredSimulationFailures = [];
    this.loggedSimulationFailures = [];
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
  });

  it("Correctly excludes simulation failures", async function () {
    for (const result of ["Forced simulation failure", txnClientPassResult]) {
      const fail = !(result === txnClientPassResult);
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
      const results: AugmentedTransaction[] = await multiCaller.simulateTransactionQueue(txns);
      expect(results.length).to.equal(fail ? 0 : txns.length);

      // Verify that the failed simulations were filtered out.
      expect(multiCaller.simulationFailureCount()).to.equal(fail ? txns.length : 0);
      multiCaller.clearSimulationFailures();
    }
  });

  // Temporarily skipped so as to avoid unnecessarily changing MultiCallerClient.executeTransactionQueue().
  it.skip("Handles submission success & failure", async function () {
    for (const result of ["Forced submission failure", ""]) {
      const fail = !(result === txnClientPassResult);

      chainIds.forEach((_chainId) => {
        const chainId = Number(_chainId);
        multiCaller.enqueueTransaction({
          chainId: chainId,
          contract: {
            address,
            interface: { encodeFunctionData },
          },
          method: "test",
          args: [{ result }],
          value: toBN(0),
          message: `Test transaction on chain ${chainId}`,
          mrkdwn: `Sample markdown string for chain ${chainId} value transaction`,
        } as AugmentedTransaction);
      });
      expect(multiCaller.transactionCount()).to.equal(chainIds.length);

      const results: string[] = await multiCaller.executeTransactionQueue();
      expect(results.length).to.equal(fail ? 0 : chainIds.length);

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
      txn.args = [{ result: revertReason }];
      txn.message = `Transaction simulation failure; expected to fail with: ${revertReason}.`;

      const result: AugmentedTransaction[] = await multiCaller.simulateTransactionQueue([txn]);
      expect(result.length).to.equal(0);
      expect(multiCaller.ignoredSimulationFailures.length).to.equal(1);
      expect(multiCaller.loggedSimulationFailures.length).to.equal(0);
    }

    // Verify that the defined "unknown" revert reason against known methods is ignored.
    txn.args = [{ result: unknownRevertReason }];
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
        txn.args = [{ result: revertReason }];
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
});
