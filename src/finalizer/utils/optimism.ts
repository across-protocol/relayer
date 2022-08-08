import * as optimismSDK from "@eth-optimism/sdk";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { TokensBridged } from "../../interfaces";
import {
  convertFromWei,
  delay,
  etherscanLink,
  getProvider,
  groupObjectCountsByProp,
  Wallet,
  winston,
} from "../../utils";

const CHAIN_ID = 10;

export function getOptimismClient(mainnetSigner: Wallet) {
  return new optimismSDK.CrossChainMessenger({
    l1ChainId: 1,
    l1SignerOrProvider: mainnetSigner,
    l2SignerOrProvider: mainnetSigner.connect(getProvider(10)),
  });
}

export interface CrossChainMessageWithEvent {
  event: TokensBridged;
  message: optimismSDK.MessageLike;
}
export async function getCrossChainMessages(
  tokensBridged: TokensBridged[],
  crossChainMessenger: optimismSDK.CrossChainMessenger
): Promise<CrossChainMessageWithEvent[]> {
  // For each token bridge event, store a unique log index for the event within the optimism transaction hash.
  // This is important for bridge transactions containing multiple events.
  const uniqueTokenhashes = {};
  const logIndexesForMessage = [];
  for (const event of tokensBridged) {
    uniqueTokenhashes[event.transactionHash] = uniqueTokenhashes[event.transactionHash] ?? 0;
    const logIndex = uniqueTokenhashes[event.transactionHash];
    logIndexesForMessage.push(logIndex);
    uniqueTokenhashes[event.transactionHash] += 1;
  }
  return (
    await Promise.all(
      tokensBridged.map(
        async (l2Event, i) =>
          (
            await crossChainMessenger.getMessagesByTransaction(l2Event.transactionHash)
          )[logIndexesForMessage[i]]
      )
    )
  ).map((message, i) => {
    return {
      message,
      event: tokensBridged[i],
    };
  });
}

export interface CrossChainMessageWithStatus extends CrossChainMessageWithEvent {
  status: string;
}
export async function getMessageStatuses(
  crossChainMessages: CrossChainMessageWithEvent[],
  crossChainMessenger: optimismSDK.CrossChainMessenger
): Promise<CrossChainMessageWithStatus[]> {
  const statuses = await Promise.all(
    crossChainMessages.map((message) => {
      return crossChainMessenger.getMessageStatus(message.message);
    })
  );
  return statuses.map((status, i) => {
    return {
      status: optimismSDK.MessageStatus[status],
      message: crossChainMessages[i].message,
      event: crossChainMessages[i].event,
    };
  });
}

export async function getOptimismFinalizableMessages(
  logger: winston.Logger,
  tokensBridged: TokensBridged[],
  crossChainMessenger: optimismSDK.CrossChainMessenger
) {
  const crossChainMessages = await getCrossChainMessages(tokensBridged, crossChainMessenger);
  const messageStatuses = await getMessageStatuses(crossChainMessages, crossChainMessenger);
  logger.debug({
    at: "OptimismFinalizer",
    message: "Optimism message statuses",
    statusesGrouped: groupObjectCountsByProp(messageStatuses, (message: CrossChainMessageWithStatus) => message.status),
  });
  return messageStatuses.filter(
    (message) => message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_FOR_RELAY]
  );
}

export function getL1TokenInfoForOptimismToken(hubPoolClient: HubPoolClient, l2Token: string) {
  return hubPoolClient.getL1TokenInfoForL2Token(SpokePoolClient.getExecutedRefundLeafL2Token(10, l2Token), CHAIN_ID);
}

export async function finalizeOptimismMessage(
  hubPoolClient: HubPoolClient,
  crossChainMessenger: optimismSDK.CrossChainMessenger,
  message: CrossChainMessageWithStatus,
  logger: winston.Logger
) {
  // Need to handle special case where WETH is bridged as ETH and the contract address changes.
  const l1TokenInfo = getL1TokenInfoForOptimismToken(hubPoolClient, message.event.l2TokenAddress);
  const amountFromWei = convertFromWei(message.event.amountToReturn.toString(), l1TokenInfo.decimals);
  try {
    const txn = await crossChainMessenger.finalizeMessage(message.message);
    logger.info({
      at: "OptimismFinalizer",
      message: `Finalized Optimism withdrawal for ${amountFromWei} of ${l1TokenInfo.symbol} 🪃`,
      transactionHash: etherscanLink(txn.hash, 1),
    });
    await delay(30);
  } catch (error) {
    logger.warn({
      at: "OptimismFinalizer",
      message: "Error creating relayMessageTx",
      error,
      notificationPath: "across-error",
    });
  }
}
