import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { BigNumber } from "ethers";
import { DEFAULT_MULTICALL_CHUNK_SIZE, DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE, Multicall2Call } from "../common";
import {
  winston,
  bnZero,
  getNetworkName,
  isDefined,
  isPromiseFulfilled,
  getTarget,
  TransactionResponse,
  TransactionSimulationResult,
  Contract,
  Signer,
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
// For example, a NodeJS error might result in a reason string that includes more than just the contract revert reason.
export const knownRevertReasons = new Set([
  "nonce has already been used",
  "replacement fee too low",
  "relay filled",
  "Already claimed",
  "RelayFilled",
  "ClaimedMerkleLeaf",
  "InvalidSlowFillRequest",
]);

// The following reason potentially includes false positives of reverts that we should be alerted on, however
// there is something likely broken in how the provider is interpreting contract reverts. Currently, there are
// a lot of duplicate transaction sends that are reverting with this reason, for example, sending a transaction
// to execute a relayer refund leaf takes a while to execute and ends up reverting because a duplicate transaction
// mines before it. This situation leads to this revert reason which is spamming the Logger currently.
export const unknownRevertReasons = [
  "missing revert data in call exception; Transaction reverted without a reason string",
  "execution reverted",
];
export const unknownRevertReasonMethodsToIgnore = new Set([
  "multicall",
  "fillRelay",
  "fillRelayWithUpdatedFee",
  "fillV3Relay",
  "fillV3RelayWithUpdatedDeposit",
  "requestV3SlowFill",
  "executeV3SlowRelayLeaf",
  "executeSlowRelayLeaf",
  "executeRelayerRefundLeaf",
  "executeRootBundle",
]);

// @dev The dataworker executor personality typically bundles an Optimism L1 deposit via multicall3 aggregate(). Per
//      Optimism's Bedrock migration, gas estimates should be padded by 50% to ensure that transactions do not fail
//      with OoG. Because we optimistically construct an aggregate() transaction without simulating each simulating
//      each transaction, we do not know the gas cost of each bundled transaction. Therefore, pad the resulting
//      gasLimit. This can admittedly pad the gasLimit by a lot more than is required.
//      See also https://community.optimism.io/docs/developers/bedrock/differences/
const MULTICALL3_AGGREGATE_GAS_MULTIPLIER = 1.5;

export class MultiCallerClient {
  protected txnClient: TransactionClient;
  protected txns: { [chainId: number]: AugmentedTransaction[] } = {};
  protected valueTxns: { [chainId: number]: AugmentedTransaction[] } = {};
  constructor(
    readonly logger: winston.Logger,
    readonly chunkSize: { [chainId: number]: number } = DEFAULT_CHAIN_MULTICALL_CHUNK_SIZE,
    readonly baseSigner?: Signer
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

  // For each chain, collate the enqueued transactions and process them in parallel.
  async executeTxnQueues(simulate = false, chainIds: number[] = []): Promise<Record<number, string[]>> {
    if (chainIds.length === 0) {
      chainIds = sdkUtils.dedupArray([
        ...Object.keys(this.valueTxns).map(Number),
        ...Object.keys(this.txns).map(Number),
      ]);
    }

    const results = await Promise.allSettled(chainIds.map((chainId) => this.executeTxnQueue(chainId, simulate)));

    // Collate the results for each chain.
    const txnHashes: Record<number, { result: string[]; isError: boolean }> = Object.fromEntries(
      results.map((result, idx) => {
        const chainId = chainIds[idx];
        if (isPromiseFulfilled(result)) {
          return [chainId, { result: result.value.map((txnResponse) => txnResponse.hash), isError: false }];
        } else {
          return [chainId, { result: result.reason, isError: true }];
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
        error: failedChains.map((chainId) => txnHashes[Number(chainId)].result),
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

  // For a single chain, take any enqueued transactions and attempt to execute them.
  async executeTxnQueue(chainId: number, simulate = false): Promise<TransactionResponse[]> {
    const txns: AugmentedTransaction[] | undefined = this.txns[chainId];
    const valueTxns: AugmentedTransaction[] | undefined = this.valueTxns[chainId];
    this.clearTransactionQueue(chainId);
    return this._executeTxnQueue(chainId, txns, valueTxns, simulate);
  }

  // For a single chain, simulate all potential multicall txns and group the ones that pass into multicall bundles.
  // Then, submit a concatenated list of value txns + multicall bundles. If simulation was requested, log the results
  // and return early.
  protected async _executeTxnQueue(
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

    const txnRequestsToSubmit: AugmentedTransaction[] = [];

    // First try to simulate the transaction as a batch. If the full batch succeeded, then we don't
    // need to simulate transactions individually. If the batch failed, then we need to
    // simulate the transactions individually and pick out the successful ones.
    const batchTxns: AugmentedTransaction[] = valueTxns.concat(
      await this.buildMultiCallBundles(txns, this.chunkSize[chainId])
    );
    const batchSimResults = await this.txnClient.simulate(batchTxns);
    const batchesAllSucceeded = batchSimResults.every(({ succeed, transaction, reason }, idx) => {
      // If txn succeeded or the revert reason is known to be benign, then log at debug level.
      this.logger[
        succeed || simulate || this.canIgnoreRevertReason({ succeed, transaction, reason }) ? "debug" : "error"
      ]({
        at: "MultiCallerClient#executeChainTxnQueue",
        message: `${succeed ? "Successfully simulated" : "Failed to simulate"} ${networkName} transaction batch!`,
        batchTxn: { ...transaction, contract: transaction.contract.address },
        reason,
      });
      batchTxns[idx].gasLimit = succeed ? transaction.gasLimit : undefined;
      return succeed;
    });

    if (batchesAllSucceeded) {
      txnRequestsToSubmit.push(...batchTxns);
    } else {
      const individualTxnSimResults = await Promise.allSettled([
        this.simulateTransactionQueue(txns),
        this.simulateTransactionQueue(valueTxns),
      ]);
      const [_txns, _valueTxns] = individualTxnSimResults.map((result): AugmentedTransaction[] => {
        return isPromiseFulfilled(result) ? result.value : [];
      });
      // Fill in the set of txns to submit to the network. Anything that failed simulation is dropped.
      txnRequestsToSubmit.push(..._valueTxns.concat(await this.buildMultiCallBundles(_txns, this.chunkSize[chainId])));
    }

    if (simulate) {
      let mrkdwn = "";
      txnRequestsToSubmit.forEach((txn, idx) => {
        mrkdwn += `  *${idx + 1}. ${txn.message || "No message"}: ${txn.mrkdwn || "No markdown"}\n`;
      });
      this.logger.debug({
        at: "MultiCallerClient#executeTxnQueue",
        message: `${txnRequestsToSubmit.length}/${nTxns} ${networkName} transaction simulation(s) succeeded!`,
        mrkdwn,
      });
      this.logger.debug({ at: "MulticallerClient#executeTxnQueue", message: "Exiting simulation mode 🎮" });
      return [];
    }

    const txnResponses: TransactionResponse[] =
      txnRequestsToSubmit.length > 0 ? await this.txnClient.submit(chainId, txnRequestsToSubmit) : [];

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

    const mrkdwn: string[] = [];
    const callData: Multicall2Call[] = [];
    let gasLimit: BigNumber | undefined = bnZero;
    transactions.forEach((txn, idx) => {
      if (!txn.unpermissioned || txn.chainId !== chainId) {
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

      mrkdwn.push(`\n  *txn. ${idx + 1}:* ${txn.message ?? "No message"}: ${txn.mrkdwn ?? "No markdown"}`);
      callData.push({
        target: txn.contract.address,
        callData: txn.contract.interface.encodeFunctionData(txn.method, txn.args),
      });
      gasLimit = isDefined(gasLimit) && isDefined(txn.gasLimit) ? gasLimit.add(txn.gasLimit) : undefined;
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
      gasLimit,
      gasLimitMultiplier: MULTICALL3_AGGREGATE_GAS_MULTIPLIER,
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
    const mrkdwn: string[] = [];
    const callData: string[] = [];
    let gasLimit: BigNumber | undefined = bnZero;

    const { chainId, contract } = transactions[0];
    transactions.forEach((txn, idx) => {
      // Basic validation on all transactions to be bundled.
      if (txn.contract.address !== contract.address || txn.chainId !== chainId) {
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

      mrkdwn.push(`\n  *txn. ${idx + 1}:* ${txn.message ?? "No message"}: ${txn.mrkdwn ?? "No markdown"}`);
      callData.push(txn.contract.interface.encodeFunctionData(txn.method, txn.args));

      // Aggregate the individual gasLimits. If a transaction does not have a gasLimit defined then it has not been
      // simulated. In this case, drop the aggregation and revert to undefined to force estimation on submission.
      gasLimit = isDefined(gasLimit) && isDefined(txn.gasLimit) ? gasLimit.add(txn.gasLimit) : undefined;
    });

    this.logger.debug({
      at: "MultiCallerClient",
      message: `Made multicall bundle for ${getNetworkName(chainId)}.`,
      target: getTarget(contract.address),
      callData,
      gasLimit,
    });

    return {
      chainId,
      contract,
      method: "multicall",
      args: [callData],
      gasLimit,
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

    // Create groups of transactions to send atomically.
    // Sort transactions by contract address so we can reduce chance that we need to split them again
    // to make Multicall work.
    const getTxnChunks = (_txns: AugmentedTransaction[]): AugmentedTransaction[][] => {
      const groupIdTxns = _txns.filter(({ groupId }) => isDefined(groupId));
      const groupIdChunks = Object.values(lodash.groupBy(groupIdTxns, "groupId"))
        .map((txns) => {
          return lodash.chunk(
            txns.sort((a, b) => a.contract.address.localeCompare(b.contract.address)),
            chunkSize
          );
        })
        .flat();
      const nonGroupedChunks = lodash.chunk(
        _txns
          .filter(({ groupId }) => !isDefined(groupId))
          .sort((a, b) => a.contract.address.localeCompare(b.contract.address)),
        chunkSize
      );
      return [...groupIdChunks, ...nonGroupedChunks];
    };

    // If we can't construct multisender contract, then multicall everything. If any of the transactions
    // is for a contract that can't be multicalled, then this function will throw. This client should only be
    // used on contracts that extend Multicaller.
    if ((await this._getMultisender(chainId)) === undefined) {
      return getTxnChunks(multicallerTxns.concat(multisenderTxns))
        .map((txnChunk) => {
          // Don't wrap single transactions in a multicall.
          return txnChunk.length > 1 ? this.buildMultiCallBundle(txnChunk) : txnChunk[0];
        })
        .flat();
    } else {
      // We can support sending multiple transactions to different contracts via an external multisender
      // contract.
      const multicallerTxnBundle = getTxnChunks(multicallerTxns)
        .map((txnChunk) => (txnChunk.length > 1 ? this.buildMultiCallBundle(txnChunk) : txnChunk[0]))
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
    const { transaction: _txn, reason } = txn;
    const lowerCaseReason = reason.toLowerCase();
    const knownReason = [...knownRevertReasons].some((knownReason) =>
      lowerCaseReason.includes(knownReason.toLowerCase())
    );
    return (
      knownReason ||
      (unknownRevertReasonMethodsToIgnore.has(_txn.method) &&
        unknownRevertReasons.some((_reason) => lowerCaseReason.includes(_reason.toLowerCase())))
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
