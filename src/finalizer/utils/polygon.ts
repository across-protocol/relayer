import { setProofApi, use, POSClient } from "@maticnetwork/maticjs";
import { Web3ClientPlugin } from "@maticnetwork/maticjs-ethers";
import {
  Contract,
  convertFromWei,
  delay,
  ERC20,
  ethers,
  etherscanLink,
  getDeployedContract,
  getProvider,
  groupObjectCountsByProp,
  toBN,
  Wallet,
  winston,
} from "../../utils";
import { TokensBridged } from "../../interfaces";
import { HubPoolClient } from "../../clients";

// Note!!: This client will only work for PoS tokens. Matic also has Plasma tokens which have a different finalization
// process entirely.

const CHAIN_ID = 137;
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
    tokensBridged.map(async (event, i) => {
      if (!isCheckpointed[i]) return { status: POLYGON_MESSAGE_STATUS.NOT_CHECKPOINTED };
      const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
        CHAIN_ID.toString(),
        event.l2TokenAddress,
        hubPoolClient.latestBlockNumber
      );
      return posClient
        .erc20(l1TokenCounterpart, true)
        .isWithdrawExited(event.transactionHash)
        .then((result) =>
          result ? { status: POLYGON_MESSAGE_STATUS.ALREADY_EXITED } : { status: POLYGON_MESSAGE_STATUS.CAN_EXIT }
        );
    })
  );
  logger.debug({
    at: "PolygonFinalizer",
    message: `Polygon message statuses`,
    statusesGrouped: groupObjectCountsByProp(exitStatus, (message: { status: string }) => message.status),
  });
  return tokensBridged.filter((_, i) => exitStatus[i].status === POLYGON_MESSAGE_STATUS.CAN_EXIT);
}

export async function finalizePolygon(
  posClient: POSClient,
  hubPoolClient: HubPoolClient,
  event: TokensBridged,
  logger: winston.Logger
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
  const l1TokenInfo = hubPoolClient.getTokenInfo(1, l1TokenCounterpart);
  const amountFromWei = convertFromWei(event.amountToReturn.toString(), l1TokenInfo.decimals);
  try {
    const txn = await posClient.erc20(l1TokenCounterpart, true).withdrawExitFaster(event.transactionHash);
    const receipt = await txn.getReceipt();
    logger.debug({
      at: "PolygonFinalizer",
      message: `Finalized Polygon withdrawal for ${amountFromWei} of ${l1TokenInfo.symbol} 🪃`,
      transactionhash: receipt.transactionHash,
    });
    await delay(30);
  } catch (error) {
    logger.warn({
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
  hubPoolClient: HubPoolClient
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
      const txn = await mainnetTokenBridger.retrieve(l1Token);
      logger.info({
        at: "PolygonFinalizer",
        message: `Retrieved ${balanceFromWei} of ${l1TokenInfo.symbol} from PolygonTokenBridger 🪃`,
        transactionhash: etherscanLink(txn.hash, 1),
      });
      await delay(30);
    } catch (error) {
      logger.warn({
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
