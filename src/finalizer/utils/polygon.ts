import { setProofApi, use, POSClient } from "@maticnetwork/maticjs";
import { Web3ClientPlugin } from "@maticnetwork/maticjs-ethers";
import {
  convertFromWei,
  getDeployedContract,
  groupObjectCountsByProp,
  Signer,
  winston,
  Contract,
  getCachedProvider,
  getUniqueLogIndex,
  getCurrentTime,
  getRedisCache,
  getBlockForTimestamp,
  getL1TokenInfo,
  compareAddressesSimple,
  Multicall2Call,
  TOKEN_SYMBOLS_MAP,
  sortEventsAscending,
  toBNWei,
} from "../../utils";
import { EthersError, TokensBridged } from "../../interfaces";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { FinalizerPromise, CrossChainMessage } from "../types";

// Note!!: This client will only work for PoS tokens. Matic also has Plasma tokens which have a different finalization
// process entirely.

let CHAIN_ID;
enum POLYGON_MESSAGE_STATUS {
  NOT_CHECKPOINTED = "NOT_CHECKPOINTED",
  CAN_EXIT = "CAN_EXIT",
  EXIT_ALREADY_PROCESSED = "EXIT_ALREADY_PROCESSED",
  UNKNOWN_EXIT_FAILURE = "UNKNOWN_EXIT_FAILURE",
}
// Unique signature used to identify Polygon L2 transactions that were erc20 withdrawals from the Polygon
// canonical bridge. Do not change.
const BURN_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// We should ideally read this limit from a contract call, but for now we'll hardcode it.
const CCTP_WITHDRAWAL_LIMIT_WEI = toBNWei(1_000_000, 6);

export interface PolygonTokensBridged extends TokensBridged {
  payload: string;
}

export async function polygonFinalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient
): Promise<FinalizerPromise> {
  const { chainId } = spokePoolClient;
  CHAIN_ID = chainId;

  const posClient = await getPosClient(signer);
  const lookback = getCurrentTime() - 60 * 60 * 24 * 7;
  const redis = await getRedisCache(logger);
  const fromBlock = await getBlockForTimestamp(chainId, lookback, undefined, redis);

  logger.debug({
    at: "Finalizer#PolygonFinalizer",
    message: "Polygon TokensBridged event filter",
    fromBlock,
  });

  // Unlike the rollups, withdrawals process very quickly on polygon, so we can conservatively remove any events
  // that are older than 1 day old:
  let recentTokensBridgedEvents = spokePoolClient.getTokensBridged().filter((e) => e.blockNumber >= fromBlock);

  // The SpokePool emits one TokensBridged event even if the token is USDC and it gets withdrawn in two separate
  // CCTP events. We can't filter out these USDC events here (see comment below in `getFinalizableTransactions()`)
  // but we do need to add in more TokensBridged events so that the call to `getUniqueLogIndex` will work.
  recentTokensBridgedEvents.forEach((e) => {
    if (
      compareAddressesSimple(e.l2TokenAddress, TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_ID]) &&
      e.amountToReturn.gt(CCTP_WITHDRAWAL_LIMIT_WEI)
    ) {
      // Inject one TokensBridged event for each CCTP withdrawal that needs to be processed.
      const numberOfEventsToAdd = Math.ceil(e.amountToReturn.div(CCTP_WITHDRAWAL_LIMIT_WEI).toNumber());
      for (let i = 0; i < numberOfEventsToAdd; i++) {
        recentTokensBridgedEvents.push({
          ...e,
        });
      }
    }
  });
  recentTokensBridgedEvents = sortEventsAscending(recentTokensBridgedEvents);

  return multicallPolygonFinalizations(recentTokensBridgedEvents, posClient, signer, hubPoolClient, logger);
}

async function getPosClient(mainnetSigner: Signer): Promise<POSClient> {
  const from = await mainnetSigner.getAddress();
  // Following from https://maticnetwork.github.io/matic.js/docs/pos
  use(Web3ClientPlugin);
  setProofApi("https://apis.matic.network/");
  const posClient = new POSClient();
  return await posClient.init({
    network: "mainnet",
    version: "v1",
    parent: {
      provider: mainnetSigner,
      defaultConfig: { from },
    },
    child: {
      provider: mainnetSigner.connect(getCachedProvider(CHAIN_ID, true)),
      defaultConfig: { from },
    },
  });
}

async function getFinalizableTransactions(
  logger: winston.Logger,
  tokensBridged: TokensBridged[],
  posClient: POSClient
): Promise<PolygonTokensBridged[]> {
  // First look up which L2 transactions were checkpointed to mainnet.
  const isCheckpointed = await Promise.all(
    tokensBridged.map((event) => posClient.exitUtil.isCheckPointed(event.transactionHash))
  );

  // For each token bridge event that was checkpointed, store a unique log index for the event
  // within the transaction hash. This is important for bridge transactions containing multiple events.
  const checkpointedTokensBridged = tokensBridged.filter((_, i) => isCheckpointed[i]);
  const logIndexesForMessage = getUniqueLogIndex(checkpointedTokensBridged);

  // Construct the payload we'll need to finalize each L2 transaction that has been checkpointed to Mainnet and
  // can potentially be finalized.
  const payloads = await Promise.all(
    checkpointedTokensBridged.map((e, i) => {
      return posClient.exitUtil.buildPayloadForExit(e.transactionHash, BURN_SIG, false, logIndexesForMessage[i]);
    })
  );

  const finalizableMessages: PolygonTokensBridged[] = [];
  const exitStatus = await Promise.all(
    checkpointedTokensBridged.map(async (_, i) => {
      const payload = payloads[i];
      const { chainId, l2TokenAddress } = tokensBridged[i];

      // @dev we can't filter out USDC CCTP withdrawals until after we build the payloads for exit
      // because those functions take in a third 'logIndex' parameter which does assume that USDC CCTP
      // withdrawals are accounted for. For example, if an L2 withdrawal transaction contains two withdrawals: one USDC
      // one followed by a non-USDC one, the USDC 'logIndex' as far as building the payload is concerned
      // will be 0 and the non-USDC 'logIndex' will be 1. This is why we can't filter out USDC CCTP withdrawals
      // until after we've computed payloads.
      if (compareAddressesSimple(l2TokenAddress, TOKEN_SYMBOLS_MAP.USDC.addresses[chainId])) {
        return { status: "USDC_CCTP_L2_WITHDRAWAL" };
      }

      try {
        // If we can estimate gas for exit transaction call, then we can exit the burn tx, otherwise its likely
        // been processed. Note this will capture mislabel some exit txns that fail for other reasons as "exit
        // already processed", but in the future the maticjs SDK should improve to provide better error checking.
        // This is just a temporary workaround because there is no method in the sdk like isExitProcessed(txn, index).
        await (await posClient.rootChainManager.getContract()).method("exit", payload).estimateGas({});
        finalizableMessages.push({
          ...tokensBridged[i],
          payload,
        });
        return { status: POLYGON_MESSAGE_STATUS.CAN_EXIT };
      } catch (_err) {
        const err = _err as EthersError;
        if (err?.reason?.includes("EXIT_ALREADY_PROCESSED")) {
          return { status: POLYGON_MESSAGE_STATUS.EXIT_ALREADY_PROCESSED };
        } else {
          logger.debug({
            at: "PolygonFinalizer",
            message: "Exit will fail for unknown reason",
            err,
          });
          return { status: POLYGON_MESSAGE_STATUS.UNKNOWN_EXIT_FAILURE };
        }
      }
    })
  );

  logger.debug({
    at: "PolygonFinalizer",
    message: "Polygon message statuses",
    statusesGrouped: {
      ...groupObjectCountsByProp(exitStatus, (message: { status: string }) => message.status),
      NOT_CHECKPOINTED: tokensBridged.map((_, i) => !isCheckpointed[i]).filter((x) => x === true).length,
    },
  });

  return finalizableMessages;
}

async function finalizePolygon(posClient: POSClient, event: PolygonTokensBridged): Promise<Multicall2Call> {
  const { payload } = event;
  const rootChainManager = await posClient.rootChainManager.getContract();
  const callData = rootChainManager.method("exit", payload).encodeABI();
  return {
    callData,
    target: rootChainManager.address,
  };
}

async function multicallPolygonFinalizations(
  tokensBridged: TokensBridged[],
  posClient: POSClient,
  hubSigner: Signer,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<FinalizerPromise> {
  const finalizableMessages = await getFinalizableTransactions(logger, tokensBridged, posClient);

  const finalizedBridges = await resolvePolygonBridgeFinalizations(finalizableMessages, posClient, hubPoolClient);
  const finalizedRetrievals = await resolvePolygonRetrievalFinalizations(finalizableMessages, hubSigner, hubPoolClient);

  return {
    callData: [...finalizedBridges.callData, ...finalizedRetrievals.callData],
    crossChainMessages: [...finalizedBridges.crossChainMessages, ...finalizedRetrievals.crossChainMessages],
  };
}

async function resolvePolygonBridgeFinalizations(
  finalizableMessages: PolygonTokensBridged[],
  posClient: POSClient,
  hubPoolClient: HubPoolClient
): Promise<FinalizerPromise> {
  const callData = await Promise.all(finalizableMessages.map((event) => finalizePolygon(posClient, event)));
  const crossChainMessages = finalizableMessages.map((finalizableMessage) =>
    resolveCrossChainTransferStructure(finalizableMessage, "withdrawal", hubPoolClient)
  );
  return {
    callData,
    crossChainMessages,
  };
}

async function resolvePolygonRetrievalFinalizations(
  finalizableMessages: PolygonTokensBridged[],
  hubSigner: Signer,
  hubPoolClient: HubPoolClient
): Promise<FinalizerPromise> {
  const tokensInFinalizableMessages = getL2TokensToFinalize(
    finalizableMessages.map((polygonTokensBridged) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { payload, ...tokensBridged } = polygonTokensBridged;
      return tokensBridged;
    })
  );
  const callData = await Promise.all(
    tokensInFinalizableMessages.map((l2Token) => retrieveTokenFromMainnetTokenBridger(l2Token, hubSigner))
  );
  const crossChainMessages = finalizableMessages.map((finalizableMessage) =>
    resolveCrossChainTransferStructure(finalizableMessage, "misc", hubPoolClient)
  );
  return {
    callData,
    crossChainMessages,
  };
}

function resolveCrossChainTransferStructure(
  finalizableMessage: PolygonTokensBridged,
  type: "misc" | "withdrawal",
  hubPoolClient: HubPoolClient
): CrossChainMessage {
  const { l2TokenAddress, amountToReturn } = finalizableMessage;
  const l1TokenInfo = getL1TokenInfo(l2TokenAddress, CHAIN_ID);
  const amountFromWei = convertFromWei(amountToReturn.toString(), l1TokenInfo.decimals);
  const transferBase = {
    originationChainId: CHAIN_ID,
    destinationChainId: hubPoolClient.chainId,
    l1TokenSymbol: l1TokenInfo.symbol,
    amount: amountFromWei,
  };

  const crossChainTransfers: CrossChainMessage =
    type === "misc" ? { ...transferBase, type, miscReason: "retrieval" } : { ...transferBase, type };
  return crossChainTransfers;
}

function getMainnetTokenBridger(mainnetSigner: Signer): Contract {
  return getDeployedContract("PolygonTokenBridger", 1, mainnetSigner);
}

async function retrieveTokenFromMainnetTokenBridger(l2Token: string, mainnetSigner: Signer): Promise<Multicall2Call> {
  const l1Token = getL1TokenInfo(l2Token, CHAIN_ID).address;
  const mainnetTokenBridger = getMainnetTokenBridger(mainnetSigner);
  const callData = await mainnetTokenBridger.populateTransaction.retrieve(l1Token);
  return {
    callData: callData.data,
    target: callData.to,
  };
}

function getL2TokensToFinalize(events: TokensBridged[]): string[] {
  const l2TokenCountInBridgeEvents = events.reduce((l2TokenDictionary, event) => {
    l2TokenDictionary[event.l2TokenAddress] = true;
    return l2TokenDictionary;
  }, {});
  return Object.keys(l2TokenCountInBridgeEvents).filter((token) => l2TokenCountInBridgeEvents[token] === true);
}
