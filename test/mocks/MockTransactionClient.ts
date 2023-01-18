import { AugmentedTransaction, TransactionClient } from "../../src/clients";
import { TransactionResponse } from "../../src/utils";
import { winston } from "../utils";

export const txnClientPassResult = "pass";

export class MockedTransactionClient extends TransactionClient {
  constructor(logger: winston.Logger) {
    super(logger);
  }

  protected async _submit(txn: AugmentedTransaction, nonce: number | null = null): Promise<TransactionResponse> {
    const result = txn.args[0]?.result;
    if (result && result !== txnClientPassResult) return Promise.reject(result);

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
