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
  getBlockForTimestamp,
  Multicall2Call,
  TOKEN_SYMBOLS_MAP,
  sortEventsAscending,
  toBNWei,
  getTokenInfo,
  getL1TokenAddress,
  toAddressType,
  EvmAddress,
  Address,
  assert,
  isDefined,
  paginatedEventQuery,
  isEVMSpokePoolClient,
  getL2TokenAddresses,
  ZERO_ADDRESS,
} from "../../utils";
import { getContractAbi } from "../../common";
import { getRedisCache } from "../../cache/Redis";
import { EthersError, TokensBridged } from "../../interfaces";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { FinalizerPromise, CrossChainMessage, AddressesToFinalize } from "../types";

// Note!!: This client will only work for PoS tokens. Matic also has Plasma tokens which have a different finalization
// process entirely.

let CHAIN_ID: number;
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

// EOA-initiated withdrawals exit directly to the burner's own hub-chain address, so unlike SpokePool withdrawals
// they must not be routed through PolygonTokenBridger.retrieve().
type MaybeEOATokensBridged = TokensBridged & { isEOAWithdrawal?: boolean };

export interface PolygonTokensBridged extends MaybeEOATokensBridged {
  payload: string;
}

/**
 * USDC and USDT leave Polygon over CCTP and OFT respectively, not the PoS bridge. Their burns look identical to a
 * PoS burn on-chain, so they are excluded from PoS exit handling wherever burns are inspected.
 */
function isAltL2Withdrawal(l2TokenAddress: Address, chainId: number): boolean {
  // Neither token is mapped on every PoS chain (i.e. USDT on Amoy). An unmapped token can't be the one that burned,
  // and toAddressType() throws on undefined, so drop it before comparing.
  return [TOKEN_SYMBOLS_MAP.USDC, TOKEN_SYMBOLS_MAP.USDT]
    .map(({ addresses }) => addresses[chainId])
    .filter(isDefined)
    .some((altL2Token) => l2TokenAddress.eq(toAddressType(altL2Token, chainId)));
}

/**
 * Discovers PoS withdrawals initiated by monitored EOAs rather than by the SpokePool. The relayer withdraws excess
 * inventory directly from its own address by burning the child token, and those burns emit no TokensBridged, so
 * without this they would burn on Polygon and never be exited on the hub chain.
 *
 * @returns Synthetic TokensBridged events for EOA-initiated burns, flagged so the retrieval step can skip them.
 */
async function getEOAWithdrawals(
  logger: winston.Logger,
  spokePoolClient: SpokePoolClient,
  hubPoolClient: HubPoolClient,
  senderAddresses: AddressesToFinalize
): Promise<MaybeEOATokensBridged[]> {
  assert(isEVMSpokePoolClient(spokePoolClient));
  const { chainId: l2ChainId } = spokePoolClient;

  // Withdrawals sent by the SpokePool are already covered by getTokensBridged().
  const senders = Array.from(senderAddresses.keys())
    .filter((address) => address.isEVM())
    .map((address) => address.toNative())
    .filter((sender) => sender !== spokePoolClient.spokePool.address);
  if (senders.length === 0) {
    return [];
  }

  const provider = spokePoolClient.spokePool.provider;
  const searchConfig = { ...spokePoolClient.eventSearchConfig, to: spokePoolClient.latestHeightSearched };
  const abi = getContractAbi(l2ChainId, "withdrawableErc20");

  // The burn is emitted by the child token itself, so each candidate token is queried individually. Restricting to
  // hub-enabled L1 tokens keeps that bounded to the handful the relayer can actually hold.
  const l2Tokens = hubPoolClient
    .getL1Tokens()
    .map(({ address }) => getL2TokenAddresses(address.toNative())?.[l2ChainId])
    .filter(isDefined)
    .map((l2Token) => EvmAddress.from(l2Token))
    .filter((l2Token) => !isAltL2Withdrawal(l2Token, l2ChainId));

  const burnsByToken = await Promise.all(
    l2Tokens.map(async (l2Token) => {
      const childToken = new Contract(l2Token.toNative(), abi, provider);
      const events = await paginatedEventQuery(
        childToken,
        childToken.filters.Transfer(senders, ZERO_ADDRESS),
        searchConfig
      );
      return { l2Token, events };
    })
  );

  return burnsByToken.flatMap(({ l2Token, events }) =>
    events.flatMap((event) => {
      // Skip anything Across does not recognise rather than throwing: one unknown token would otherwise abort
      // finalization for every withdrawal on this chain.
      try {
        getTokenInfo(l2Token, l2ChainId);
      } catch {
        logger.debug({
          at: "Finalizer#PolygonFinalizer",
          message: `Skipping EOA withdrawal of unrecognised token ${l2Token.toNative()}.`,
          txnRef: event.transactionHash,
        });
        return [];
      }

      const { transactionHash, transactionIndex, ...rest } = event;
      return [
        {
          ...rest,
          amountToReturn: event.args.value,
          chainId: l2ChainId,
          leafId: 0,
          l2TokenAddress: l2Token,
          txnRef: transactionHash,
          txnIndex: transactionIndex,
          isEOAWithdrawal: true,
        },
      ];
    })
  );
}

export async function polygonFinalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  _l1SpokePoolClient: SpokePoolClient,
  senderAddresses: AddressesToFinalize
): Promise<FinalizerPromise> {
  const { chainId } = spokePoolClient;
  CHAIN_ID = chainId;

  const posClient = await getPosClient(signer);
  const lookback = getCurrentTime() - 60 * 60 * 24 * 7;
  const redis = await getRedisCache(logger);
  const fromBlock = await getBlockForTimestamp(logger, chainId, lookback, undefined, redis);

  logger.debug({
    at: "Finalizer#PolygonFinalizer",
    message: "Polygon TokensBridged event filter",
    fromBlock,
  });

  // Unlike the rollups, withdrawals process very quickly on polygon, so we can conservatively remove any events
  // that are older than 1 day old:
  const eoaWithdrawals = await getEOAWithdrawals(logger, spokePoolClient, hubPoolClient, senderAddresses);
  let recentTokensBridgedEvents: MaybeEOATokensBridged[] = spokePoolClient
    .getTokensBridged()
    .concat(eoaWithdrawals)
    .filter((e) => e.blockNumber >= fromBlock);

  // The SpokePool emits one TokensBridged event even if the token is USDC and it gets withdrawn in two separate
  // CCTP events. We can't filter out these USDC events here (see comment below in `getFinalizableTransactions()`)
  // but we do need to add in more TokensBridged events so that the call to `getUniqueLogIndex` will work.
  recentTokensBridgedEvents.forEach((e) => {
    if (
      e.l2TokenAddress.eq(toAddressType(TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_ID], chainId)) &&
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
  // Following from https://docs.polygon.technology/tools/matic-js/pos/client/
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
  tokensBridged: MaybeEOATokensBridged[],
  posClient: POSClient
): Promise<PolygonTokensBridged[]> {
  // First look up which L2 transactions were checkpointed to mainnet.
  const isCheckpointed = await Promise.all(
    tokensBridged.map((event) => posClient.exitUtil.isCheckPointed(event.txnRef))
  );

  // For each token bridge event that was checkpointed, store a unique log index for the event
  // within the transaction hash. This is important for bridge transactions containing multiple events.
  const checkpointedTokensBridged = tokensBridged.filter((_, i) => isCheckpointed[i]);
  const logIndexesForMessage = getUniqueLogIndex(checkpointedTokensBridged);

  // Construct the payload we'll need to finalize each L2 transaction that has been checkpointed to Mainnet and
  // can potentially be finalized.
  const payloads = await Promise.all(
    checkpointedTokensBridged.map(({ txnRef }, i) => {
      return posClient.exitUtil.buildPayloadForExit(txnRef, BURN_SIG, false, logIndexesForMessage[i]);
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
      if (isAltL2Withdrawal(l2TokenAddress, chainId)) {
        return { status: "ALT_L2_WITHDRAWAL" };
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
  tokensBridged: MaybeEOATokensBridged[],
  posClient: POSClient,
  hubSigner: Signer,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<FinalizerPromise> {
  const finalizableMessages = await getFinalizableTransactions(logger, tokensBridged, posClient);
  const finalizedBridges = await resolvePolygonBridgeFinalizations(finalizableMessages, posClient, hubPoolClient);
  // PolygonTokenBridger.retrieve() forwards tokens that the SpokePool's withdrawal parked in the bridger contract.
  // An EOA burn exits straight to the burner's own hub-chain address, so retrieving for it would be a no-op call
  // against a contract holding none of its funds.
  const finalizedRetrievals = await resolvePolygonRetrievalFinalizations(
    finalizableMessages.filter(({ isEOAWithdrawal }) => !isEOAWithdrawal),
    hubSigner,
    hubPoolClient
  );

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
  const { symbol, decimals } = getTokenInfo(l2TokenAddress, CHAIN_ID);
  const amountFromWei = convertFromWei(amountToReturn.toString(), decimals);
  const transferBase = {
    originationChainId: CHAIN_ID,
    destinationChainId: hubPoolClient.chainId,
    l1TokenSymbol: symbol,
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
  const l1Token = getL1TokenAddress(EvmAddress.from(l2Token), CHAIN_ID);
  const mainnetTokenBridger = getMainnetTokenBridger(mainnetSigner);
  const callData = await mainnetTokenBridger.populateTransaction.retrieve(l1Token.toNative());
  assert(isDefined(callData.data) && isDefined(callData.to), "polygon: retrieve populateTransaction missing data/to");
  return {
    callData: callData.data,
    target: callData.to,
  };
}

function getL2TokensToFinalize(events: TokensBridged[]): string[] {
  const l2TokenCountInBridgeEvents = events.reduce<Record<string, boolean>>((l2TokenDictionary, event) => {
    l2TokenDictionary[event.l2TokenAddress.toEvmAddress()] = true;
    return l2TokenDictionary;
  }, {});
  return Object.keys(l2TokenCountInBridgeEvents).filter((token) => l2TokenCountInBridgeEvents[token] === true);
}
