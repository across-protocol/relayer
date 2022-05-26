import { setProofApi, use, POSClient } from "@maticnetwork/maticjs";
import { Web3ClientPlugin } from "@maticnetwork/maticjs-ethers";
import { Contract, ERC20, ethers, getDeployedContract, getProvider, toBN, Wallet, winston } from "../../utils";
import { TokensBridged } from "../../interfaces";
import { HubPoolClient } from "../../clients";

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
      provider: mainnetSigner.connect(getProvider(137)),
      defaultConfig: {
        from: mainnetSigner.address,
      },
    },
  });
}

export async function getFinalizableTransactions(
  tokensBridged: TokensBridged[],
  posClient: POSClient,
  hubPoolClient: HubPoolClient
) {
  const isCheckpointed = await Promise.all(
    tokensBridged.map((event) => posClient.exitUtil.isCheckPointed(event.transactionHash))
  );
  const withdrawExitedOrIsNotCheckpointed = await Promise.all(
    tokensBridged.map((event, i) => {
      if (!isCheckpointed[i]) return new Promise((resolve) => resolve(true));
      const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
        "137",
        event.l2TokenAddress,
        hubPoolClient.latestBlockNumber
      );
      return posClient.erc20(l1TokenCounterpart, true).isWithdrawExited(event.transactionHash);
    })
  );
  return tokensBridged.filter((_, i) => !withdrawExitedOrIsNotCheckpointed[i]);
}

export async function finalizePolygon(
  posClient: POSClient,
  hubPoolClient: HubPoolClient,
  event: TokensBridged,
  logger: winston.Logger
) {
  const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
    "137",
    event.l2TokenAddress,
    hubPoolClient.latestBlockNumber
  );
  logger.debug({
    at: "PolygonFinalizer",
    message: "Finalizable token bridge, submitting exit transaction",
    l1TokenCounterpart,
    event,
  });
  const result = await posClient.erc20(l1TokenCounterpart, true).withdrawExitFaster(event.transactionHash);
  const receipt = await result.getReceipt(); // Wait for confirmation.
  logger.info({
    at: "PolygonFinalizer",
    message: "Executed",
    transaction: receipt.transactionHash,
  });
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
  const l1Token = hubPoolClient.getL1TokenCounterpartAtBlock("137", l2Token, hubPoolClient.latestBlockNumber);
  const mainnetTokenBridger = getMainnetTokenBridger(mainnetSigner);
  const token = new Contract(l1Token, ERC20.abi, mainnetSigner);
  const l1TokenInfo = hubPoolClient.getTokenInfo(1, l1Token);
  const balance = await token.balanceOf(mainnetTokenBridger.address);

  // WETH is sent to token bridger contract as ETH.
  const ethBalance = await mainnetTokenBridger.provider.getBalance(mainnetTokenBridger.address);
  const balanceToRetrieve = l1TokenInfo.symbol === "WETH" ? ethBalance : balance;
  if (balanceToRetrieve.eq(toBN(0))) {
    logger.debug({
      at: "PolygonFinalizer",
      message: `No ${l1TokenInfo.symbol} balance to withdraw, skipping`,
    });
    return false;
  } else {
    logger.debug({
      at: "PolygonFinalizer",
      message: `Retrieving ${balanceToRetrieve.toString()} ${l1TokenInfo.symbol}`,
    });
    const txn = await mainnetTokenBridger.retrieve(l1Token);
    const receipt = await txn.wait(); // Wait for confirmation.
    logger.info({
      at: "PolygonFinalizer",
      message: `Retrieved ${ethers.utils.formatUnits(balanceToRetrieve.toString(), l1TokenInfo.decimals)} ${
        l1TokenInfo.symbol
      } from PolygonTokenBridger 🏧!`,
      transaction: receipt.transactionHash,
      l1Token,
      amount: balanceToRetrieve.toString(),
    });
  }
}

export function getL2TokensToFinalize(events: TokensBridged[]) {
  const l2TokenCountInBridgeEvents = events.reduce((l2TokenDictionary, event) => {
    l2TokenDictionary[event.l2TokenAddress] = true;
    return l2TokenDictionary;
  }, {});
  return Object.keys(l2TokenCountInBridgeEvents).filter((token) => l2TokenCountInBridgeEvents[token] === true);
}
