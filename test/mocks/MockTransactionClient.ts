import { BigNumber, ethers } from "ethers";
import { random } from "lodash";
import { AugmentedTransaction, TransactionClient } from "../../src/clients";
import { TransactionResponse, TransactionSimulationResult } from "../../src/utils";
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
    if (txn.method === "tryMulticall") {
      return this.checkIndividualTransactions(txn);
    }
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
    // For testing the TryMulticallClient, we need to know how many transactions there were in the multicall bundle, so
    // we construct the hash a bit differently.
    const hash =
      txn.method === "tryMulticall"
        ? ethers.utils.id(`Across-v2-${txn.contract.address}-${txn.method}-${txn.args[0].length}`)
        : ethers.utils.id(`Across-v2-${txn.contract.address}-${txn.method}-${_nonce}`);
    const txnResponse = {
      chainId: txn.chainId,
      nonce: _nonce,
      hash,
      gasLimit: txn.gasLimit ?? this.randomGasLimit(),
    } as TransactionResponse;

    this.logger.debug({
      at: "MockMultiCallerClient#submitTxns",
      message: "Transaction submission succeeded!",
      txn: txnResponse,
    });

    return txnResponse;
  }

  checkIndividualTransactions(txn: AugmentedTransaction): Promise<TransactionSimulationResult> {
    // We know it's tryMulticall so there is only one argument.
    const returnData = txn.args[0].map(([result]) => {
      return {
        success: result === txnClientPassResult,
        data: result,
      };
    });
    return {
      transaction: { ...txn },
      succeed: true,
      data: returnData,
    };
  }
}
