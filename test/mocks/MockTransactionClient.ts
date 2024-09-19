import { ethers } from "ethers";
import { random } from "lodash";
import { AugmentedTransaction, TransactionClient } from "../../src/clients";
import { BigNumber, TransactionResponse, TransactionSimulationResult } from "../../src/utils";
import { toBNWei, winston } from "../utils";

export const txnClientPassResult = "pass";

export class MockedTransactionClient extends TransactionClient {
  public gasLimit: BigNumber | undefined = undefined;

  constructor(logger: winston.Logger) {
    super(logger);
  }

  randomGasLimit(): BigNumber {
    return toBNWei(random(21_000, 30_000_000).toPrecision(9));
  }

  // Forced failures are appended to any list of transaction arguments.
  txnFailureReason(txn: AugmentedTransaction): string {
    return txn.args.slice(-1)[0]?.result;
  }

  txnFailure(txn: AugmentedTransaction): boolean {
    const result = this.txnFailureReason(txn);
    return result !== undefined && result !== txnClientPassResult;
  }

  protected override async _simulate(txn: AugmentedTransaction): Promise<TransactionSimulationResult> {
    const fail = this.txnFailure(txn);

    this.logger.debug({
      at: "MockMultiCallerClient#simulateTxn",
      message: `Forcing simulation ${fail ? "failure" : "success"}.`,
      txn,
    });

    const gasLimit = this.gasLimit ?? this.randomGasLimit();

    return {
      transaction: { ...txn, gasLimit },
      succeed: !fail,
      reason: fail ? this.txnFailureReason(txn) : "",
    };
  }

  protected override async _submit(
    txn: AugmentedTransaction,
    nonce: number | null = null
  ): Promise<TransactionResponse> {
    if (this.txnFailure(txn)) {
      return Promise.reject(this.txnFailureReason(txn));
    }

    const _nonce = nonce ?? 1;
    const txnResponse = {
      chainId: txn.chainId,
      nonce: _nonce,
      hash: ethers.utils.id(`Across-v2-${txn.contract.address}-${txn.method}-${_nonce}`),
      gasLimit: txn.gasLimit ?? this.randomGasLimit(),
    } as TransactionResponse;

    this.logger.debug({
      at: "MockMultiCallerClient#submitTxns",
      message: "Transaction submission succeeded!",
      txn: txnResponse,
    });

    return txnResponse;
  }
}
