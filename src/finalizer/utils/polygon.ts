import { setProofApi, use, POSClient } from "@maticnetwork/maticjs";
import { Web3ClientPlugin } from "@maticnetwork/maticjs-ethers";
import {
  Contract,
  convertFromWei,
  ERC20,
  ethers,
  getDeployedContract,
  getProvider,
  groupObjectCountsByProp,
  toBN,
  Wallet,
  winston,
} from "../../utils";
import { TokensBridged } from "../../interfaces";
import { HubPoolClient, MultiCallerClient } from "../../clients";

const CHAIN_ID = 137;
const POLYGON_MESSAGE_SENT_EVENT_SIG = "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036";
enum POLYGON_MESSAGE_STATUS {
  NOT_CHECKPOINTED = "NOT_CHECKPOINTED",
  ALREADY_EXITED = "ALREADY_EXITED",
  CAN_EXIT = "CAN_EXIT",
}

export async function getPosClient(mainnetSigner: Wallet) {
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
      provider: mainnetSigner.connect(getProvider(CHAIN_ID)),
      defaultConfig: {
        from: mainnetSigner.address,
      },
    },
  });
}

export async function getFinalizableTransactions(
  logger: winston.Logger,
  tokensBridged: TokensBridged[],
  posClient: POSClient,
  hubPoolClient: HubPoolClient
) {
  const isCheckpointed = await Promise.all(
    tokensBridged.map((event) => posClient.exitUtil.isCheckPointed(event.transactionHash))
  );
  const exitStatus = await Promise.all(
    tokensBridged.map((event, i) => {
      if (!isCheckpointed[i])
        return new Promise((resolve) => resolve({ status: POLYGON_MESSAGE_STATUS.NOT_CHECKPOINTED }));
      const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
        CHAIN_ID.toString(),
        event.l2TokenAddress,
        hubPoolClient.latestBlockNumber
      );
      return posClient.erc20(l1TokenCounterpart, true).isWithdrawExited(event.transactionHash)
        ? new Promise((resolve) => resolve({ status: POLYGON_MESSAGE_STATUS.ALREADY_EXITED }))
        : new Promise((resolve) => resolve({ status: POLYGON_MESSAGE_STATUS.CAN_EXIT }));
    })
  );
  logger.debug({
    at: "PolygonFinalizer",
    message: `Polygon message statuses`,
    statusesGrouped: groupObjectCountsByProp(exitStatus, (message: { status: string }) => message.status),
  });
  return tokensBridged.filter((_, i) => exitStatus[i] === POLYGON_MESSAGE_STATUS.CAN_EXIT);
}

export async function finalizePolygon(
  posClient: POSClient,
  hubPoolClient: HubPoolClient,
  event: TokensBridged,
  logger: winston.Logger,
  multicallerClient: MultiCallerClient
) {
  const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
    CHAIN_ID.toString(),
    event.l2TokenAddress,
    hubPoolClient.latestBlockNumber
  );
  logger.debug({
    at: "PolygonFinalizer",
    message: "Finalizable token bridge, submitting exit transaction",
    l1TokenCounterpart,
    event,
  });
  const exitPayload = await posClient.exitUtil.buildPayloadForExit(
    event.transactionHash,
    POLYGON_MESSAGE_SENT_EVENT_SIG,
    false
  );
  const rootchainManager = new Contract(
    "0x6abb753c1893194de4a83c6e8b4eadfc105fd5f5",
    minimumRootChainAbi,
    hubPoolClient.hubPool.signer
  );
  const l1TokenInfo = hubPoolClient.getTokenInfo(1, l1TokenCounterpart);
  const amountFromWei = convertFromWei(event.amountToReturn.toString(), l1TokenInfo.decimals);
  try {
    multicallerClient.enqueueTransaction({
      contract: rootchainManager,
      chainId: 1,
      method: "exit",
      args: [exitPayload],
      message: `Finalized Polygon withdrawal 🪃`,
      mrkdwn: `Received ${amountFromWei} of ${l1TokenInfo.symbol} 🪃`,
    });
  } catch (error) {
    logger.error({
      at: "PolygonFinalizer",
      message: "Error creating exitTx",
      error,
      notificationPath: "across-error",
    });
  }
}

export function getMainnetTokenBridger(mainnetSigner: Wallet) {
  return getDeployedContract("PolygonTokenBridger", 1, mainnetSigner);
}

export async function retrieveTokenFromMainnetTokenBridger(
  logger: winston.Logger,
  l2Token: string,
  mainnetSigner: Wallet,
  hubPoolClient: HubPoolClient,
  multicallerClient: MultiCallerClient
): Promise<boolean> {
  const l1Token = hubPoolClient.getL1TokenCounterpartAtBlock(
    CHAIN_ID.toString(),
    l2Token,
    hubPoolClient.latestBlockNumber
  );
  const mainnetTokenBridger = getMainnetTokenBridger(mainnetSigner);
  const token = new Contract(l1Token, ERC20.abi, mainnetSigner);
  const l1TokenInfo = hubPoolClient.getTokenInfo(1, l1Token);
  const balance = await token.balanceOf(mainnetTokenBridger.address);

  // WETH is sent to token bridger contract as ETH.
  const ethBalance = await mainnetTokenBridger.provider.getBalance(mainnetTokenBridger.address);
  const balanceToRetrieve = l1TokenInfo.symbol === "WETH" ? ethBalance : balance;
  const balanceFromWei = ethers.utils.formatUnits(balanceToRetrieve.toString(), l1TokenInfo.decimals);
  if (balanceToRetrieve.eq(toBN(0))) {
    return false;
  } else {
    logger.debug({
      at: "PolygonFinalizer",
      message: `Retrieving ${balanceToRetrieve.toString()} ${l1TokenInfo.symbol} from PolygonTokenBridger`,
    });
    try {
      multicallerClient.enqueueTransaction({
        contract: mainnetTokenBridger,
        chainId: 1,
        method: "retrieve",
        args: [l1Token],
        message: `Finalized polygon retrieval for ${balanceFromWei} of ${l1TokenInfo.symbol}`,
        mrkdwn: `Finalized polygon retrieval for ${balanceFromWei} of ${l1TokenInfo.symbol}`,
      });
    } catch (error) {
      logger.error({
        at: "PolygonFinalizer",
        message: "Error creating retrieveTx",
        error,
        notificationPath: "across-error",
      });
    }
  }
}

export function getL2TokensToFinalize(events: TokensBridged[]) {
  const l2TokenCountInBridgeEvents = events.reduce((l2TokenDictionary, event) => {
    l2TokenDictionary[event.l2TokenAddress] = true;
    return l2TokenDictionary;
  }, {});
  return Object.keys(l2TokenCountInBridgeEvents).filter((token) => l2TokenCountInBridgeEvents[token] === true);
}

export const minimumRootChainAbi = [
  {
    inputs: [{ internalType: "bytes", name: "inputData", type: "bytes" }],
    name: "exit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];
