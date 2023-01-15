import { DEFAULT_MULTICALL_CHUNK_SIZE, DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE } from "../common";
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
  private newMulticaller = false;
  protected txns: { [chainId: number]: AugmentedTransaction[] } = {};
  protected valueTxns: { [chainId: number]: AugmentedTransaction[] } = {};
  // eslint-disable-next-line no-useless-constructor
  // Legacy mode is a temporary feature to support transition to the updated multicaller implementation.
  constructor(
    readonly logger: winston.Logger,
    readonly chunkSize: { [chainId: number]: number } = DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE
  ) {}

  // Adds all information associated with a transaction to the transaction queue.
  enqueueTransaction(txn: AugmentedTransaction) {
    // Value transactions are sorted immediately because the UMA multicall implementation rejects them.
    const txnQueue = txn.value && txn.value.gt(0) ? this.valueTxns : this.txns;
    if (txnQueue[txn.chainId] === undefined) txnQueue[txn.chainId] = [];
    txnQueue[txn.chainId].push(txn);
  }

  transactionCount() {
    let nTxns = 0;
    Object.values(this.txns).forEach((txnQueue) => (nTxns += txnQueue.length));
    Object.values(this.valueTxns).forEach((txnQueue) => (nTxns += txnQueue.length));
    return nTxns;
  }

  clearTransactionQueue(chainId: number = null) {
    if (chainId) {
      this.txns[chainId] = [];
      this.valueTxns[chainId] = [];
    } else {
      this.txns = {};
      this.valueTxns = {};
    }
  }

  async executeTransactionQueue(simulate = false): Promise<string[]> {
    // For compatibility with the existing implementation, flatten all txn hashes into a single array.
    // To be resolved once the legacy implementation is removed and the callers have been updated.
    const txnHashes: { [chainId: number]: string[] } = await this.executeTxnQueues(simulate);
    return Array.from(Object.values(txnHashes)).flat();
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
          return (this.txns[chainId] ?? []).length > 0 || (this.valueTxns[chainId] ?? []).length > 0;
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
        switch (result.status) {
          case "fulfilled":
            return [chainId, result.value.map((txnResponse) => txnResponse.hash)];
          case "rejected":
            return [chainId, result.reason];
          default: // Should never occur; log if it ever does.
            this.logger.warn({
              at: "MultiCallerClient#executeTxnQueues",
              message: "Unexpected transaction queue resulting status.",
              result,
            });
            return [chainId, "Unknown error"];
        }
      })
    );

    return txnHashes;
  }

  // For a single chain, simulate all potential multicall txns and group the ones that pass into multicall bundles.
  // Then, submit a concatenated list of value txns + multicall bundles. Flush the existing queues on completion.
  async executeChainTxnQueue(chainId: number, simulate = false): Promise<TransactionResponse[]> {
    const multicallTxns: AugmentedTransaction[] = (this.txns[chainId].length > 0)
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

    const txns = await this.simulateTransactionQueue(txnQueue);
    if (txns.length === 0) {
      this.logger.debug({
        at: "MultiCallerClient#executeTxnQueue",
        message: `No valid transactions in the ${networkName} queue.`,
      });
      return [];
    }

    if (simulate) {
      let mrkdwn = "";
      txns.forEach((txn, idx) => {
        mrkdwn += `  *${idx + 1}*. ${txn.message || "No message"}: ${txn.mrkdwn || "No markdown"}\n`;
      });
      this.logger.info({
        at: "MultiCallerClient#executeTxnQueue",
        message: `${txns.length} ${networkName} transaction simulation(s) succeeded!`,
        mrkdwn,
      });
      this.logger.info({ at: "MulticallerClient#executeTxnQueue", message: "Exiting simulation mode 🎮" });
      return [];
    }

    return await this.submitTxns(chainId, txns);
  }

  protected async submitTxn(txn: AugmentedTransaction, nonce: number | null = null): Promise<TransactionResponse> {
    const { contract, method, args, value } = txn;
    return await runTransaction(this.logger, contract, method, args, value, null, nonce);
  }

  private async submitTxns(chainId: number, txnQueue: AugmentedTransaction[]): Promise<TransactionResponse[]> {
    const networkName = getNetworkName(chainId);
    const txnResponses: TransactionResponse[] = [];

    this.logger.debug({
      at: "MultiCallerClient#submitTxns",
      message: "Processing transaction queue.",
      txnQueue,
    });

    // Transactions are submitted sequentially to avoid nonce collisions. More
    // advanced nonce management may permit them to be submitted in parallel.
    let mrkdwn = "";
    let idx = 1;
    let nonce: number = null;
    for (const txn of txnQueue) {
      let response: TransactionResponse;
      if (nonce !== null) this.logger.debug({ at: "MultiCallerClient#submitTxns", message: `Using nonce ${nonce}.` });

      try {
        response = await this.submitTxn(txn, nonce);
      } catch (error) {
        this.logger.info({
          at: "MultiCallerClient#submitTxns",
          message: `Transaction ${idx} submission on ${networkName} failed or timed out.`,
          mrkdwn,
          error,
          notificationPath: "across-error",
        });
        return txnResponses;
      }

      nonce = response.nonce + 1;
      mrkdwn += `  ${idx}. ${txn.message || "No message"}: ${txn.mrkdwn || "No markdown"}\n`;
      mrkdwn += `  *Block Explorer:* ${etherscanLink(response.hash, txn.chainId)}\n`;
      txnResponses.push(response);
      ++idx;
    }

    this.logger.info({
      at: "MultiCallerClient#submitTxns",
      message: `Completed ${networkName} transaction submission! 🧙`,
      mrkdwn,
    });

    return txnResponses;
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

  protected async simulateTxn(txn: AugmentedTransaction): Promise<TransactionSimulationResult> {
    return await willSucceed(txn);
  }

  async buildMultiCallBundles(
    txns: AugmentedTransaction[],
    chunkSize = DEFAULT_MULTICALL_CHUNK_SIZE
  ): Promise<AugmentedTransaction[]> {
    const txnChunks: AugmentedTransaction[][] = await lodash.chunk(
      await this.simulateTransactionQueue(txns),
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
    const txnSimulations = await Promise.all(
      transactions.map((transaction: AugmentedTransaction) => this.simulateTxn(transaction))
    );

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
