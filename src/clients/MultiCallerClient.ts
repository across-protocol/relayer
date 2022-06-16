import {
  winston,
  getNetworkName,
  assign,
  Contract,
  runTransaction,
  rejectAfterDelay,
  getTarget,
  BigNumber,
  willSucceed,
  etherscanLink,
  TransactionReceipt,
} from "../utils";
export interface AugmentedTransaction {
  contract: Contract;
  chainId: number;
  method: string;
  args: any;
  message: string;
  mrkdwn: string;
  value?: BigNumber;
}

export class MultiCallerClient {
  private transactions: AugmentedTransaction[] = [];
  // eslint-disable-next-line no-useless-constructor
  constructor(readonly logger: winston.Logger, readonly gasEstimator: any, readonly maxTxWait: number = 180) {}

  // Adds all information associated with a transaction to the transaction queue. This is the intention of the
  // caller to send a transaction. The transaction might not be executable, which should be filtered later.
  enqueueTransaction(transaction: AugmentedTransaction) {
    this.transactions.push(transaction);
  }

  transactionCount() {
    return this.transactions.length;
  }

  clearTransactionQueue() {
    this.transactions = [];
  }

  async executeTransactionQueue(simulationModeOn = false) {
    try {
      if (this.transactions.length === 0) return;
      this.logger.debug({
        at: "MultiCallerClient",
        message: "Executing tx bundle",
        number: this.transactions.length,
        simulationModeOn,
      });

      // Simulate the transaction execution for the whole queue.
      const transactionsSucceed = await Promise.all(
        this.transactions.map((transaction: AugmentedTransaction) => willSucceed(transaction))
      );

      // If any transactions will revert then log the reason and remove them from the transaction queue.
      if (transactionsSucceed.some((succeed) => !succeed.succeed))
        this.logger.error({
          at: "MultiCallerClient",
          message: "Some transaction in the queue will revert!",
          revertingTransactions: transactionsSucceed
            .filter((transaction) => !transaction.succeed)
            .map((transaction) => {
              return {
                target: getTarget(transaction.transaction.contract.address),
                args: transaction.transaction.args,
                reason: transaction.reason,
                message: transaction.transaction.message,
                mrkdwn: transaction.transaction.mrkdwn,
              };
            }),
          notificationPath: "across-error",
        });
      const validTransactions: AugmentedTransaction[] = transactionsSucceed
        .filter((transaction) => transaction.succeed)
        .map((transaction) => transaction.transaction);

      if (validTransactions.length === 0) {
        this.logger.debug({ at: "MultiCallerClient", message: "No valid transactions in the queue" });
        return;
      }

      const valueTransactions = validTransactions.filter((transaction) => transaction.value && transaction.value.gt(0));
      const nonValueTransactions = validTransactions.filter(
        (transaction) => !transaction.value || transaction.value.eq(0)
      );

      // Group by target chain. Note that there is NO grouping by target contract. The relayer will only ever use this
      // MultiCallerClient to send multiple transactions to one target contract on a given target chain and so we dont
      // need to group by target contract. This can be further refactored with another group by if this is needed.
      const groupedTransactions: { [networkId: number]: AugmentedTransaction[] } = {};
      for (const transaction of nonValueTransactions) {
        assign(groupedTransactions, [transaction.chainId], [transaction]);
      }

      if (simulationModeOn) {
        this.logger.debug({
          at: "MultiCallerClient",
          message: "All transactions will succeed! Logging markdown messages.",
        });
        let mrkdwn = "";
        valueTransactions.forEach((transaction, i) => {
          mrkdwn += `*Transaction excluded from batches because it contained value:*\n`;
          mrkdwn += `  ${i + 1}. ${transaction.message || "0 message"}: ` + `${transaction.mrkdwn || "0 mrkdwn"}\n`;
        });
        Object.keys(groupedTransactions).forEach((chainId) => {
          mrkdwn += `*Transactions sent in batch on ${getNetworkName(chainId)}:*\n`;
          groupedTransactions[chainId].forEach((transaction, groupTxIndex) => {
            mrkdwn +=
              `  ${groupTxIndex + 1}. ${transaction.message || "0 message"}: ` +
              `${transaction.mrkdwn || "0 mrkdwn"}\n`;
          });
        });
        this.logger.info({ at: "MultiCallerClient", message: "Exiting simulation mode 🎮", mrkdwn });
        this.clearTransactionQueue();
        return;
      }

      this.logger.debug({
        at: "MultiCallerClient",
        message: "Executing transactions excluded from batches by target chain",
        txs: Object.keys(groupedTransactions).map((chainId) => ({ chainId, num: groupedTransactions[chainId].length })),
      });

      // Construct multiCall transaction for each target chain.
      const valueTransactionsResult = await Promise.allSettled(
        valueTransactions.map(async (transaction): Promise<TransactionReceipt> => {
          const result = await runTransaction(
            this.logger,
            transaction.contract,
            "multicall",
            transaction.args,
            transaction.value
          );
          return await Promise.race([rejectAfterDelay(this.maxTxWait), result.wait()]);
        })
      );

      this.logger.debug({
        at: "MultiCallerClient",
        message: "Executing transactions grouped by target chain",
        txs: Object.keys(groupedTransactions).map((chainId) => ({ chainId, num: groupedTransactions[chainId].length })),
      });

      // Construct multiCall transaction for each target chain.
      const multiCallTransactionsResult = await Promise.allSettled(
        Object.keys(groupedTransactions).map((chainId) => this.buildMultiCallBundle(groupedTransactions[chainId]))
      );

      // Wait for transaction to mine or reject it after a timeout. If transaction failed to be submitted to the
      // mempool, then pass on the error message.
      this.logger.debug({ at: "MultiCallerClient", message: "Waiting for bundle transaction inclusion" });
      const transactionReceipts = await Promise.allSettled(
        multiCallTransactionsResult.map((transaction) => {
          if (transaction.status !== "rejected") {
            return Promise.race([
              rejectAfterDelay(this.maxTxWait), // limit the maximum time to wait for a transaction receipt to mine.
              (transaction as any).value.wait(),
            ]);
          } else return Promise.reject(transaction.reason);
        })
      );

      // Each element in the bundle of receipts relates back to each set within the groupedTransactions. Produce log.
      let mrkdwn = "";
      const transactionHashes = [];
      valueTransactionsResult.forEach((result, i) => {
        const { chainId } = valueTransactions[i];
        mrkdwn += `*Transaction excluded from batches because it contained value:*\n`;
        if (result.status === "rejected") {
          mrkdwn += ` ⚠️ Transaction sent on ${getNetworkName(
            chainId
          )} failed or bot timed out waiting for transaction to mine, check logs for more details.\n`;
          this.logger.debug({
            at: "MultiCallerClient",
            message: `Batch transaction sent on chain ${chainId} failed or bot timed out waiting for it to mine`,
            error: result.reason,
          });
        } else {
          mrkdwn += `  ${i + 1}.${valueTransactions[i].message || ""}: ` + `${valueTransactions[i].mrkdwn || ""}\n`;
          const transactionHash = result.value.transactionHash;
          mrkdwn += "tx: " + etherscanLink(transactionHash, chainId) + "\n";
          transactionHashes.push(transactionHash);
        }
      });
      Object.keys(groupedTransactions).forEach((chainId, chainIndex) => {
        mrkdwn += `*Transactions sent in batch on ${getNetworkName(chainId)}:*\n`;
        if (transactionReceipts[chainIndex].status === "rejected") {
          const rejectionError = (transactionReceipts[chainIndex] as PromiseRejectedResult).reason;
          mrkdwn += ` ⚠️ Transaction sent on ${getNetworkName(
            chainId
          )} failed or bot timed out waiting for transaction to mine, check logs for more details.\n`;
          // If the `transactionReceipt` was rejected because of a timeout, there won't be an error log sent to
          // winston, but it will show up as this debug log that the developer can look up.
          this.logger.debug({
            at: "MultiCallerClient",
            message: `Batch transaction sent on chain ${chainId} failed or bot timed out waiting for it to mine`,
            error: rejectionError,
          });
        } else {
          groupedTransactions[chainId].forEach((transaction, groupTxIndex) => {
            mrkdwn += `  ${groupTxIndex + 1}. ${transaction.message || ""}: ` + `${transaction.mrkdwn || ""}\n`;
          });
          const transactionHash = (transactionReceipts[chainIndex] as PromiseFulfilledResult<any>).value
            .transactionHash;
          mrkdwn += "tx: " + etherscanLink(transactionHash, chainId) + "\n";
          transactionHashes.push(transactionHash);
        }
      });
      this.logger.info({ at: "MultiCallerClient", message: "Multicall batch sent! 🧙‍♂️", mrkdwn });
      this.clearTransactionQueue();
      return transactionHashes;
    } catch (error) {
      this.logger.error({
        at: "MultiCallerClient",
        message: "Error executing bundle. There might be an RPC error",
        error,
        notificationPath: "across-error",
      });
    }
  }

  buildMultiCallBundle(transactions: AugmentedTransaction[]) {
    // Validate all transactions in the batch have the same target contract.
    const target = transactions[0].contract;
    if (transactions.every((tx) => tx.contract.address !== target.address)) {
      this.logger.error({
        at: "MultiCallerClient",
        message: "some transactions in the bundle contain different targets",
        transactions: transactions.map(({ contract, chainId }) => {
          return { target: getTarget(contract.address), chainId };
        }),
        notificationPath: "across-error",
      });
      return Promise.reject("some transactions in the bundle contain different targets");
    }
    let callData = transactions.map((tx) => tx.contract.interface.encodeFunctionData(tx.method, tx.args));
    // There should not be any duplicate call data blobs within this array. If there are there is likely an error.
    callData = [...new Set(callData)];
    this.logger.debug({
      at: "MultiCallerClient",
      message: "Made bundle",
      target: getTarget(target.address),
      callData,
    });

    // This will either succeed and return the the transaction or throw an error.
    return runTransaction(this.logger, target, "multicall", [callData]);
  }
}
