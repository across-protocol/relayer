import { ethers } from "ethers";
import {
  AugmentedTransaction,
  MultiCallerClient, // tested
} from "../src/clients";
import { TransactionSimulationResult } from "../src/utils";
import { CHAIN_ID_TEST_LIST as chainIds } from "./constants";
import { createSpyLogger, Contract, expect, winston } from "./utils";

class MockedMultiCallerClient extends MultiCallerClient {
  public failSimulate = "";

  constructor(logger: winston.Logger) {
    super(logger);
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
}

const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
const multiCaller: MockedMultiCallerClient = new MockedMultiCallerClient(spyLogger);
const provider = new ethers.providers.StaticJsonRpcProvider("127.0.0.1");

describe("MultiCallerClient", async function () {
  beforeEach(async function () {
    multiCaller.clearTransactionQueue();
    expect(multiCaller.transactionCount()).to.equal(0);
  });

  it("Correctly excludes simulation failures", async function () {
    for (const fail of [true, false]) {
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
    }
  });
});
