import { DEFAULT_MULTICALL_CHUNK_SIZE, DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE } from "../common";
import {
  winston,
  getNetworkName,
  Contract,
  isPromiseFulfilled,
  isPromiseRejected,
  runTransaction,
  getTarget,
  BigNumber,
  willSucceed,
  etherscanLink,
  TransactionResponse,
  TransactionSimulationResult,
} from "../utils";
import { AugmentedTransaction, TransactionClient } from "./TransactionClient";
import lodash from "lodash";

// @todo: MultiCallerClient should be generic. For future, permit the class instantiator to supply their own
// set of known failures that can be suppressed/ignored.
// Use this list of Smart Contract revert reasons to filter out transactions that revert in the
// Multicaller client's simulations but that we can ignore. Check for exact revert reason instead of using
// .includes() to partially match reason string in order to not ignore errors thrown by non-contract reverts.
// For example, a NodeJS error might result in a reason string that includes more than just the contract r
// evert reason.
export const knownRevertReasons = new Set(["relay filled", "Already claimed"]);

// The following reason potentially includes false positives of reverts that we should be alerted on, however
// there is something likely broken in how the provider is interpreting contract reverts. Currently, there are
// a lot of duplicate transaction sends that are reverting with this reason, for example, sending a transaction
// to execute a relayer refund leaf takes a while to execute and ends up reverting because a duplicate transaction
// mines before it. This situation leads to this revert reason which is spamming the Logger currently.
export const unknownRevertReason =
  "missing revert data in call exception; Transaction reverted without a reason string";
export const unknownRevertReasonMethodsToIgnore = new Set([
  "fillRelay",
  "fillRelayWithUpdatedFee",
  "executeSlowRelayLeaf",
  "executeRelayerRefundLeaf",
  "executeRootBundle",
]);

export class MultiCallerClient {
  private transactions: AugmentedTransaction[] = [];
  private newMulticaller = false;
  private txnClient: TransactionClient;
  protected txns: { [chainId: number]: AugmentedTransaction[] } = {};
  protected valueTxns: { [chainId: number]: AugmentedTransaction[] } = {};
  // Legacy mode is a temporary feature to support transition to the updated multicaller implementation.
  constructor(
    readonly logger: winston.Logger,
    readonly chunkSize: { [chainId: number]: number } = DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE,
    newMulticaller = false
  ) {
    this.newMulticaller = newMulticaller || process.env.NEW_MULTICALLER === "true";
    this.txnClient = new TransactionClient(logger);
  }

  // Adds all information associated with a transaction to the transaction queue.
  enqueueTransaction(txn: AugmentedTransaction) {
    if (this.newMulticaller) {
      // Value transactions are sorted immediately because the UMA multicall implementation rejects them.
      const txnQueue = txn.value && txn.value.gt(0) ? this.valueTxns : this.txns;
      if (txnQueue[txn.chainId] === undefined) txnQueue[txn.chainId] = [];
      txnQueue[txn.chainId].push(txn);
    } else this.transactions.push(txn);
  }

  transactionCount() {
    let nTxns = this.transactions.length;
    Object.values(this.txns).forEach((txnQueue) => (nTxns += txnQueue.length));
    Object.values(this.valueTxns).forEach((txnQueue) => (nTxns += txnQueue.length));
    return nTxns;
  }

  clearTransactionQueue(chainId: number = null) {
    if (this.newMulticaller) {
      if (chainId) {
        this.txns[chainId] = [];
        this.valueTxns[chainId] = [];
      } else {
        this.txns = {};
        this.valueTxns = {};
      }
    } else this.transactions = [];
  }

  async executeTransactionQueue(simulate = false): Promise<string[]> {
    if (this.newMulticaller) {
      // For compatibility with the existing implementation, flatten all txn hashes into a single array.
      // To be resolved once the legacy implementation is removed and the callers have been updated.
      const txnHashes: { [chainId: number]: string[] } = await this.executeTxnQueues(simulate);
      return Array.from(Object.values(txnHashes)).flat();
    }

    return this.executeTxnQueueLegacy(simulate);
  }

  // For each chain, collate the enqueued transactions and process them in parallel.
  async executeTxnQueues(simulate = false): Promise<{ [chainId: number]: string[] }> {
    // @todo: This feels like a bodge...Find a better way to produce the set of chainIds that have enqueued txns.
    const chainIds = [...new Set(Object.keys(this.valueTxns).concat(Object.keys(this.txns)))];

    // One promise per chain for parallel execution.
    const results = await Promise.allSettled(
      chainIds
        .filter((_chainId) => {
          const chainId = Number(_chainId);
          return this.txns[chainId]?.length > 0 || this.valueTxns[chainId]?.length > 0;
        })
        .map((_chainId) => {
          const chainId = Number(_chainId);
          return this.executeChainTxnQueue(chainId, simulate);
        })
    );

    // Collate the results for each chain.
    const txnHashes: { [chainId: number]: string[] } = Object.fromEntries(
      results.map((result, idx) => {
        const chainId = chainIds[idx];
        if (isPromiseFulfilled(result)) return [chainId, result.value.map((txnResponse) => txnResponse.hash)];
        else if (isPromiseRejected(result)) return [chainId, [result.reason]];

        this.logger.warn({
          at: "MultiCallerClient#executeTxnQueues",
          message: "Unexpected transaction queue resulting status.",
          result,
        });
        return [chainId, ["Unknown error"]];
      })
    );

    return txnHashes;
  }

  // For a single chain, simulate all potential multicall txns and group the ones that pass into multicall bundles.
  // Then, submit a concatenated list of value txns + multicall bundles. Flush the existing queues on completion.
  async executeChainTxnQueue(chainId: number, simulate = false): Promise<TransactionResponse[]> {
    const multicallTxns: AugmentedTransaction[] =
      this.txns[chainId]?.length > 0
        ? await this.buildMultiCallBundles(this.txns[chainId], this.chunkSize[chainId])
        : [];

    // Concatenate the new multicall txns onto any existing value txns and pass the queue off for submission.
    const txnResponses: TransactionResponse[] = await this.executeTxnQueue(
      chainId,
      (this.valueTxns[chainId] ?? []).concat(multicallTxns),
      simulate
    );

    // Flush out the currently enqueued transactions (for this chain only). Note that this is not async-safe; if the
    // caller has enqueued additional transactions whilst awaiting executeTransactionQueue() then those will be lost.
    this.clearTransactionQueue(chainId);

    return txnResponses;
  }

  // @todo: Consider adding a "wait" argument to wait for n txn confirmations per txn.
  private async executeTxnQueue(
    chainId: number,
    txnQueue: AugmentedTransaction[],
    simulate = false
  ): Promise<TransactionResponse[]> {
    const networkName = getNetworkName(chainId);

    this.logger.debug({
      at: "MultiCallerClient#executeTxnQueue",
      message: `${simulate ? "Simulating" : "Executing"} ${txnQueue.length} transaction(s) on ${networkName}.`,
      txnQueue,
    });

    const results = await this.txnClient.simulate(txnQueue);
    const txns = results.filter((result) => result.succeed).map((result) => result.transaction);

    if (simulate) {
      let mrkdwn = "";
      results.forEach((result, idx) => {
        const { succeed, transaction: txn } = result;
        mrkdwn += `  *${idx + 1}. (${succeed} ? "Passed" : "Failed"})`;
        mrkdwn += ` ${txn.message || "No message"}: ${txn.mrkdwn || "No markdown"}\n`;
      });
      this.logger.info({
        at: "MultiCallerClient#executeTxnQueue",
        message: `${txns.length}/${results.length} ${networkName} transaction simulation(s) succeeded!`,
        mrkdwn,
      });
      this.logger.info({ at: "MulticallerClient#executeTxnQueue", message: "Exiting simulation mode 🎮" });
      return [];
    }

    if (txns.length === 0) {
      this.logger.debug({
        at: "MultiCallerClient#executeTxnQueue",
        message: `No valid transactions in the ${networkName} queue.`,
      });
      return [];
    }

    return await this.txnClient.submit(chainId, txns);
  }

  // @todo: Remove this method part of legacy cleanup
  async executeTxnQueueLegacy(simulationModeOn = false): Promise<string[]> {
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
          const chunkSize: number = this.chunkSize[chainId] || DEFAULT_MULTICALL_CHUNK_SIZE;
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

  // @todo: Remove this method part of legacy cleanup
  protected async submitTxn(txn: AugmentedTransaction, nonce: number | null = null): Promise<TransactionResponse> {
    const { contract, method, args, value } = txn;
    return await runTransaction(this.logger, contract, method, args, value, null, nonce);
  }

  buildMultiCallBundle(transactions: AugmentedTransaction[]): AugmentedTransaction {
    // Validate all transactions have the same chainId and target contract.
    const { chainId, contract } = transactions[0];
    if (transactions.some((tx) => tx.contract.address !== contract.address || tx.chainId !== chainId)) {
      this.logger.error({
        at: "MultiCallerClient#buildMultiCallBundle",
        message: "Some transactions in the queue contain different target chain or contract address",
        transactions: transactions.map(({ contract, chainId }) => {
          return { target: getTarget(contract.address), chainId };
        }),
        notificationPath: "across-error",
      });
      throw new Error("Multicall bundle data mismatch");
    }

    const mrkdwn: string[] = [];
    let callData = transactions.map((txn, idx) => {
      mrkdwn.push(`\n  *txn. ${idx + 1}:* ${txn.mrkdwn}`);
      return txn.contract.interface.encodeFunctionData(txn.method, txn.args);
    });

    // There should not be any duplicate call data blobs within this array. If there are there is likely an error.
    callData = [...new Set(callData)];
    this.logger.debug({
      at: "MultiCallerClient",
      message: `Made multicall bundle for ${getNetworkName(chainId)}.`,
      target: getTarget(contract.address),
      callData,
    });

    return {
      chainId,
      contract,
      method: "multicall",
      args: [callData],
      message: "Across multicall transaction",
      mrkdwn: mrkdwn.join(""),
    } as AugmentedTransaction;
  }

  async buildMultiCallBundles(
    txns: AugmentedTransaction[],
    chunkSize = DEFAULT_MULTICALL_CHUNK_SIZE
  ): Promise<AugmentedTransaction[]> {
    // Enqueued multicall txns that fail simulation are silently dropped.
    const txnChunks: AugmentedTransaction[][] = await lodash.chunk(
      (await this.txnClient.simulate(txns)).filter((txn) => txn.succeed).map((txn) => txn.transaction),
      chunkSize
    );

    return txnChunks.map((txnChunk: AugmentedTransaction[]) => {
      // Don't wrap single transactions in a multicall.
      return txnChunk.length > 1 ? this.buildMultiCallBundle(txnChunk) : txnChunk[0];
    });
  }

  async simulateTransactionQueue(transactions: AugmentedTransaction[]): Promise<AugmentedTransaction[]> {
    const validTxns: AugmentedTransaction[] = [];
    const invalidTxns: TransactionSimulationResult[] = [];

    // Simulate the transaction execution for the whole queue.
    const txnSimulations = await this.txnClient.simulate(transactions);
    txnSimulations.forEach((txn) => {
      if (txn.succeed) validTxns.push(txn.transaction);
      else invalidTxns.push(txn);
    });
    if (invalidTxns.length > 0) this.logSimulationFailures(invalidTxns);

    return validTxns;
  }

  // Ignore the general unknown revert reason for specific methods or uniformly ignore specific revert reasons for any
  // contract method. Note: Check for exact revert reason instead of using .includes() to partially match reason string
  // in order to not ignore errors thrown by non-contract reverts. For example, a NodeJS error might result in a reason
  // string that includes more than just the contract revert reason.
  protected canIgnoreRevertReason(txn: TransactionSimulationResult): boolean {
    // prettier-ignore
    return (
      !txn.succeed && (
        knownRevertReasons.has(txn.reason) ||
        (unknownRevertReasonMethodsToIgnore.has(txn.transaction.method) && txn.reason === unknownRevertReason)
      )
    );
  }

  // Filter out transactions that revert for non-critical, expected reasons. For example, the "relay filled" error may
  // will occur frequently if there are multiple relayers running at the same time. Similarly, the "already claimed"
  // error will occur if there are overlapping dataworker executor runs.
  // @todo: Figure out a less hacky way to reduce these errors rather than ignoring them.
  // @todo: Consider logging key txn information with the failures?
  protected logSimulationFailures(failures: TransactionSimulationResult[]): void {
    const ignoredFailures: TransactionSimulationResult[] = [];
    const loggedFailures: TransactionSimulationResult[] = [];

    failures.forEach((failure) => {
      (this.canIgnoreRevertReason(failure) ? ignoredFailures : loggedFailures).push(failure);
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
