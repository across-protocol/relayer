import { winston, getNetworkName, assign, Contract, runTransaction, willSucceed, etherscanLink } from "../utils";
interface AugmentedTransaction {
  contract: Contract;
  method: string;
  args: any;
  message: string;
  mrkdwn: string;
}

export class MultiCallBundler {
  private transactions: AugmentedTransaction[] = [];
  constructor(readonly logger: winston.Logger, readonly gasEstimator: any) {}

  // Adds all information associated with a transaction to the transaction queue. This is the intention of the
  // caller to send a transaction. The transaction might not be executable, which should be filtered later.
  enqueueTransaction(contract: Contract, method: string, args: any, message: string, mrkdwn: string) {
    if (contract) this.transactions.push({ contract, method, args, message, mrkdwn });
  }

  transactionCount() {
    return this.transactions.length;
  }

  clearTransactionQueue() {
    this.transactions = [];
  }

  async executeTransactionQueue() {
    try {
      this.logger.debug({ at: "MultiCallBundler", message: "Executing tx bundle", number: this.transactions.length });

      // Simulate the transaction execution for the whole queue.
      const transactionsSucceed = await Promise.all(
        this.transactions.map((tx: AugmentedTransaction) => willSucceed(tx.contract, tx.method, tx.args))
      );

      // If any transactions will revert then log the reason and remove them from the transaction queue.
      if (transactionsSucceed.some((succeed) => !succeed.succeed))
        this.logger.error({
          at: "MultiCallBundler",
          message: "Some transaction in the queue are reverting!",
          revertingTransactions: transactionsSucceed.flatMap((succeed, index) =>
            succeed.succeed
              ? [] // return blank array if the transaction is succeeding. Else, return information on why reverted.
              : { target: this.getTarget(index), reason: succeed.reason, message: this.transactions[index].message }
          ),
        });
      const validTransactions: AugmentedTransaction[] = transactionsSucceed.flatMap((succeed, i) =>
        succeed.succeed ? this.transactions[i] : []
      );

      if (validTransactions.length == 0) {
        this.logger.debug({ at: "MultiCallBundler", message: "No valid transactions in the queue" });
        return;
      }

      // Group by target chain. Note that there is NO grouping by target contract. The relayer will only ever use this
      // multiCallBundler to send multiple transactions to one target contract on a given target chain and so we dont
      // need to group by target contract. This can be further refactored with another group by if this is needed.
      const groupedTransactions: { [networkId: number]: AugmentedTransaction[] } = {};
      for (const transaction of validTransactions)
        assign(groupedTransactions, [(transaction.contract.provider as any).network.chainId], [transaction]);

      this.logger.debug({
        at: "MultiCallBundler",
        message: "Executing transactions grouped by target chain",
        txs: Object.keys(groupedTransactions).map((chainId) => ({ chainId, num: groupedTransactions[chainId].length })),
      });

      // Construct multiCall transaction for each target chain.
      const multiCallTransactionsResult = await Promise.allSettled(
        Object.keys(groupedTransactions).map((chainId) => this.buildMultiCallBundle(groupedTransactions[chainId]))
      );

      const transactionReceipts = await Promise.allSettled(
        multiCallTransactionsResult.map((transaction) => (transaction as any).value.wait())
      );

      // Each element in the bundle of receipts relates back to each set within the groupedTransactions. Produce log.
      let mrkdwn = "";
      const transactionHashes = [];
      Object.keys(groupedTransactions).forEach((chainId, chainIndex) => {
        mrkdwn += `*Transactions sent in batch on ${getNetworkName(chainId)}:*\n`;
        groupedTransactions[chainId].forEach((transaction, groupTxIndex) => {
          mrkdwn +=
            `  ${groupTxIndex + 1}: ${transaction.message || "No message"}:\n` +
            `      ◦ ${transaction.mrkdwn || "No markdown"}\n`;
        });
        const transactionHash = (transactionReceipts[chainIndex] as any).value.transactionHash;
        mrkdwn += "tx " + etherscanLink(transactionHash, chainId);
        transactionHashes.push(transactionHash);
      });
      this.logger.info({ at: "MultiCallBundler", message: "Multicall batch sent! 🧙‍♂️", mrkdwn });
      return transactionHashes;
    } catch (error) {
      this.logger.error({ at: "MultiCallBundler", message: "Error executing tx bundle", error });
    }
  }

  async buildMultiCallBundle(
    transactions: AugmentedTransaction[]
  ): Promise<{ address: string; chainId: number } | null> {
    // Validate all transactions in the batch have the same target contract.
    const target = transactions[0].contract;
    if (transactions.every((tx) => tx.contract.address != target.address)) {
      this.logger.error({
        at: "MultiCallBundler",
        message: "some transactions in the bundle contain different target addresses",
        transactions: transactions.map((tx) => {
          return { address: tx.contract.address, chainId: (tx.contract.provider as any).network.chainId };
        }),
      });
      return null; // If there is a problem in the targets in the bundle return null. This will be a noop.
    }
    const multiCallData = transactions.map((tx) => tx.contract.interface.encodeFunctionData(tx.method, tx.args));
    this.logger.debug({ at: "MultiCallBundler", message: "Produced bundle", target: target.address, multiCallData });
    return runTransaction(this.logger, target, "multicall", [multiCallData]);
  }

  private getTarget(index: number) {
    return { target: this.transactions[index].contract.address };
  }
}
