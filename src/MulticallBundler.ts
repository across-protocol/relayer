import { winston, Transaction } from "./utils";

export class MultiCallBundler {
  private transactions: Transaction[] = [];
  constructor(readonly logger: winston.Logger, readonly gasEstimator: any) {}

  // Adds defined transaction to the transaction queue.
  addTransaction(transaction: Transaction) {
    console.log("ADDING TX", transaction);
    if (transaction) this.transactions.push(transaction);
    console.log("this.transactions", this.transactions);
  }

  transactionCount() {
    return this.transactions.length;
  }

  clearTransactionQueue() {
    this.transactions = [];
  }

  async executeTransactionQueue() {
    // TODO: this should include grouping logic for multicall
    this.logger.debug({ at: "MultiCallBundler", message: "Executing tx bundle", number: this.transactions.length });
    const transactionResults = await Promise.all(this.transactions);
    const transactionReceipts = await Promise.all(transactionResults.map((transaction: any) => transaction.wait()));

    // TODO: add additional logging on error processing.
    this.logger.debug({
      at: "MultiCallBundler",
      message: "All transactions executed",
      hashes: transactionReceipts.map((receipt) => receipt.transactionHash),
    });
    return transactionReceipts;
  }
}
