import { winston, Transaction } from "./utils";

export class MulticallBundler {
  private transactions: Transaction[] = [];
  constructor(readonly logger: winston.Logger, readonly gasEstimator: any) {}

  addTransaction(transaction: Transaction) {
    this.transactions.push(transaction);
  }

  transactionCount() {
    return this.transactions.length;
  }

  clearTransactionQueue() {
    this.transactions = [];
  }

  async executeTransactionQueue() {
    // TODO: this should include grouping logic for multicall
    this.logger.debug({ at: "MulticallBundler", message: "Executing tx bundle", number: this.transactions.length });
    const transactionResults = await Promise.all(this.transactions);
    const transactionReceipts = await Promise.all(transactionResults.map((transaction: any) => transaction.wait()));

    // TODO: add additional logging on error processing.
    this.logger.debug({
      at: "MulticallBundler",
      message: "All transactions executed",
      hashes: transactionReceipts.map((receipt) => receipt.transactionHash),
    });
    return transactionReceipts;
  }
}
