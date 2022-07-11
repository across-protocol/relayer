import {
  winston,
  getNetworkName,
  assign,
  Contract,
  runTransaction,
  getTarget,
  BigNumber,
  willSucceed,
  etherscanLink,
  TransactionResponse,
} from "../utils";

import lodash from "lodash";

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
      const _transactionsSucceed = await Promise.all(
        this.transactions.map((transaction: AugmentedTransaction) => willSucceed(transaction))
      );

      // Filter out transactions that revert for expected reasons. For example, the "relay filled" error
      // will occur frequently if there are multiple relayers running at the same time because only one relay
      // can go through. This is a non critical error we can ignore to filter out the noise.
      this.logger.debug({
        at: "MultiCallerClient",
        message: `Filtering out ${
          _transactionsSucceed.filter((txn) => !txn.succeed && txn.reason === "relay filled").length
        } relay transactions that will fail because the relay has already been filled`,
        totalTransactions: _transactionsSucceed.length,
        relayFilledReverts: _transactionsSucceed.filter((txn) => !txn.succeed && txn.reason === "relay filled").length,
      });
      const transactionsSucceed = _transactionsSucceed.filter(
        (transaction) => transaction.succeed || transaction.reason !== "relay filled"
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

      const chunkedTransactions: { [networkId: number]: AugmentedTransaction[][] } = Object.fromEntries(
        Object.entries(groupedTransactions).map(([chainId, transactions]) => [chainId, lodash.chunk(transactions, 100)])
      );

      if (simulationModeOn) {
        this.logger.debug({
          at: "MultiCallerClient",
          message: "All transactions will succeed! Logging markdown messages.",
        });
        let mrkdwn = "";
        valueTransactions.forEach((transaction, i) => {
          mrkdwn += "*Transaction excluded from batches because it contained value:*\n";
          mrkdwn += `  ${i + 1}. ${transaction.message || "0 message"}: ` + `${transaction.mrkdwn || "0 mrkdwn"}\n`;
        });
        Object.keys(chunkedTransactions).forEach((chainId) => {
          mrkdwn += `*Transactions sent in batch on ${getNetworkName(chainId)}:*\n`;
          chunkedTransactions[chainId].forEach((chunk, groupIndex) => {
            chunk.forEach((transaction, chunkTxIndex) => {
              mrkdwn +=
                `  ${groupIndex + 1}-${chunkTxIndex + 1}. ${transaction.message || "0 message"}: ` +
                `${transaction.mrkdwn || "0 mrkdwn"}\n`;
            });
          });
        });
        this.logger.info({ at: "MultiCallerClient", message: "Exiting simulation mode 🎮", mrkdwn });
        this.clearTransactionQueue();
        return;
      }

      const groupedValueTransactions: { [networkId: number]: AugmentedTransaction[] } = {};
      for (const transaction of valueTransactions) {
        assign(groupedValueTransactions, [transaction.chainId], [transaction]);
      }

      this.logger.debug({
        at: "MultiCallerClient",
        message: "Executing transactions with msg.value excluded from batches by target chain",
        txs: Object.keys(groupedValueTransactions).map((chainId) => ({
          chainId,
          num: groupedValueTransactions[chainId].length,
        })),
      });

      // Construct multiCall transaction for each target chain.
      const valueTransactionsResult = await Promise.allSettled(
        valueTransactions.map(async (transaction): Promise<TransactionResponse> => {
          return await runTransaction(
            this.logger,
            transaction.contract,
            transaction.method,
            transaction.args,
            transaction.value
          );
        })
      );

      this.logger.debug({
        at: "MultiCallerClient",
        message: "Executing transactions grouped by target chain",
        txs: Object.keys(groupedTransactions).map((chainId) => ({ chainId, num: groupedTransactions[chainId].length })),
      });

      // Construct multiCall transaction for each target chain.
      const multiCallTransactionsResult = await Promise.allSettled(
        Object.keys(chunkedTransactions)
          .map((chainId) => chunkedTransactions[chainId].map((chunk) => this.buildMultiCallBundle(chunk)))
          .flat()
      );

      // Each element in the bundle of receipts relates back to each set within the groupedTransactions. Produce log.
      let mrkdwn = "";
      const transactionHashes = [];
      valueTransactionsResult.forEach((result, i) => {
        const { chainId } = valueTransactions[i];
        mrkdwn += "*Transaction excluded from batches because it contained value:*\n";
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
          const transactionHash = result.value.hash;
          mrkdwn += "tx: " + etherscanLink(transactionHash, chainId) + "\n";
          transactionHashes.push(transactionHash);
        }
      });
      let flatIndex = 0;
      Object.keys(chunkedTransactions).forEach((chainId) => {
        mrkdwn += `*Transactions sent in batch on ${getNetworkName(chainId)}:*\n`;
        chunkedTransactions[chainId].forEach((chunk, chunkIndex) => {
          const settledPromise = multiCallTransactionsResult[flatIndex++];
          if (settledPromise.status === "rejected") {
            const rejectionError = (settledPromise as PromiseRejectedResult).reason;
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
            chunk.forEach((transaction, groupTxIndex) => {
              mrkdwn +=
                `  ${chunkIndex + 1}-${groupTxIndex + 1}. ${transaction.message || ""}: ` +
                `${transaction.mrkdwn || ""}\n`;
            });
            const transactionHash = (settledPromise as PromiseFulfilledResult<any>).value.hash;
            mrkdwn += "tx: " + etherscanLink(transactionHash, chainId) + "\n";
            transactionHashes.push(transactionHash);
          }
        });
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
