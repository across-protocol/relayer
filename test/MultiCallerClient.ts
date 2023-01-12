import { ethers } from "ethers";
import {
  AugmentedTransaction,
  MultiCallerClient, // tested
} from "../src/clients";
import { TransactionResponse, TransactionSimulationResult } from "../src/utils";
import { CHAIN_ID_TEST_LIST as chainIds } from "./constants";
import { createSpyLogger, Contract, expect, randomAddress, winston, toBN } from "./utils";

class MockedMultiCallerClient extends MultiCallerClient {
  public failSimulate = "";
  public failSubmit = "";

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
    }
  });

  it("Handles submission success & failure", async function () {
    for (const fail of ["Forced submission failure", ""]) {
      multiCaller.failSubmit = fail;
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
