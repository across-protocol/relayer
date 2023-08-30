import { setProofApi, use, POSClient } from "@maticnetwork/maticjs";
import { Web3ClientPlugin } from "@maticnetwork/maticjs-ethers";
import {
  getDeployedContract,
  getNetworkName,
  groupObjectCountsByProp,
  Wallet,
  winston,
  Contract,
  getCachedProvider,
} from "../../utils";
import { EthersError, TokensBridged } from "../../interfaces";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { Multicall2Call } from "../../common";
import { FinalizerPromise, Withdrawal } from "../types";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
const { convertFromWei } = sdkUtils;

// Note!!: This client will only work for PoS tokens. Matic also has Plasma tokens which have a different finalization
// process entirely.

const CHAIN_ID = 137;
enum POLYGON_MESSAGE_STATUS {
  NOT_CHECKPOINTED = "NOT_CHECKPOINTED",
  CAN_EXIT = "CAN_EXIT",
  EXIT_ALREADY_PROCESSED = "EXIT_ALREADY_PROCESSED",
  UNKNOWN_EXIT_FAILURE = "UNKNOWN_EXIT_FAILURE",
}
// Unique signature used to identify Polygon L2 transactions that were erc20 withdrawals from the Polygon
// canonical bridge. Do not change.
const BURN_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface PolygonTokensBridged extends TokensBridged {
  payload: string;
}

export async function polygonFinalizer(
  logger: winston.Logger,
  signer: Wallet,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  latestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const { chainId } = spokePoolClient;

  const posClient = await getPosClient(signer);
  logger.debug({
    at: "Finalizer#polygonFinalizer",
    message: `Earliest TokensBridged block to attempt to finalize for ${getNetworkName(chainId)}`,
    latestBlockToFinalize,
  });

  // Unlike the rollups, withdrawals process very quickly on polygon, so we can conservatively remove any events
  // that are older than 1 day old:
  const recentTokensBridgedEvents = spokePoolClient
    .getTokensBridged()
    .filter((e) => e.blockNumber >= latestBlockToFinalize);

  return await multicallPolygonFinalizations(recentTokensBridgedEvents, posClient, signer, hubPoolClient, logger);
}

async function getPosClient(mainnetSigner: Wallet): Promise<POSClient> {
  // Following from https://maticnetwork.github.io/matic.js/docs/pos
  use(Web3ClientPlugin);
  setProofApi("https://apis.matic.network/");
  const posClient = new POSClient();
  return await posClient.init({
    network: "mainnet",
    version: "v1",
    parent: {
      provider: mainnetSigner,
      defaultConfig: {
        from: mainnetSigner.address,
      },
    },
    child: {
      provider: mainnetSigner.connect(getCachedProvider(CHAIN_ID, true)),
      defaultConfig: {
        from: mainnetSigner.address,
      },
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
  const logIndexesForMessage = {};
  const checkpointedTokensBridged = tokensBridged
    .filter((_, i) => isCheckpointed[i])
    .map((_tokensBridged) => {
      if (logIndexesForMessage[_tokensBridged.transactionHash] === undefined) {
        logIndexesForMessage[_tokensBridged.transactionHash] = 0;
      }
      return {
        logIndex: logIndexesForMessage[_tokensBridged.transactionHash]++,
        event: _tokensBridged,
      };
    });

  // Construct the payload we'll need to finalize each L2 transaction that has been checkpointed to Mainnet and
  // can potentially be finalized.
  const payloads = await Promise.all(
    checkpointedTokensBridged.map((e) => {
      return posClient.exitUtil.buildPayloadForExit(e.event.transactionHash, BURN_SIG, false, e.logIndex);
    })
  );

  const finalizableMessages: PolygonTokensBridged[] = [];
  const exitStatus = await Promise.all(
    checkpointedTokensBridged.map(async (_, i) => {
      const payload = payloads[i];
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
  hubSigner: Wallet,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<{ callData: Multicall2Call[]; withdrawals: Withdrawal[] }> {
  const finalizableMessages = await getFinalizableTransactions(logger, tokensBridged, posClient);
  const callData = await Promise.all(finalizableMessages.map((event) => finalizePolygon(posClient, event)));
  const tokensInFinalizableMessages = getL2TokensToFinalize(
    finalizableMessages.map((polygonTokensBridged) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { payload, ...tokensBridged } = polygonTokensBridged;
      return tokensBridged;
    })
  );
  const callDataRetrievals = await Promise.all(
    tokensInFinalizableMessages.map((l2Token) =>
      retrieveTokenFromMainnetTokenBridger(l2Token, hubSigner, hubPoolClient)
    )
  );
  callData.push(...callDataRetrievals);
  const withdrawals = finalizableMessages.map((message) => {
    const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
      CHAIN_ID,
      message.l2TokenAddress,
      hubPoolClient.latestBlockNumber
    );
    const l1TokenInfo = hubPoolClient.getTokenInfo(1, l1TokenCounterpart);
    const amountFromWei = convertFromWei(message.amountToReturn.toString(), l1TokenInfo.decimals);
    const withdrawal: Withdrawal = {
      l2ChainId: CHAIN_ID,
      l1TokenSymbol: l1TokenInfo.symbol,
      amount: amountFromWei,
      type: "withdrawal",
    };
    return withdrawal;
  });
  return {
    callData,
    withdrawals,
  };
}

function getMainnetTokenBridger(mainnetSigner: Wallet): Contract {
  return getDeployedContract("PolygonTokenBridger", 1, mainnetSigner);
}

async function retrieveTokenFromMainnetTokenBridger(
  l2Token: string,
  mainnetSigner: Wallet,
  hubPoolClient: HubPoolClient
): Promise<Multicall2Call> {
  const l1Token = hubPoolClient.getL1TokenCounterpartAtBlock(CHAIN_ID, l2Token, hubPoolClient.latestBlockNumber);
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
