import { DEFAULT_MULTICALL_CHUNK_SIZE, CHAIN_MULTICALL_CHUNK_SIZE } from "../common";
import {
  winston,
  getNetworkName,
  Contract,
  runTransaction,
  getTarget,
  BigNumber,
  willSucceed,
  etherscanLink,
  TransactionResponse,
  TransactionSimulationResult,
} from "../utils";

import lodash from "lodash";

export interface AugmentedTransaction {
  contract: Contract;
  chainId: number;
  method: string;
  args: any[];
  message: string;
  mrkdwn: string;
  value?: BigNumber;
}

// Use this list of Smart Contract revert reasons to filter out transactions that revert in the
// Multicaller client's simulations but that we can ignore. Check for exact revert reason instead of using
// .includes() to partially match reason string in order to not ignore errors thrown by non-contract reverts.
// For example, a NodeJS error might result in a reason string that includes more than just the contract r
// evert reason.
const knownRevertReasons = new Set(["relay filled", "Already claimed"]);

// The following reason potentially includes false positives of reverts that we should be alerted on, however
// there is something likely broken in how the provider is interpreting contract reverts. Currently, there are
// a lot of duplicate transaction sends that are reverting with this reason, for example, sending a transaction
// to execute a relayer refund leaf takes a while to execute and ends up reverting because a duplicate transaction
// mines before it. This situation leads to this revert reason which is spamming the Logger currently.
const unknownRevertReason = "missing revert data in call exception; Transaction reverted without a reason string";
const unknownRevertReasonMethodsToIgnore = new Set([
  "fillRelay",
  "fillRelayWithUpdatedFee",
  "executeSlowRelayLeaf",
  "executeRelayerRefundLeaf",
  "executeRootBundle",
]);

// Ignore the general unknown revert reason for specific methods or uniformly ignore specific revert reasons for any
// contract method. Note: Check for exact revert reason instead of using .includes() to partially match reason string
// in order to not ignore errors thrown by non-contract reverts. For example, a NodeJS error might result in a reason
// string that includes more than just the contract revert reason.
const canIgnoreRevertReasons = (obj: TransactionSimulationResult): boolean => {
  // prettier-ignore
  return (
    !obj.succeed && (
      knownRevertReasons.has(obj.reason) ||
      (unknownRevertReasonMethodsToIgnore.has(obj.transaction.method) && obj.reason === unknownRevertReason)
    )
  );
};

export class MultiCallerClient {
  private transactions: AugmentedTransaction[] = [];
  // eslint-disable-next-line no-useless-constructor
  constructor(readonly logger: winston.Logger) {}

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

  async executeTransactionQueue(simulationModeOn = false): Promise<string[]> {
    if (this.transactions.length === 0) return [];
    this.logger.debug({
      at: "MultiCallerClient",
      message: "Executing tx bundle",
      number: this.transactions.length,
      simulationModeOn,
    });

    try {
      const transactions = await this.simulateTransactionQueue(this.transactions);
      if (transactions.length === 0) {
        this.logger.debug({ at: "MultiCallerClient", message: "No valid transactions in the queue." });
        return [];
      }

      const valueTransactions = transactions.filter((transaction) => transaction.value && transaction.value.gt(0));
      const nonValueTransactions = transactions.filter((transaction) => !transaction.value || transaction.value.eq(0));

      // Group by target chain. Note that there is NO grouping by target contract. The relayer will only ever use this
      // MultiCallerClient to send multiple transactions to one target contract on a given target chain and so we dont
      // need to group by target contract. This can be further refactored with another group by if this is needed.
      const groupedTransactions: { [chainId: number]: AugmentedTransaction[] } = lodash.groupBy(
        nonValueTransactions,
        "chainId"
      );

      const chunkedTransactions: { [chainId: number]: AugmentedTransaction[][] } = Object.fromEntries(
        Object.entries(groupedTransactions).map(([_chainId, transactions]) => {
          const chainId = Number(_chainId);
          const chunkSize: number = CHAIN_MULTICALL_CHUNK_SIZE[chainId] || DEFAULT_MULTICALL_CHUNK_SIZE;
          if (transactions.length > chunkSize) {
            const dropped: Array<{ address: string; method: string; args: any[] }> = transactions
              .slice(chunkSize)
              .map((txn) => {
                return { address: txn.contract.address, method: txn.method, args: txn.args };
              });
            this.logger.info({
              at: "MultiCallerClient#chunkedTransactions",
              message: `Dropping ${dropped.length} transactions on chain ${chainId}.`,
              dropped,
            });
          }
          // Multi-chunks not attempted due to nonce reuse complications, but may return in future.
          return [chainId, [transactions.slice(0, chunkSize)]];
        })
      );

      if (simulationModeOn) {
        this.logger.debug({
          at: "MultiCallerClient",
          message: "All transactions will succeed! Logging markdown messages.",
        });
        let mrkdwn = "";
        valueTransactions.forEach((transaction, i) => {
          mrkdwn += "*Transaction excluded from batches because it contained value:*\n";
          mrkdwn += `  ${i + 1}. ${transaction.message || "0 message"}: ${transaction.mrkdwn || "0 mrkdwn"}\n`;
        });
        Object.entries(chunkedTransactions).forEach(([_chainId, transactions]) => {
          const chainId = Number(_chainId);
          mrkdwn += `*Transactions sent in batch on ${getNetworkName(chainId)}:*\n`;
          transactions.forEach((chunk, groupIndex) => {
            chunk.forEach((transaction, chunkTxIndex) => {
              mrkdwn +=
                `  ${groupIndex + 1}-${chunkTxIndex + 1}. ${transaction.message || "0 message"}: ` +
                `${transaction.mrkdwn || "0 mrkdwn"}\n`;
            });
          });
        });
        this.logger.info({ at: "MultiCallerClient", message: "Exiting simulation mode 🎮", mrkdwn });
        this.clearTransactionQueue();
        return [];
      }

      const groupedValueTransactions: { [networkId: number]: AugmentedTransaction[] } = lodash.groupBy(
        valueTransactions,
        "chainId"
      );

      this.logger.debug({
        at: "MultiCallerClient",
        message: "Executing transactions with msg.value excluded from batches by target chain",
        txs: Object.entries(groupedValueTransactions).map(([chainId, transactions]) => ({
          chainId: Number(chainId),
          num: transactions.length,
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
        txs: Object.entries(chunkedTransactions).map(([chainId, txns]) => ({ chainId, num: txns.length })),
      });

      // Construct multiCall transaction for each target chain.
      const multiCallTransactionsResult = await Promise.allSettled(
        Object.values(chunkedTransactions)
          .map((transactions) => transactions.map((chunk) => this.submitTxn(this.buildMultiCallBundle(chunk))))
          .flat()
      );

      // Each element in the bundle of receipts relates back to each set within the groupedTransactions. Produce log.
      let mrkdwn = "";
      const transactionHashes: string[] = [];
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
      Object.entries(chunkedTransactions).forEach(([_chainId, transactions]) => {
        const chainId = Number(_chainId);
        mrkdwn += `*Transactions sent in batch on ${getNetworkName(chainId)}:*\n`;
        transactions.forEach((chunk, chunkIndex) => {
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
      this.logger.info({ at: "MultiCallerClient", message: "Multicall batch sent! 🧙", mrkdwn });
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

  protected async submitTxn(txn: AugmentedTransaction, nonce: number | null = null): Promise<TransactionResponse> {
    const { contract, method, args, value } = txn;
    return await runTransaction(this.logger, contract, method, args, value, null, nonce);
  }

  buildMultiCallBundle(transactions: AugmentedTransaction[]): AugmentedTransaction {
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
      throw new Error("Multicall bundle data mismatch");
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

    return {
      contract: target,
      method: "multicall",
      args: [callData],
    } as AugmentedTransaction;
  }

  protected async simulateTxn(txn: AugmentedTransaction): Promise<TransactionSimulationResult> {
    return await willSucceed(txn);
  }

  async simulateTransactionQueue(transactions: AugmentedTransaction[]): Promise<AugmentedTransaction[]> {
    const validTxns: AugmentedTransaction[] = [];
    const invalidTxns: TransactionSimulationResult[] = [];

    // Simulate the transaction execution for the whole queue.
    const txnSimulations = await Promise.all(
      transactions.map((transaction: AugmentedTransaction) => this.simulateTxn(transaction))
    );

    txnSimulations.forEach((txn) => {
      if (txn.succeed) validTxns.push(txn.transaction);
      else invalidTxns.push(txn);
    });
    this.logSimulationFailures(invalidTxns);

    return validTxns;
  }

  // Filter out transactions that revert for non-critical expected reasons. For example, the "relay filled" error will
  // will occur frequently if there are multiple relayers running at the same time. Similarly, the "already claimed"
  // error will occur if there are overlapping dataworker executor runs. These are non critical errors we can ignore to
  // filter out the noise.
  // @todo: Figure out a less hacky way to reduce these errors rather than ignoring them.
  // @todo: Consider logging key txn information with the failures?
  protected logSimulationFailures(failures: TransactionSimulationResult[]): void {
    const ignoredFailures: TransactionSimulationResult[] = [];
    const loggedFailures: TransactionSimulationResult[] = [];

    failures.forEach((failure) => {
      (canIgnoreRevertReasons(failure) ? ignoredFailures : loggedFailures).push(failure);
    });

    if (ignoredFailures.length > 0) {
      this.logger.debug({
        at: "MultiCallerClient#LogSimulationFailures",
        message: `Filtering out ${ignoredFailures.length} transactions with revert reasons we can ignore.`,
        revertReasons: ignoredFailures.map((txn) => txn.reason),
      });
    }

    // Log unexpected/noteworthy failures.
    if (loggedFailures.length > 0) {
      this.logger.error({
        at: "MultiCallerClient#LogSimulationFailures",
        message: `${loggedFailures.length} in the queue may revert!`,
        revertingTransactions: loggedFailures.map((txn) => {
          return {
            target: getTarget(txn.transaction.contract.address),
            args: txn.transaction.args,
            reason: txn.reason,
            message: txn.transaction.message,
            mrkdwn: txn.transaction.mrkdwn,
          };
        }),
        notificationPath: "across-error",
      });
    }
  }
}
