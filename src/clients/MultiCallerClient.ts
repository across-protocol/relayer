import { DEFAULT_MULTICALL_CHUNK_SIZE, DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE, Multicall2Call } from "../common";
import {
  winston,
  getNetworkName,
  isPromiseFulfilled,
  getTarget,
  TransactionResponse,
  TransactionSimulationResult,
  Contract,
  Wallet,
  getMultisender,
  getProvider,
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
  protected txnClient: TransactionClient;
  protected txns: { [chainId: number]: AugmentedTransaction[] } = {};
  protected valueTxns: { [chainId: number]: AugmentedTransaction[] } = {};
  constructor(
    readonly logger: winston.Logger,
    readonly chunkSize: { [chainId: number]: number } = DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE,
    readonly baseSigner?: Wallet
  ) {
    this.txnClient = new TransactionClient(logger);
  }

  getQueuedTransactions(chainId: number): AugmentedTransaction[] {
    const allTxns = [];
    if (this.valueTxns?.[chainId]) {
      allTxns.push(...this.valueTxns[chainId]);
    }
    if (this.txns?.[chainId]) {
      allTxns.push(...this.txns[chainId]);
    }
    return allTxns;
  }

  // Adds all information associated with a transaction to the transaction queue.
  enqueueTransaction(txn: AugmentedTransaction): void {
    // Value transactions are sorted immediately because the UMA multicall implementation rejects them.
    const txnQueue = txn.value && txn.value.gt(0) ? this.valueTxns : this.txns;
    if (txnQueue[txn.chainId] === undefined) {
      txnQueue[txn.chainId] = [];
    }
    txnQueue[txn.chainId].push(txn);
  }

  transactionCount(): number {
    return Object.values(this.txns)
      .concat(Object.values(this.valueTxns))
      .reduce((count, txnQueue) => (count += txnQueue.length), 0);
  }

  clearTransactionQueue(chainId: number | null = null): void {
    if (chainId !== null) {
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
    return Object.values(txnHashes).flat();
  }

  // For each chain, collate the enqueued transactions and process them in parallel.
  async executeTxnQueues(simulate = false): Promise<Record<number, string[]>> {
    const chainIds = [...new Set(Object.keys(this.valueTxns).concat(Object.keys(this.txns)))];

    // One promise per chain for parallel execution.
    const resultsByChain = await Promise.allSettled(
      chainIds.map((_chainId) => {
        const chainId = Number(_chainId);
        const txns: AugmentedTransaction[] | undefined = this.txns[chainId];
        const valueTxns: AugmentedTransaction[] | undefined = this.valueTxns[chainId];

        this.clearTransactionQueue(chainId);
        return this.executeChainTxnQueue(chainId, txns, valueTxns, simulate);
      })
    );

    // Collate the results for each chain.
    const txnHashes: Record<number, { result: string[]; isError: boolean }> = Object.fromEntries(
      resultsByChain.map((chainResult, idx) => {
        const chainId = chainIds[idx];
        if (isPromiseFulfilled(chainResult)) {
          return [chainId, { result: chainResult.value.map((txnResponse) => txnResponse.hash), isError: false }];
        } else {
          return [chainId, { result: chainResult.reason, isError: true }];
        }
      })
    );

    // We need to iterate over the results to determine if any of the transactions failed.
    // If any of the transactions failed, we need to log the results and throw an error. However, we want to
    // only log the results once, so we need to collate the results into a single object.
    const failedChains = Object.entries(txnHashes)
      .filter(([, { isError }]) => isError)
      .map(([chainId]) => chainId);
    if (failedChains.length > 0) {
      // Log the results.
      this.logger.error({
        at: "MultiCallerClient#executeTxnQueues",
        message: `Failed to execute ${failedChains.length} transaction(s) on chain(s) ${failedChains.join(", ")}`,
        error: failedChains.map((chainId) => txnHashes[chainId].result),
      });
      throw new Error(
        `Failed to execute ${failedChains.length} transaction(s) on chain(s) ${failedChains.join(
          ", "
        )}: ${JSON.stringify(txnHashes)}`
      );
    }
    // Recombine the results into a single object that match the legacy implementation.
    return Object.fromEntries(Object.entries(txnHashes).map(([chainId, { result }]) => [chainId, result]));
  }

  // For a single chain, simulate all potential multicall txns and group the ones that pass into multicall bundles.
  // Then, submit a concatenated list of value txns + multicall bundles. If simulation was requested, log the results
  // and return early.
  async executeChainTxnQueue(
    chainId: number,
    txns: AugmentedTransaction[] = [],
    valueTxns: AugmentedTransaction[] = [],
    simulate = false
  ): Promise<TransactionResponse[]> {
    const nTxns = txns.length + valueTxns.length;
    if (nTxns === 0) {
      return [];
    }

    const networkName = getNetworkName(chainId);
    this.logger.debug({
      at: "MultiCallerClient#executeTxnQueue",
      message: `${simulate ? "Simulating" : "Executing"} ${nTxns} transaction(s) on ${networkName}.`,
    });

    const txnSims = await Promise.allSettled([
      this.simulateTransactionQueue(txns),
      this.simulateTransactionQueue(valueTxns),
    ]);

    const [_txns, _valueTxns] = txnSims.map((result): AugmentedTransaction[] => {
      return isPromiseFulfilled(result) ? result.value : [];
    });

    // Generate the complete set of txns to submit to the network. Anything that failed simulation is dropped.
    const txnRequests: AugmentedTransaction[] = _valueTxns.concat(
      await this.buildMultiCallBundles(_txns, this.chunkSize[chainId])
    );

    if (simulate) {
      let mrkdwn = "";
      txnRequests.forEach((txn, idx) => {
        mrkdwn += `  *${idx + 1}. ${txn.message || "No message"}: ${txn.mrkdwn || "No markdown"}\n`;
      });
      this.logger.info({
        at: "MultiCallerClient#executeTxnQueue",
        message: `${txnRequests.length}/${nTxns} ${networkName} transaction simulation(s) succeeded!`,
        mrkdwn,
      });
      this.logger.info({ at: "MulticallerClient#executeTxnQueue", message: "Exiting simulation mode 🎮" });
      return [];
    }

    const txnResponses: TransactionResponse[] =
      txnRequests.length > 0 ? await this.txnClient.submit(chainId, txnRequests) : [];

    return txnResponses;
  }

  async _getMultisender(chainId: number): Promise<Contract | undefined> {
    return this.baseSigner ? getMultisender(chainId, this.baseSigner.connect(await getProvider(chainId))) : undefined;
  }

  async buildMultiSenderBundle(transactions: AugmentedTransaction[]): Promise<AugmentedTransaction> {
    // Validate all transactions have the same chainId and can be sent from multisender.
    const { chainId } = transactions[0];
    const multisender = await this._getMultisender(chainId);
    if (!multisender) {
      throw new Error("Multisender not available for this chain");
    }

    if (transactions.some((tx) => !tx.unpermissioned || tx.chainId !== chainId)) {
      this.logger.error({
        at: "MultiCallerClient#buildMultiSenderBundle",
        message: "Some transactions in the queue contain different target chain or are permissioned",
        transactions: transactions.map(({ contract, chainId, unpermissioned }) => {
          return { target: getTarget(contract.address), unpermissioned: Boolean(unpermissioned), chainId };
        }),
        notificationPath: "across-error",
      });
      throw new Error("Multisender bundle data mismatch");
    }

    const mrkdwn: string[] = [];
    const callData: Multicall2Call[] = transactions.map((txn, idx) => {
      mrkdwn.push(`\n  *txn. ${idx + 1}:* ${txn.message ?? "No message"}: ${txn.mrkdwn ?? "No markdown"}`);
      return {
        target: txn.contract.address,
        callData: txn.contract.interface.encodeFunctionData(txn.method, txn.args),
      };
    });

    this.logger.debug({
      at: "MultiCallerClient",
      message: `Made multisender bundle for ${getNetworkName(chainId)}.`,
      multisender: multisender.address,
      callData,
    });

    return {
      chainId,
      contract: multisender,
      method: "aggregate",
      args: [callData],
      message: "Across multicall transaction",
      mrkdwn: mrkdwn.join(""),
    } as AugmentedTransaction;
  }

  buildMultiCallBundle(transactions: AugmentedTransaction[]): AugmentedTransaction[] {
    // Split transactions by target contract if they are not all the same.
    const txnsGroupedByTarget = lodash.groupBy(transactions, (txn) => txn.contract.address);
    return Object.values(txnsGroupedByTarget).map((txns) => {
      return this._buildMultiCallBundle(txns);
    });
  }

  _buildMultiCallBundle(transactions: AugmentedTransaction[]): AugmentedTransaction {
    // Validate all transactions have the same chainId.
    const { chainId, contract } = transactions[0];
    if (transactions.some((tx) => tx.contract.address !== contract.address || tx.chainId !== chainId)) {
      this.logger.error({
        at: "MultiCallerClient#_buildMultiCallBundle",
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
      mrkdwn.push(`\n  *txn. ${idx + 1}:* ${txn.message ?? "No message"}: ${txn.mrkdwn ?? "No markdown"}`);
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
    if (txns.length === 0) {
      return [];
    }
    const { chainId } = txns[0];

    const {
      multicallerTxns = [],
      multisenderTxns = [],
      unsendableTxns = [],
    } = lodash.groupBy(txns, (txn) => {
      if (txn.unpermissioned) {
        return "multisenderTxns";
      } else if (txn.contract.multicall) {
        return "multicallerTxns";
      } else {
        return "unsendableTxns";
      }
    });

    // We should never get here but log any transactions that are sent to an ABI that doesn't have
    // multicall() and are not flagged to be sent to a Multisender.
    if (unsendableTxns.length > 0) {
      this.logger.error({
        at: "MultiCallerClient#buildMultiCallBundles",
        message: "Found transactions targeting a non-multicall and non-multisend contract!",
        unsendableTxns,
        notificationPath: "across-error",
      });
    }

    // If we can't construct multisender contract, then multicall everything. If any of the transactions
    // is for a contract that can't be multicalled, then this function will throw. This client should only be
    // used on contracts that extend Multicaller.
    if ((await this._getMultisender(chainId)) === undefined) {
      // Sort transactions by contract address so we can reduce chance that we need to split them again
      // to make Multicall work.
      const txnChunks = lodash.chunk(
        multicallerTxns.concat(multisenderTxns).sort((a, b) => a.contract.address.localeCompare(b.contract.address)),
        chunkSize
      );
      return txnChunks
        .map((txnChunk) => {
          // Don't wrap single transactions in a multicall.
          return txnChunk.length > 1 ? this.buildMultiCallBundle(txnChunk) : txnChunk[0];
        })
        .flat();
    } else {
      // We can support sending multiple transactions to different contracts via an external multisender
      // contract.
      const multicallerTxnChunks = lodash.chunk(
        multicallerTxns.sort((a, b) => a.contract.address.localeCompare(b.contract.address)),
        chunkSize
      );
      const multicallerTxnBundle = multicallerTxnChunks
        .map((txnChunk) => {
          return txnChunk.length > 1 ? this.buildMultiCallBundle(txnChunk) : txnChunk[0];
        })
        .flat();
      const multisenderTxnChunks = lodash.chunk(multisenderTxns, chunkSize);
      const multisenderTxnBundle = await Promise.all(
        multisenderTxnChunks.map(async (txnChunk) => {
          return txnChunk.length > 1 ? await this.buildMultiSenderBundle(txnChunk) : txnChunk[0];
        })
      );
      return [...multicallerTxnBundle, ...multisenderTxnBundle];
    }
  }

  async simulateTransactionQueue(transactions: AugmentedTransaction[]): Promise<AugmentedTransaction[]> {
    const validTxns: AugmentedTransaction[] = [];
    const invalidTxns: TransactionSimulationResult[] = [];

    // Simulate the transaction execution for the whole queue.
    const txnSimulations = await this.txnClient.simulate(transactions);
    txnSimulations.forEach((txn) => {
      if (txn.succeed) {
        validTxns.push(txn.transaction);
      } else {
        invalidTxns.push(txn);
      }
    });
    if (invalidTxns.length > 0) {
      this.logSimulationFailures(invalidTxns);
    }

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
