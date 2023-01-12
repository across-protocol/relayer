import { ethers } from "ethers";
import {
  AugmentedTransaction,
  MultiCallerClient, // tested
} from "../src/clients";
import { TransactionResponse, TransactionSimulationResult } from "../src/utils";
import { CHAIN_ID_TEST_LIST as chainIds } from "./constants";
import { createSpyLogger, Contract, expect, winston, toBN } from "./utils";

class MockedMultiCallerClient extends MultiCallerClient {
  public failSimulate = "";
  public failSubmit = "";
  public simulationFailures: TransactionSimulationResult[] = [];

  constructor(logger: winston.Logger) {
    super(logger);
  }

  clearSimulationFailures(): void {
    this.simulationFailures = [];
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

  protected override logSimulationFailures(failures: TransactionSimulationResult[]): void {
    this.simulationFailures = failures;
  }
}

// encodeFunctionData is called from within MultiCallerClient.buildMultiCallBundle.
function encodeFunctionData(method: string, args?: ReadonlyArray<any>): string {
  return args.join(" ");
}

const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
const multiCaller: MockedMultiCallerClient = new MockedMultiCallerClient(spyLogger);
const provider = new ethers.providers.StaticJsonRpcProvider("127.0.0.1");

describe("MultiCallerClient", async function () {
  beforeEach(async function () {
    multiCaller.clearTransactionQueue();
    expect(multiCaller.transactionCount()).to.equal(0);

    multiCaller.clearSimulationFailures();
    expect(multiCaller.simulationFailures.length).to.equal(0);
  });

  it("Correctly excludes simulation failures", async function () {
    for (const fail of [true, false]) {
      multiCaller.clearSimulationFailures();

      const txns: AugmentedTransaction[] = chainIds.map((_chainId) => {
        const chainId = Number(_chainId);
        return {
          chainId: chainId,
          contract: {
            address: "0x1234",
          },
          message: `Test transaction on chain ${chainId}`,
          mrkdwn: `This transaction is expected to ${fail ? "fail" : "pass"} simulation.`,
        } as AugmentedTransaction;
      });

      multiCaller.failSimulate = fail ? "Forced simulation failure" : "";
      expect(txns.length).to.equal(chainIds.length);
      const result: AugmentedTransaction[] = await multiCaller.simulateTransactionQueue(txns);
      expect(result.length).to.equal(fail ? 0 : txns.length);

      // Verify that the failed simulations were filtered out.
      expect(multiCaller.simulationFailures.length).to.equal(fail ? txns.length : 0);
    }
  });

  it("Handles submission success & failure", async function () {
    for (const fail of ["Forced submission failure", ""]) {
      multiCaller.failSubmit = fail;
      multiCaller.clearSimulationFailures();

      chainIds.forEach((_chainId) => {
        const chainId = Number(_chainId);
        multiCaller.enqueueTransaction({
          chainId: chainId,
          contract: {
            address: "0x1234",
            interface: { encodeFunctionData },
          },
          method: "test",
          args: ["0", "1", "2", "3"],
          value: toBN(0),
          message: `Test transaction on chain ${chainId}`,
          mrkdwn: `Sample markdown string for chain ${chainId} value transaction`,
        } as AugmentedTransaction);
      });
      expect(multiCaller.transactionCount()).to.equal(chainIds.length);

      const result: string[] = await multiCaller.executeTransactionQueue();
      expect(result.length).to.equal(fail ? 0 : chainIds.length);

      // Simulation succeeded but submission failed => multiCaller.simulationFailures should be empty.
      expect(multiCaller.simulationFailures.length).to.equal(0);
    }
  });
});
