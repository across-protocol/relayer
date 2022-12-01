import * as optimismSDK from "@eth-optimism/sdk";
import { Multicall2Call, Withdrawal } from "..";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { L1Token, TokensBridged } from "../../interfaces";
import { convertFromWei, ethers, getNodeUrlList, groupObjectCountsByProp, Wallet, winston } from "../../utils";

const CHAIN_ID = 10;

export function getOptimismClient(hubSigner: Wallet): optimismSDK.CrossChainMessenger {
  return new optimismSDK.CrossChainMessenger({
    l1ChainId: 1,
    l2ChainId: CHAIN_ID,
    l1SignerOrProvider: hubSigner.connect(new ethers.providers.JsonRpcProvider(getNodeUrlList(1)[0])),
    l2SignerOrProvider: hubSigner.connect(new ethers.providers.JsonRpcProvider(getNodeUrlList(CHAIN_ID)[0])),
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
            await crossChainMessenger.getMessagesByTransaction(l2Event.transactionHash, {
              direction: optimismSDK.MessageDirection.L2_TO_L1,
            })
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
): Promise<CrossChainMessageWithStatus[]> {
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

export function getL1TokenInfoForOptimismToken(hubPoolClient: HubPoolClient, l2Token: string): L1Token {
  return hubPoolClient.getL1TokenInfoForL2Token(
    SpokePoolClient.getExecutedRefundLeafL2Token(CHAIN_ID, l2Token),
    CHAIN_ID
  );
}

export async function finalizeOptimismMessage(
  crossChainMessenger: optimismSDK.CrossChainMessenger,
  message: CrossChainMessageWithStatus
): Promise<Multicall2Call> {
  const callData = await crossChainMessenger.populateTransaction.finalizeMessage(message.message);
  return {
    callData: callData.data,
    target: callData.to,
  };
}

export async function multicallOptimismFinalizations(
  tokensBridgedEvents: TokensBridged[],
  crossChainMessenger: optimismSDK.CrossChainMessenger,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<{ callData: Multicall2Call[]; withdrawals: Withdrawal[] }> {
  const finalizableMessages = await getOptimismFinalizableMessages(logger, tokensBridgedEvents, crossChainMessenger);
  const callData = await Promise.all(
    finalizableMessages.map((message) => finalizeOptimismMessage(crossChainMessenger, message))
  );
  const withdrawals = finalizableMessages.map((message) => {
    const l1TokenInfo = getL1TokenInfoForOptimismToken(hubPoolClient, message.event.l2TokenAddress);
    const amountFromWei = convertFromWei(message.event.amountToReturn.toString(), l1TokenInfo.decimals);
    return {
      l2ChainId: CHAIN_ID,
      l1TokenSymbol: l1TokenInfo.symbol,
      amount: amountFromWei,
    };
  });
  return {
    callData,
    withdrawals,
  };
}
