import { AugmentedTransaction, MultiCallerClient } from "../src/clients";
import { BigNumber, TransactionReceipt, TransactionResponse, toBN } from "../src/utils";
import { MockedTransactionClient } from "./mocks/MockTransactionClient";
import { createSpyLogger, Contract, expect, randomAddress, winston, ethers as testEthers } from "./utils";

// Some bridges enqueue an unwrap flagged ensureConfirmation followed by a native transfer that is
// only fundable once the unwrap has been mined. The confirmation wait must therefore land between
// the two submissions when the pair is submitted via MultiCallerClient.
const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
const chainId = 8453;
const address = randomAddress();
const amount: BigNumber = toBN("1000000000000000000");

// Records the interleaving of submissions and confirmation waits.
class RecordingTransactionClient extends MockedTransactionClient {
  public events: string[] = [];

  protected override _getTransactionPromise(
    txn: AugmentedTransaction,
    nonce: number | null
  ): Promise<TransactionResponse> {
    this.events.push(`submit:${txn.method === "" ? "transfer" : txn.method}`);
    return super._getTransactionPromise(txn, nonce);
  }
}

class TestMultiCallerClient extends MultiCallerClient {
  constructor(logger: winston.Logger, client: RecordingTransactionClient) {
    super(logger);
    this.txnClient = client;
  }
}

describe("MultiCallerClient: confirmation ordering", function () {
  let txnClient: RecordingTransactionClient;
  let signer;

  beforeEach(async function () {
    txnClient = new RecordingTransactionClient(spyLogger);
    [signer] = await testEthers.getSigners();
  });

  it("Awaits an ensureConfirmation receipt before submitting the next transaction", async function () {
    txnClient.waitOverride = () => {
      txnClient.events.push("wait");
      return Promise.resolve({} as TransactionReceipt);
    };

    const contract = {
      address,
      signer,
      provider: { getBlockNumber: () => Promise.resolve(100) },
    } as Contract;

    const unwrapTxn: AugmentedTransaction = {
      contract,
      chainId,
      method: "withdraw",
      args: [amount],
      nonMulticall: true,
      ensureConfirmation: true,
      message: "unwrap",
      mrkdwn: "unwrap",
    };

    // Mirrors the dependent transfer: unsimulatable ahead of the unwrap, so it carries a static
    // gasLimit and canFailInSimulation.
    const transferTxn: AugmentedTransaction = {
      contract,
      chainId,
      method: "",
      args: [],
      nonMulticall: true,
      gasLimit: toBN(42000),
      canFailInSimulation: true,
      value: amount,
      message: "transfer",
      mrkdwn: "transfer",
    };

    const multicaller = new TestMultiCallerClient(spyLogger, txnClient);
    [unwrapTxn, transferTxn].forEach((txn) => multicaller.enqueueTransaction(txn));
    await multicaller.executeTxnQueues(false, [chainId]);

    expect(txnClient.events).to.deep.equal(["submit:withdraw", "wait", "submit:transfer"]);
  });
});
