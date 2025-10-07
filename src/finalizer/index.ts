import { CCTP_NO_DOMAIN, ChainFamily, PRODUCTION_NETWORKS } from "@across-protocol/constants";
import { utils as sdkUtils } from "@across-protocol/sdk";
import assert from "assert";
import { Contract } from "ethers";
import { groupBy } from "lodash";
import { AugmentedTransaction, HubPoolClient, MultiCallerClient } from "../clients";
import {
  CONTRACT_ADDRESSES,
  Clients,
  CommonConfig,
  FINALIZER_TOKENBRIDGE_LOOKBACK,
  ProcessEnv,
  constructClients,
  constructSpokePoolClientsWithLookback,
  updateSpokePoolClients,
  UNIVERSAL_CHAINS,
} from "../common";
import { SpokePoolClientsByChain } from "../interfaces";
import {
  Signer,
  blockExplorerLink,
  config as dotenvConfig,
  disconnectRedisClients,
  getMultisender,
  getNetworkName,
  Multicall2Call,
  processEndPollingLoop,
  startupLogLevel,
  winston,
  CHAIN_IDs,
  Profiler,
  stringifyThrownValue,
  chainIsEvm,
  EvmAddress,
  Address,
  getProvider,
} from "../utils";
import { ChainFinalizer, CrossChainMessage, Finalizer, isAugmentedTransaction } from "./types";
import {
  arbStackFinalizer,
  binanceFinalizer,
  cctpV1L1toL2Finalizer,
  cctpV1L2toL1Finalizer,
  cctpV2Finalizer,
  heliosL1toL2Finalizer,
  lineaL1ToL2Finalizer,
  lineaL2ToL1Finalizer,
  opStackFinalizer,
  polygonFinalizer,
  scrollFinalizer,
  zkSyncFinalizer,
} from "./utils";
import { assert as ssAssert, enums } from "superstruct";
const { isDefined } = sdkUtils;

dotenvConfig();
let logger: winston.Logger;

/**
 * The finalization type is used to determine the direction of the finalization.
 */
type FinalizationType = "l1->l2" | "l2->l1" | "l1<->l2" | "any<->any";

/**
 * A list of finalizers that can be used to finalize messages on a chain. These are
 * broken down into two categories: finalizers that finalize messages on L1 and finalizers
 * that finalize messages on L2.
 * @note: finalizeOnL1 is used to finalize L2 -> L1 messages (from the spoke chain to mainnet)
 * @note: finalizeOnL2 is used to finalize L1 -> L2 messages (from mainnet to the spoke chain)
 */
const chainFinalizers: {
  [chainId: number]: { finalizeOnL2?: ChainFinalizer[]; finalizeOnL1?: ChainFinalizer[]; finalizeOnAny?: Finalizer[] };
} = {
  // Mainnets
  [CHAIN_IDs.POLYGON]: {
    finalizeOnL1: [polygonFinalizer],
  },
  [CHAIN_IDs.ZK_SYNC]: {
    finalizeOnL1: [zkSyncFinalizer],
  },
  [CHAIN_IDs.ARBITRUM]: {
    finalizeOnL1: [arbStackFinalizer],
  },
  [CHAIN_IDs.LINEA]: {
    finalizeOnL1: [lineaL2ToL1Finalizer],
    finalizeOnL2: [lineaL1ToL2Finalizer],
  },
  [CHAIN_IDs.SCROLL]: {
    finalizeOnL1: [scrollFinalizer],
  },
  [CHAIN_IDs.BSC]: {
    finalizeOnL1: [binanceFinalizer],
  },
  // Testnets
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: {
    finalizeOnL1: [arbStackFinalizer],
  },
  [CHAIN_IDs.POLYGON_AMOY]: {
    finalizeOnL1: [polygonFinalizer],
  },
};

function generateChainConfig(): void {
  Object.entries(PRODUCTION_NETWORKS).forEach(([_chainId, chain]) => {
    const chainId = Number(_chainId);

    const config = (chainFinalizers[chainId] ??= {});
    config.finalizeOnL1 ??= [];
    config.finalizeOnL2 ??= [];
    config.finalizeOnAny ??= [];

    switch (chain.family) {
      case ChainFamily.ORBIT:
        config.finalizeOnL1.push(arbStackFinalizer);
        break;

      case ChainFamily.OP_STACK:
        config.finalizeOnL1.push(opStackFinalizer);
        break;

      case ChainFamily.ZK_STACK:
        config.finalizeOnL1.push(zkSyncFinalizer);
        break;
    }

    if (UNIVERSAL_CHAINS.includes(chainId)) {
      config.finalizeOnL1.push(heliosL1toL2Finalizer);
    }

    // Autoconfigure CCTPv1 + v2 finalisation for CCTP chains.
    if (chain.cctpDomain !== CCTP_NO_DOMAIN) {
      const { ARBITRUM, BASE, OPTIMISM, POLYGON, SOLANA, UNICHAIN } = CHAIN_IDs;
      const cctpV1Chains = [ARBITRUM, BASE, OPTIMISM, POLYGON, SOLANA, UNICHAIN];

      if (cctpV1Chains.includes(chainId)) {
        config.finalizeOnL1.push(cctpV1L2toL1Finalizer);
        config.finalizeOnL2.push(cctpV1L1toL2Finalizer);
      }
      if (chain.family !== ChainFamily.SVM) {
        config.finalizeOnAny.push(cctpV2Finalizer);
      }
    }
  });
}

export async function finalize(
  logger: winston.Logger,
  hubSigner: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClients: SpokePoolClientsByChain,
  config: FinalizerConfig
): Promise<void> {
  const hubChainId = hubPoolClient.chainId;

  const {
    chainsToFinalize: configuredChainIds,
    finalizationStrategy,
    sendingTransactionsEnabled: submitFinalizationTransactions,
  } = config;

  generateChainConfig();

  // Note: Could move this into a client in the future to manage # of calls and chunk calls based on
  // input byte length.
  const finalizations: { txn: Multicall2Call | AugmentedTransaction; crossChainMessage?: CrossChainMessage }[] = [];

  // For each chain, delegate to a handler to look up any TokensBridged events and attempt finalization.
  await sdkUtils.mapAsync(configuredChainIds, async (chainId) => {
    const client = spokePoolClients[chainId];
    if (client === undefined) {
      logger.warn({
        at: "Finalizer",
        message: `Skipping finalizations for ${getNetworkName(
          chainId
        )} because spoke pool client does not exist, is it disabled?`,
        configuredChainIds,
        availableChainIds: Object.keys(spokePoolClients),
      });
      return;
    }

    // We should only finalize the direction that has been specified in
    // the finalization strategy.
    const chainSpecificFinalizers: { genericFinalizer: boolean; finalizer: ChainFinalizer | Finalizer }[] = [];
    switch (finalizationStrategy) {
      case "l1->l2":
        chainSpecificFinalizers.push(
          ...chainFinalizers[chainId].finalizeOnL2.map((finalizer) => ({ finalizer, genericFinalizer: false }))
        );
        break;
      case "l2->l1":
        chainSpecificFinalizers.push(
          ...chainFinalizers[chainId].finalizeOnL1.map((finalizer) => ({ finalizer, genericFinalizer: false }))
        );
        break;
      case "any<->any":
        chainSpecificFinalizers.push(
          ...chainFinalizers[chainId].finalizeOnAny.map((finalizer) => ({ finalizer, genericFinalizer: true }))
        );
        break;
      case "l1<->l2":
        chainSpecificFinalizers.push(
          ...chainFinalizers[chainId].finalizeOnL1.map((finalizer) => ({ finalizer, genericFinalizer: false })),
          ...chainFinalizers[chainId].finalizeOnL2.map((finalizer) => ({ finalizer, genericFinalizer: false }))
        );
        break;
    }
    assert(chainSpecificFinalizers?.length > 0, `No finalizer available for chain ${chainId}`);

    const network = getNetworkName(chainId);

    // Some finalizer adapters query TokensBridged events on the L2 spoke pools to discover withdrawals that
    // need to be finalized and will ignore the following address list. For others, this list comprises both the
    // "sender" and "recipient" addresses we should look out for. Some bridging events don't let us query for the sender
    // or the recipient so its important to track for both, even if that means more RPC requests.
    // Always track HubPool, SpokePool, AtomicDepositor. HubPool sends messages and
    // tokens to the SpokePool, while the relayer rebalances ETH via the AtomicDepositor.
    const addressesToFinalize = new Map(config.userAddresses);
    addressesToFinalize.set(EvmAddress.from(hubPoolClient.hubPool.address), []);
    addressesToFinalize.set(EvmAddress.from(CONTRACT_ADDRESSES[hubChainId]?.atomicDepositor?.address), []);
    addressesToFinalize.set(spokePoolClients[chainId].spokePoolAddress, []);

    // We can subloop through the finalizers for each chain, and then execute the finalizer. For now, the
    // main reason for this is related to CCTP finalizations. We want to run the CCTP finalizer AND the
    // normal finalizer for each chain. This is going to cause an overlap of finalization attempts on USDC.
    // However, that's okay because each finalizer will only attempt to finalize the messages that it is
    // responsible for.
    let totalWithdrawalsForChain = 0;
    let totalDepositsForChain = 0;
    let totalMiscTxnsForChain = 0;
    const isChainSpecificFinalizer = (
      finalizer: ChainFinalizer | Finalizer,
      genericFinalizer: boolean
    ): finalizer is ChainFinalizer => {
      return !genericFinalizer;
    };
    await sdkUtils.mapAsync(chainSpecificFinalizers, async ({ finalizer, genericFinalizer }) => {
      try {
        let callData: (Multicall2Call | AugmentedTransaction)[], crossChainMessages: CrossChainMessage[];
        if (isChainSpecificFinalizer(finalizer, genericFinalizer)) {
          ({ callData, crossChainMessages } = await finalizer(
            logger,
            hubSigner,
            hubPoolClient,
            client,
            spokePoolClients[hubChainId],
            addressesToFinalize
          ));
        } else {
          ({ callData, crossChainMessages } = await finalizer(logger, client, addressesToFinalize));
        }

        callData.forEach((txn, idx) => {
          finalizations.push({ txn, crossChainMessage: crossChainMessages[idx] });
        });

        totalWithdrawalsForChain += crossChainMessages.filter(({ type }) => type === "withdrawal").length;
        totalDepositsForChain += crossChainMessages.filter(({ type }) => type === "deposit").length;
        totalMiscTxnsForChain += crossChainMessages.filter(({ type }) => type === "misc").length;
      } catch (_e) {
        logger.error({
          at: "finalizer",
          message: `Something errored in a finalizer for chain ${client.chainId}`,
          error: stringifyThrownValue(_e),
        });
      }
    });
    const totalTransfers = totalWithdrawalsForChain + totalDepositsForChain + totalMiscTxnsForChain;
    logger.debug({
      at: "finalize",
      message: `Found ${totalTransfers} ${network} messages (${totalWithdrawalsForChain} withdrawals | ${totalDepositsForChain} deposits | ${totalMiscTxnsForChain} misc txns) for finalization.`,
    });
  });
  const multicall2Lookup = Object.fromEntries(
    await Promise.all(
      finalizations
        .map(({ crossChainMessage }) => crossChainMessage.destinationChainId)
        .filter(chainIsEvm)
        .map(async (chainId) => {
          const signer = hubSigner.connect(await getProvider(chainId));
          return [chainId, getMultisender(chainId, signer)] as [number, Contract];
        })
    )
  );
  // Assert that no multicall2Lookup is undefined
  assert(
    Object.values(multicall2Lookup).every(isDefined),
    `Multicall2 lookup is undefined for chain ids: ${Object.entries(multicall2Lookup)
      .filter(([, v]) => v === undefined)
      .map(([k]) => k)}`
  );

  if (finalizations.length > 0) {
    // @dev use multicaller client to execute batched txn to take advantage of its native txn simulation
    // safety features. This only works because we assume all finalizer transactions are
    // unpermissioned (i.e. msg.sender can be anyone). If this is not true for any chain then we'd need to use
    // the TransactionClient.
    const multicallerClient = new MultiCallerClient(logger);
    let txnRefLookup: Record<number, string[]> = {};
    try {
      const finalizationsByChain = groupBy(
        finalizations,
        ({ crossChainMessage }) => crossChainMessage.destinationChainId
      );

      // @dev Here, we enqueueTransaction individual transactions right away, and we batch all multicalls into `multicallTxns` to enqueue as a single tx right after
      for (const [chainId, finalizations] of Object.entries(finalizationsByChain)) {
        const multicallTxns: Multicall2Call[] = [];

        finalizations.forEach(({ txn }) => {
          if (isAugmentedTransaction(txn)) {
            // It's an AugmentedTransaction, enqueue directly
            txn.nonMulticall = true; // cautiously enforce an invariant that should already be present
            multicallerClient.enqueueTransaction(txn);
          } else {
            // It's a Multicall2Call, collect for batching
            multicallTxns.push(txn);
          }
        });

        if (multicallTxns.length > 0) {
          const txnToSubmit: AugmentedTransaction = {
            contract: multicall2Lookup[Number(chainId)],
            chainId: Number(chainId),
            method: "aggregate",
            args: [multicallTxns],
            unpermissioned: true,
            message: `Batch finalized ${multicallTxns.length} txns`,
            mrkdwn: `Batch finalized ${multicallTxns.length} txns`,
          };
          multicallerClient.enqueueTransaction(txnToSubmit);
        }
      }
      txnRefLookup = await multicallerClient.executeTxnQueues(!submitFinalizationTransactions);
    } catch (_error) {
      const error = _error as Error;
      logger.warn({
        at: "Finalizer",
        message: "Error creating aggregateTx",
        reason: error.stack || error.message || error.toString(),
        notificationPath: "across-error",
        finalizations,
      });
      return;
    }

    const { transfers = [], misc = [] } = groupBy(
      finalizations.filter(({ crossChainMessage }) => isDefined(crossChainMessage)),
      ({ crossChainMessage: { type } }) => {
        return type === "misc" ? "misc" : "transfers";
      }
    );

    misc.forEach(({ crossChainMessage }) => {
      const { originationChainId, destinationChainId, amount, l1TokenSymbol: symbol, type } = crossChainMessage;
      // Required for tsc to be happy.
      if (type !== "misc") {
        return;
      }
      const { miscReason } = crossChainMessage;
      const originationNetwork = getNetworkName(originationChainId);
      const destinationNetwork = getNetworkName(destinationChainId);
      const infoLogMessage =
        amount && symbol ? `to support a ${originationNetwork} withdrawal of ${amount} ${symbol} 🔜` : "";
      logger.info({
        at: "Finalizer",
        message: `Submitted ${miscReason} on ${destinationNetwork}`,
        infoLogMessage,
        txnRefList: txnRefLookup[destinationChainId]?.map((txnRef) => blockExplorerLink(txnRef, destinationChainId)),
      });
    });
    transfers.forEach(
      ({ crossChainMessage: { originationChainId, destinationChainId, type, amount, l1TokenSymbol: symbol } }) => {
        const originationNetwork = getNetworkName(originationChainId);
        const destinationNetwork = getNetworkName(destinationChainId);
        logger.info({
          at: "Finalizer",
          message: `Finalized ${originationNetwork} ${type} on ${destinationNetwork} for ${amount} ${symbol} 🪃`,
          txnRefList: txnRefLookup[destinationChainId]?.map((txnRef) => blockExplorerLink(txnRef, destinationChainId)),
        });
      }
    );
  }
}

export async function constructFinalizerClients(
  _logger: winston.Logger,
  config: FinalizerConfig,
  baseSigner: Signer
): Promise<{
  commonClients: Clients;
  spokePoolClients: SpokePoolClientsByChain;
}> {
  // The finalizer only uses the HubPoolClient to look up the *latest* l1 tokens matching an l2 token that was
  // withdrawn to L1, so assuming these L1 tokens do not change in the future, then we can reduce the hub pool
  // client lookback. Note, this should not be impacted by L2 tokens changing, for example when changing
  // USDC.e --> USDC because the l1 token matching both L2 version stays the same.
  const hubPoolLookBack = 3600 * 8;
  const commonClients = await constructClients(_logger, config, baseSigner, hubPoolLookBack);
  await updateFinalizerClients(commonClients);

  if (config.chainsToFinalize.length === 0) {
    config.chainsToFinalize = commonClients.configStoreClient.getChainIdIndicesForBlock();
  }

  config.validate(config.chainsToFinalize, _logger);

  // Make sure we have at least one chain to finalize and that we include the mainnet chain if it's not already
  // included. Note, we deep copy so that we don't modify config.chainsToFinalize accidentally.
  const configuredChainIds = [...config.chainsToFinalize];
  if (configuredChainIds.length === 0) {
    throw new Error("No chains configured for finalizer");
  }
  if (!configuredChainIds.includes(config.hubPoolChainId)) {
    configuredChainIds.push(config.hubPoolChainId);
  }
  const spokePoolClients = await constructSpokePoolClientsWithLookback(
    logger,
    commonClients.hubPoolClient,
    commonClients.configStoreClient,
    config,
    baseSigner,
    config.maxFinalizerLookback,
    configuredChainIds
  );

  return {
    commonClients,
    spokePoolClients,
  };
}

// @dev The HubPoolClient is dependent on the state of the ConfigStoreClient,
//      so update the ConfigStoreClient first. @todo: Use common/ClientHelper.ts.
async function updateFinalizerClients(clients: Clients) {
  await clients.configStoreClient.update();
  await clients.hubPoolClient.update();
}

export class FinalizerConfig extends CommonConfig {
  public readonly finalizationStrategy: FinalizationType;
  public readonly maxFinalizerLookback: number;
  public readonly userAddresses: Map<Address, string[]>;
  public chainsToFinalize: number[];

  constructor(env: ProcessEnv) {
    const {
      FINALIZER_MAX_TOKENBRIDGE_LOOKBACK,
      FINALIZER_CHAINS = "[]",
      FINALIZER_WITHDRAWAL_TO_ADDRESSES = "[]",
      FINALIZATION_STRATEGY = "l1<->l2",
    } = env;
    super(env);

    const userAddresses: { [address: string]: string[] } = JSON.parse(FINALIZER_WITHDRAWAL_TO_ADDRESSES);
    this.userAddresses = new Map();
    Object.entries(userAddresses).forEach(([address, tokensToFinalize]) => {
      this.userAddresses.set(EvmAddress.from(address), tokensToFinalize);
    });

    this.chainsToFinalize = JSON.parse(FINALIZER_CHAINS);

    // `maxFinalizerLookback` is how far we fetch events from, modifying the search config's 'fromBlock'
    this.maxFinalizerLookback = Number(FINALIZER_MAX_TOKENBRIDGE_LOOKBACK ?? FINALIZER_TOKENBRIDGE_LOOKBACK);
    assert(
      Number.isInteger(this.maxFinalizerLookback),
      `Invalid FINALIZER_MAX_TOKENBRIDGE_LOOKBACK: ${FINALIZER_MAX_TOKENBRIDGE_LOOKBACK}`
    );

    const _finalizationStrategy = FINALIZATION_STRATEGY.toLowerCase();
    ssAssert(_finalizationStrategy, enums(["l1->l2", "l2->l1", "l1<->l2", "any<->any"]));
    this.finalizationStrategy = _finalizationStrategy;
  }
}

export async function runFinalizer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;

  // Same config as Dataworker for now.
  const config = new FinalizerConfig(process.env);
  const profiler = new Profiler({
    logger,
    at: "Finalizer#index",
    config,
  });

  logger[startupLogLevel(config)]({ at: "Finalizer#index", message: "Finalizer started 🏋🏿‍♀️", config });
  const { commonClients, spokePoolClients } = await constructFinalizerClients(logger, config, baseSigner);

  try {
    for (;;) {
      profiler.mark("loopStart");
      await updateSpokePoolClients(spokePoolClients, ["TokensBridged"]);
      profiler.mark("loopStartPostSpokePoolUpdates");

      await finalize(logger, commonClients.hubSigner, commonClients.hubPoolClient, spokePoolClients, config);

      profiler.mark("loopEndPostFinalizations");

      profiler.measure("timeToUpdateSpokeClients", {
        from: "loopStart",
        to: "loopStartPostSpokePoolUpdates",
        strategy: config.finalizationStrategy,
      });

      profiler.measure("timeToFinalize", {
        from: "loopStartPostSpokePoolUpdates",
        to: "loopEndPostFinalizations",
        strategy: config.finalizationStrategy,
      });

      profiler.measure("loopTime", {
        message: "Time to loop",
        from: "loopStart",
        to: "loopEndPostFinalizations",
        strategy: config.finalizationStrategy,
      });

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) {
        break;
      }
    }
  } finally {
    await disconnectRedisClients(logger);
  }
}
