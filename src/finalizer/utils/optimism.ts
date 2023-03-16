import * as optimismSDK from "@eth-optimism/sdk";
import * as bobaSDK from "@across-protocol/boba-sdk";
import { Multicall2Call, Withdrawal } from "..";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { L1Token, TokensBridged } from "../../interfaces";
import { convertFromWei, ethers, getNodeUrlList, groupObjectCountsByProp, Wallet, winston } from "../../utils";

type OVM_CHAIN_ID = 10 | 288;
type OVM_CROSS_CHAIN_MESSENGER = optimismSDK.CrossChainMessenger | bobaSDK.CrossChainMessenger;

export function getOptimismClient(chainId: OVM_CHAIN_ID, hubSigner: Wallet): OVM_CROSS_CHAIN_MESSENGER {
  if (chainId === 288) {
    return new bobaSDK.CrossChainMessenger({
      l1ChainId: 1,
      l1SignerOrProvider: hubSigner.connect(new ethers.providers.JsonRpcProvider(getNodeUrlList(1)[0])),
      l2SignerOrProvider: hubSigner.connect(new ethers.providers.JsonRpcProvider(getNodeUrlList(chainId)[0])),
      contracts: { ...bobaSDK.CONTRACT_ADDRESSES[1] }, // Override with Boba system addresses
    });
  } else
    return new optimismSDK.CrossChainMessenger({
      l1ChainId: 1,
      l2ChainId: chainId,
      l1SignerOrProvider: hubSigner.connect(new ethers.providers.JsonRpcProvider(getNodeUrlList(1)[0])),
      l2SignerOrProvider: hubSigner.connect(new ethers.providers.JsonRpcProvider(getNodeUrlList(chainId)[0])),
    });
}

export interface CrossChainMessageWithEvent {
  event: TokensBridged;
  message: optimismSDK.MessageLike | bobaSDK.MessageLike;
}
export async function getCrossChainMessages(
  chainId: OVM_CHAIN_ID,
  tokensBridged: TokensBridged[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER
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
              direction: chainId === 10 ? optimismSDK.MessageDirection.L2_TO_L1 : bobaSDK.MessageDirection.L2_TO_L1,
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
  chainId: OVM_CHAIN_ID,
  crossChainMessages: CrossChainMessageWithEvent[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER
): Promise<CrossChainMessageWithStatus[]> {
  if (chainId === 288) {
    const statuses = await Promise.all(
      crossChainMessages.map((message) => {
        return (crossChainMessenger as bobaSDK.CrossChainMessenger).getMessageStatus(
          message.message as bobaSDK.MessageLike
        );
      })
    );
    return statuses.map((status, i) => {
      return {
        status: bobaSDK.MessageStatus[status],
        message: crossChainMessages[i].message,
        event: crossChainMessages[i].event,
      };
    });
  } else {
    const statuses = await Promise.all(
      crossChainMessages.map((message) => {
        return (crossChainMessenger as optimismSDK.CrossChainMessenger).getMessageStatus(
          message.message as optimismSDK.MessageLike
        );
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
}

export async function getOptimismFinalizableMessages(
  chainId: OVM_CHAIN_ID,
  logger: winston.Logger,
  tokensBridged: TokensBridged[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER
): Promise<CrossChainMessageWithStatus[]> {
  const crossChainMessages = await getCrossChainMessages(chainId, tokensBridged, crossChainMessenger);
  const messageStatuses = await getMessageStatuses(chainId, crossChainMessages, crossChainMessenger);
  logger.debug({
    at: `${chainId === 10 ? "Optimism" : "Boba"}Finalizer`,
    message: `${chainId === 10 ? "Optimism" : "Boba"} message statuses`,
    statusesGrouped: groupObjectCountsByProp(messageStatuses, (message: CrossChainMessageWithStatus) => message.status),
  });
  if (chainId == 10)
    return messageStatuses.filter(
      (message) => message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_FOR_RELAY]
    );
  else
    return messageStatuses.filter(
      (message) => message.status === bobaSDK.MessageStatus[bobaSDK.MessageStatus.READY_FOR_RELAY]
    );
}

export function getL1TokenInfoForOptimismToken(
  chainId: OVM_CHAIN_ID,
  hubPoolClient: HubPoolClient,
  l2Token: string
): L1Token {
  return hubPoolClient.getL1TokenInfoForL2Token(
    SpokePoolClient.getExecutedRefundLeafL2Token(chainId, l2Token),
    chainId
  );
}

export async function finalizeOptimismMessage(
  chainId: OVM_CHAIN_ID,
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER,
  message: CrossChainMessageWithStatus
): Promise<Multicall2Call> {
  if (chainId === 10) {
    const callData = await (crossChainMessenger as optimismSDK.CrossChainMessenger).populateTransaction.finalizeMessage(
      message.message as optimismSDK.MessageLike
    );
    return {
      callData: callData.data,
      target: callData.to,
    };
  } else {
    const callData = await (crossChainMessenger as bobaSDK.CrossChainMessenger).populateTransaction.finalizeMessage(
      message.message as bobaSDK.MessageLike
    );
    return {
      callData: callData.data,
      target: callData.to,
    };
  }
}

export async function multicallOptimismFinalizations(
  chainId: OVM_CHAIN_ID,
  tokensBridgedEvents: TokensBridged[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<{ callData: Multicall2Call[]; withdrawals: Withdrawal[] }> {
  const finalizableMessages = await getOptimismFinalizableMessages(
    chainId,
    logger,
    tokensBridgedEvents,
    crossChainMessenger
  );
  const callData = await Promise.all(
    finalizableMessages.map((message) => finalizeOptimismMessage(chainId, crossChainMessenger, message))
  );
  const withdrawals = finalizableMessages.map((message) => {
    const l1TokenInfo = getL1TokenInfoForOptimismToken(chainId, hubPoolClient, message.event.l2TokenAddress);
    const amountFromWei = convertFromWei(message.event.amountToReturn.toString(), l1TokenInfo.decimals);
    return {
      l2ChainId: chainId,
      l1TokenSymbol: l1TokenInfo.symbol,
      amount: amountFromWei,
    };
  });
  return {
    callData,
    withdrawals,
  };
}
