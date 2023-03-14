import { DEFAULT_MULTICALL_CHUNK_SIZE, DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE } from "../common";
import {
  assert,
  winston,
  getNetworkName,
  isPromiseFulfilled,
  isPromiseRejected,
  getTarget,
  TransactionResponse,
  TransactionSimulationResult,
  Contract,
  Wallet,
} from "../utils";
import { AugmentedTransaction, TransactionClient } from "./TransactionClient";
import lodash from "lodash";
import { getAbi } from "@uma/contracts-node";

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

export const multicall3Addresses = {
  1: "0xcA11bde05977b3631167028862bE2a173976CA11",
  10: "0xcA11bde05977b3631167028862bE2a173976CA11",
  137: "0xcA11bde05977b3631167028862bE2a173976CA11",
  288: "0xcA11bde05977b3631167028862bE2a173976CA11",
  42161: "0xcA11bde05977b3631167028862bE2a173976CA11",
};

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

  // Adds all information associated with a transaction to the transaction queue.
  enqueueTransaction(txn: AugmentedTransaction) {
    // Value transactions are sorted immediately because the UMA multicall implementation rejects them.
    const txnQueue = txn.value && txn.value.gt(0) ? this.valueTxns : this.txns;
    if (txnQueue[txn.chainId] === undefined) txnQueue[txn.chainId] = [];
    txnQueue[txn.chainId].push(txn);
  }

  transactionCount() {
    return Object.values(this.txns)
      .concat(Object.values(this.valueTxns))
      .reduce((count, txnQueue) => (count += txnQueue.length), 0);
  }

  clearTransactionQueue(chainId: number = null) {
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
  async executeTxnQueues(simulate = false): Promise<{ [chainId: number]: string[] }> {
    const chainIds = [...new Set(Object.keys(this.valueTxns).concat(Object.keys(this.txns)))];

    // One promise per chain for parallel execution.
    const results = await Promise.allSettled(
      chainIds.map((_chainId) => {
        const chainId = Number(_chainId);
        const txns: AugmentedTransaction[] | undefined = this.txns[chainId];
        const valueTxns: AugmentedTransaction[] | undefined = this.valueTxns[chainId];

        this.clearTransactionQueue(chainId);
        return this.executeChainTxnQueue(chainId, txns, valueTxns, simulate);
      })
    );

    // Collate the results for each chain.
    const txnHashes: { [chainId: number]: string[] } = Object.fromEntries(
      results.map((result, idx) => {
        const chainId = chainIds[idx];
        if (isPromiseFulfilled(result)) return [chainId, result.value.map((txnResponse) => txnResponse.hash)];
        assert(isPromiseRejected(result), `Unexpected multicall result status: ${result?.status ?? "unknown"}`);
        return [chainId, [result.reason]];
      })
    );

    return txnHashes;
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
    if (nTxns === 0) return [];

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

    if (simulate) {
      let mrkdwn = "";
      const successfulTxns = _valueTxns.concat(_txns);
      successfulTxns.forEach((txn, idx) => {
        mrkdwn += `  *${idx + 1}. ${txn.message || "No message"}: ${txn.mrkdwn || "No markdown"}\n`;
      });
      this.logger.info({
        at: "MultiCallerClient#executeTxnQueue",
        message: `${successfulTxns.length}/${nTxns} ${networkName} transaction simulation(s) succeeded!`,
        mrkdwn,
      });
      this.logger.info({ at: "MulticallerClient#executeTxnQueue", message: "Exiting simulation mode 🎮" });
      return [];
    }

    // Generate the complete set of txns to submit to the network. Anything that failed simulation is dropped.
    const txnRequests: AugmentedTransaction[] = _valueTxns.concat(
      this.buildMultiCallBundles(_txns, this.chunkSize[chainId])
    );

    const txnResponses: TransactionResponse[] =
      txnRequests.length > 0 ? await this.txnClient.submit(chainId, txnRequests) : [];

    return txnResponses;
  }

  getMultisender(chainId: number): Contract {
    if (!multicall3Addresses[chainId]) throw new Error(`Multisender contract not deployed on network ${chainId}`);
    if (!this.baseSigner) throw new Error("Base signer not set");
    return new Contract(multicall3Addresses[chainId], getAbi("Multicall2"), this.baseSigner);
  }

  buildMultiSenderBundle(transactions: AugmentedTransaction[]): AugmentedTransaction {
    // Validate all transactions have the same chainId and can be sent from multisender.
    const { chainId } = transactions[0];
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
    let callData = transactions.map((txn, idx) => {
      mrkdwn.push(`\n  *txn. ${idx + 1}:* ${txn.message ?? "No message"}: ${txn.mrkdwn ?? "No markdown"}`);
      return {
        target: txn.contract.address,
        callData: txn.contract.interface.encodeFunctionData(txn.method, txn.args),
      };
    });

    // There should not be any duplicate call data blobs within this array. If there are there is likely an error.
    callData = [...new Set(callData)];
    const multisender = this.getMultisender(chainId);
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
      args: callData,
      message: "Across multicall transaction",
      mrkdwn: mrkdwn.join(""),
    } as AugmentedTransaction;
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

  buildMultiCallBundles(
    txns: AugmentedTransaction[],
    chunkSize = DEFAULT_MULTICALL_CHUNK_SIZE
  ): AugmentedTransaction[] {
    // We can support sending multiple transactions to different contracts via an external multisender
    // contract.
    const multicallerTxnChunks = lodash.chunk(
      txns.filter((txn) => !txn.unpermissioned),
      chunkSize
    );
    const multicallerTxnBundle = multicallerTxnChunks.map((txnChunk) => {
      // Don't wrap single transactions in a multicall.
      return txnChunk.length > 1 ? this.buildMultiCallBundle(txnChunk) : txnChunk[0];
    });
    const multisenderTxnChunks = lodash.chunk(
      txns.filter((txn) => txn.unpermissioned),
      chunkSize
    );
    const multisenderTxnBundle = multisenderTxnChunks.map((txnChunk) => {
      // Don't wrap single transactions in a multicall.
      return txnChunk.length > 1 ? this.buildMultiSenderBundle(txnChunk) : txnChunk[0];
    });
    return [...multicallerTxnBundle, ...multisenderTxnBundle];
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
