import * as optimismSDK from "@eth-optimism/sdk";
import { Withdrawal } from "..";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { L1Token, TokensBridged } from "../../interfaces";
import { BigNumber, convertFromWei, getCachedProvider, groupObjectCountsByProp, Wallet, winston } from "../../utils";
import { Multicall2Call } from "../../common";

type OVM_CHAIN_ID = 10;
type OVM_CROSS_CHAIN_MESSENGER = optimismSDK.CrossChainMessenger;

export function getOptimismClient(chainId: OVM_CHAIN_ID, hubSigner: Wallet): OVM_CROSS_CHAIN_MESSENGER {
  return new optimismSDK.CrossChainMessenger({
    bedrock: true,
    l1ChainId: 1,
    l2ChainId: chainId,
    l1SignerOrProvider: hubSigner.connect(getCachedProvider(1, true)),
    l2SignerOrProvider: hubSigner.connect(getCachedProvider(10, true)),
  });
}

export interface CrossChainMessageWithEvent {
  event: TokensBridged;
  message: optimismSDK.MessageLike;
}
export async function getCrossChainMessages(
  _chainId: OVM_CHAIN_ID,
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
  _chainId: OVM_CHAIN_ID,
  crossChainMessages: CrossChainMessageWithEvent[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER
): Promise<CrossChainMessageWithStatus[]> {
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

export async function getOptimismFinalizableMessages(
  chainId: OVM_CHAIN_ID,
  logger: winston.Logger,
  tokensBridged: TokensBridged[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER
): Promise<CrossChainMessageWithStatus[]> {
  const crossChainMessages = await getCrossChainMessages(chainId, tokensBridged, crossChainMessenger);
  // Temporary fix until we're well past the bedrock upgrade. Remove non Bedrock messages.
  // Example way to detect whether message is bedrock:
  // - https://github.com/ethereum-optimism/optimism/blob/develop/packages/sdk/src/cross-chain-messenger.ts#L332
  // - https://github.com/ethereum-optimism/optimism/blob/develop/packages/core-utils/src/optimism/encoding.ts#L34
  const bedrockMessages = (
    await Promise.all(
      crossChainMessages.map(async (crossChainMessage) => {
        const resolved = await crossChainMessenger.toCrossChainMessage(crossChainMessage.message);
        const version = BigNumber.from(resolved.messageNonce).shr(240).toNumber();
        if (version !== 1) {
          return undefined;
        } else {
          return crossChainMessage;
        }
      })
    )
  ).filter((m) => m !== undefined);
  // Temporarily filter out messages with multiple withdrawals until eth-optimism sdk can handle them:
  // https://github.com/ethereum-optimism/optimism/issues/5983
  const messagesWithSingleWithdrawals = bedrockMessages.filter(
    (message, i) =>
      !crossChainMessages.some(
        (otherMessage, j) => i !== j && otherMessage.event.transactionHash === message.event.transactionHash
      )
  );
  const messageStatuses = await getMessageStatuses(chainId, messagesWithSingleWithdrawals, crossChainMessenger);
  logger.debug({
    at: "OptimismFinalizer",
    message: "Optimism message statuses",
    statusesGrouped: groupObjectCountsByProp(messageStatuses, (message: CrossChainMessageWithStatus) => message.status),
  });
  return messageStatuses.filter(
    (message) =>
      message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_FOR_RELAY] ||
      message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_TO_PROVE]
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
  _chainId: OVM_CHAIN_ID,
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER,
  message: CrossChainMessageWithStatus
): Promise<Multicall2Call> {
  const callData = await (crossChainMessenger as optimismSDK.CrossChainMessenger).populateTransaction.finalizeMessage(
    message.message as optimismSDK.MessageLike
  );
  return {
    callData: callData.data,
    target: callData.to,
  };
}

export async function proveOptimismMessage(
  _chainId: OVM_CHAIN_ID,
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER,
  message: CrossChainMessageWithStatus
): Promise<Multicall2Call> {
  const callData = await (crossChainMessenger as optimismSDK.CrossChainMessenger).populateTransaction.proveMessage(
    message.message as optimismSDK.MessageLike
  );
  return {
    callData: callData.data,
    target: callData.to,
  };
}

export async function multicallOptimismFinalizations(
  chainId: OVM_CHAIN_ID,
  tokensBridgedEvents: TokensBridged[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<{ callData: Multicall2Call[]; withdrawals: Withdrawal[] }> {
  const finalizableMessages = (
    await getOptimismFinalizableMessages(chainId, logger, tokensBridgedEvents, crossChainMessenger)
  ).filter((message) => message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_FOR_RELAY]);
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

export async function multicallOptimismL1Proofs(
  chainId: OVM_CHAIN_ID,
  tokensBridgedEvents: TokensBridged[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<{ callData: Multicall2Call[]; withdrawals: Withdrawal[] }> {
  const provableMessages = (
    await getOptimismFinalizableMessages(chainId, logger, tokensBridgedEvents, crossChainMessenger)
  ).filter((message) => message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_TO_PROVE]);
  const callData = await Promise.all(
    provableMessages.map((message) => proveOptimismMessage(chainId, crossChainMessenger, message))
  );
  const withdrawals = provableMessages.map((message) => {
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
