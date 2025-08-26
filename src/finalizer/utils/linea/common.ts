import { LineaSDK, Message, OnChainMessageStatus } from "@consensys/linea-sdk";
import { Linea_Adapter__factory } from "@across-protocol/contracts";
import {
  BigNumber,
  Contract,
  EventSearchConfig,
  TOKEN_SYMBOLS_MAP,
  TransactionReceipt,
  compareAddressesSimple,
  ethers,
  getBlockForTimestamp,
  getCurrentTime,
  getNodeUrlList,
  getRedisCache,
  paginatedEventQuery,
  CHAIN_IDs,
  getTokenInfo,
  winston,
  Signer,
  isSignerWallet,
  assert,
} from "../../../utils";
import { HubPoolClient } from "../../../clients";
import { CONTRACT_ADDRESSES } from "../../../common";
import { Log } from "../../../interfaces";
import { L1ClaimingService, L1MessageServiceContract, L2MessageServiceContract, MessageSentEvent } from "./imports";

export type MessageWithStatus = Message & {
  logIndex: number;
  status: OnChainMessageStatus;
  txHash: string;
};

export interface ParsedMessageSentLog {
  parsed: MessageSentEvent.Log;
  logIndex: number;
  transactionHash: string;
  blockNumber: number;
}

export const lineaAdapterIface = Linea_Adapter__factory.createInterface() as ethers.utils.Interface;

export function initLineaSdk(l1ChainId: number, l2ChainId: number, signer?: Signer): LineaSDK {
  assert(isSignerWallet(signer), "Signer is not a Wallet");
  return new LineaSDK({
    l1RpcUrl: Object.values(getNodeUrlList(l1ChainId))[0],
    l2RpcUrl: Object.values(getNodeUrlList(l2ChainId))[0],
    network: l1ChainId === CHAIN_IDs.MAINNET ? "linea-mainnet" : "linea-goerli",
    mode: "read-write",
    l1SignerPrivateKey: signer._signingKey().privateKey,
    l2SignerPrivateKey: signer._signingKey().privateKey,
  });
}

export function makeGetMessagesWithStatusByTxHash(
  l2Provider: ethers.providers.Provider,
  l1Provider: ethers.providers.Provider,
  l2MessageService: L2MessageServiceContract,
  l1ClaimingService: L1ClaimingService,
  l1SearchConfig: EventSearchConfig,
  l2SearchConfig: EventSearchConfig
) {
  /**
   * Retrieves Linea's MessageSent events for a given transaction hash and enhances them with their status.
   * Note that there can be multiple MessageSent events per transaction hash.
   * @param txHash Transaction hash to retrieve MessageSent events for.
   * @returns Array of MessageSent events with their status.
   */
  return async (txHashOrReceipt: string | TransactionReceipt): Promise<MessageWithStatus[]> => {
    const txReceipt =
      typeof txHashOrReceipt === "string" ? await l2Provider.getTransactionReceipt(txHashOrReceipt) : txHashOrReceipt;

    if (!txReceipt) {
      return [];
    }

    const messages = txReceipt.logs
      .filter((log) => log.address === l2MessageService.contractAddress)
      .flatMap((log) => {
        const parsedLog = l2MessageService.contract.interface.parseLog(log);

        if (!parsedLog || parsedLog.name !== "MessageSent") {
          return [];
        }

        const { _from, _to, _fee, _value, _nonce, _calldata, _messageHash } =
          parsedLog.args as unknown as MessageSentEvent.Log["args"];

        return {
          messageSender: _from,
          destination: _to,
          fee: _fee,
          value: _value,
          messageNonce: _nonce,
          calldata: _calldata,
          messageHash: _messageHash,
          txHash: txReceipt.transactionHash,
          logIndex: log.logIndex,
        };
      });
    const messageStatus = await Promise.all(
      messages.map((message) =>
        getL2L1MessageStatusUsingCustomProvider(
          l1ClaimingService,
          message.messageHash,
          l1Provider,
          l1SearchConfig,
          l2Provider,
          l2SearchConfig
        )
      )
    );
    return messages.map((message, index) => ({
      ...message,
      status: messageStatus[index],
    }));
  };
}

// Temporary re-implementation of the SDK's `L1ClaimingService.getMessageStatus` functions that allow us to use
// our custom provider, with retry and caching logic, to get around the SDK's hardcoded logic to query events
// from 0 to "latest" which will not work on all RPC's.
async function getL2L1MessageStatusUsingCustomProvider(
  messageService: L1ClaimingService,
  messageHash: string,
  l1Provider: ethers.providers.Provider,
  l1SearchConfig: EventSearchConfig,
  l2Provider: ethers.providers.Provider,
  l2SearchConfig: EventSearchConfig
): Promise<OnChainMessageStatus> {
  const l2Contract = getL2MessageServiceContractFromL1ClaimingService(messageService, l2Provider);
  const messageEvent = await getMessageSentEventForMessageHash(messageHash, l2Contract, l2SearchConfig);
  const l1Contract = getL1MessageServiceContractFromL1ClaimingService(messageService, l1Provider);
  const [l2MessagingBlockAnchoredEvents, isMessageClaimed] = await Promise.all([
    getL2MessagingBlockAnchoredFromMessageSentEvent(messageEvent, l1Contract, l1SearchConfig),
    l1Contract.isMessageClaimed(messageEvent.args?._nonce),
  ]);
  if (isMessageClaimed) {
    return OnChainMessageStatus.CLAIMED;
  }
  if (l2MessagingBlockAnchoredEvents.length > 0) {
    return OnChainMessageStatus.CLAIMABLE;
  }
  return OnChainMessageStatus.UNKNOWN;
}
export function getL2MessageServiceContractFromL1ClaimingService(
  l1ClaimingService: L1ClaimingService,
  l2Provider: ethers.providers.Provider
): Contract {
  const address = l1ClaimingService.l2Contract.contractAddress;
  const iface = new ethers.utils.Interface(l1ClaimingService.l2Contract.getContractAbi());
  return new Contract(address, iface, l2Provider);
}
export function getL1MessageServiceContractFromL1ClaimingService(
  l1ClaimingService: L1ClaimingService,
  l1Provider: ethers.providers.Provider
): Contract {
  const address = l1ClaimingService.l1Contract.contractAddress;
  const iface = new ethers.utils.Interface(l1ClaimingService.l1Contract.getContractAbi());
  return new Contract(address, iface, l1Provider);
}
export async function getMessageSentEventForMessageHash(
  messageHash: string,
  l2MessageServiceContract: Contract,
  l2SearchConfig: EventSearchConfig
): Promise<Log> {
  const [messageEvent] = await paginatedEventQuery(
    l2MessageServiceContract,
    l2MessageServiceContract.filters.MessageSent(null, null, null, null, null, null, messageHash),
    l2SearchConfig
  );
  if (!messageEvent) {
    throw new Error(`Message hash does not exist on L2. Message hash: ${messageHash}`);
  }
  return messageEvent;
}
export async function getL2MessagingBlockAnchoredFromMessageSentEvent(
  messageSentEvent: Log,
  l1MessageServiceContract: Contract,
  l1SearchConfig: EventSearchConfig
): Promise<Log[]> {
  const l2MessagingBlockAnchoredEvents = await paginatedEventQuery(
    l1MessageServiceContract,
    l1MessageServiceContract.filters.L2MessagingBlockAnchored(messageSentEvent.blockNumber),
    l1SearchConfig
  );
  return l2MessagingBlockAnchoredEvents;
}

export async function getBlockRangeByHoursOffsets(
  logger: winston.Logger,
  chainId: number,
  fromBlockHoursOffsetToNow: number,
  toBlockHoursOffsetToNow: number
): Promise<{ fromBlock: number; toBlock: number }> {
  if (fromBlockHoursOffsetToNow < toBlockHoursOffsetToNow) {
    throw new Error("fromBlockHoursOffsetToNow must be greater than toBlockHoursOffsetToNow");
  }

  const oneHourSeconds = 60 * 60;
  const redisCache = await getRedisCache();
  const currentTime = getCurrentTime();

  const fromBlockTimestamp = currentTime - fromBlockHoursOffsetToNow * oneHourSeconds;
  const toBlockTimestamp = currentTime - toBlockHoursOffsetToNow * oneHourSeconds;

  const [fromBlock, toBlock] = await Promise.all([
    getBlockForTimestamp(logger, chainId, fromBlockTimestamp, undefined, redisCache),
    getBlockForTimestamp(logger, chainId, toBlockTimestamp, undefined, redisCache),
  ]);

  return { fromBlock, toBlock };
}

export function determineMessageType(
  event: MessageSentEvent.Log,
  hubPoolClient: HubPoolClient
):
  | {
      type: "bridge";
      l1TokenSymbol: string;
      l1TokenAddress: string;
      amount: BigNumber;
    }
  | {
      type: "misc";
    } {
  const { _calldata, _value } = event.args;
  // First check a WETH deposit. A WETH deposit is a message with a positive
  // value and an empty calldata.
  if (_calldata === "0x" && _value > 0n) {
    return {
      type: "bridge",
      l1TokenSymbol: "WETH",
      l1TokenAddress: TOKEN_SYMBOLS_MAP.WETH.addresses[hubPoolClient.chainId],
      amount: BigNumber.from(_value),
    };
  }
  // Next check if the calldata is a valid Linea bridge. This should be in the form of a
  // TokenBridge.

  // Start with the TokenBridge calldata format.
  try {
    const contractInterface = new ethers.utils.Interface(
      CONTRACT_ADDRESSES[hubPoolClient.chainId].lineaL1TokenBridge.abi
    );
    const decoded = contractInterface.decodeFunctionData("completeBridging", _calldata);
    // If we've made it this far, then the calldata is a valid TokenBridge calldata.
    const token = getTokenInfo(decoded._nativeToken, hubPoolClient.chainId);
    return {
      type: "bridge",
      l1TokenSymbol: token.symbol,
      l1TokenAddress: decoded._nativeToken,
      amount: decoded._amount,
    };
  } catch (_e) {
    // We don't care about this because we have more to check
  }
  // If we've made it to this point, we've neither found a valid bridge calldata nor a WETH deposit.
  // I.e. This is a relayed message of some kind.
  return {
    type: "misc",
  };
}

export async function findMessageSentEvents(
  contract: Contract,
  senderAddresses: string[],
  searchConfig: EventSearchConfig
): Promise<ParsedMessageSentLog[]> {
  const rawLogs = await paginatedEventQuery(contract, contract.filters.MessageSent(senderAddresses), searchConfig);
  return rawLogs.map((log) => {
    const parsed = contract.interface.parseLog(log) as unknown as MessageSentEvent.Log;
    return {
      parsed,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber,
    };
  });
}

export async function findTokenBridgeEvents(
  bridgeContract: Contract,
  senderAddresses: string[],
  searchConfig: EventSearchConfig
): Promise<Log[]> {
  return paginatedEventQuery(bridgeContract, bridgeContract.filters.BridgingInitiatedV2(senderAddresses), searchConfig);
}

export async function findMessageFromTokenBridge(
  bridgeContract: Contract,
  messageServiceContract: L1MessageServiceContract | L2MessageServiceContract,
  senderAddresses: string[],
  searchConfig: EventSearchConfig
): Promise<ParsedMessageSentLog[]> {
  const bridgeEvents = await paginatedEventQuery(
    bridgeContract,
    bridgeContract.filters.BridgingInitiatedV2(senderAddresses),
    searchConfig
  );
  const iface = new ethers.utils.Interface(messageServiceContract.getContractAbi());
  const messageSentTopic = iface.getEventTopic("MessageSent");
  const associatedMessages = await Promise.all(
    bridgeEvents.map(async ({ args, transactionHash }) => {
      const { logs } = await bridgeContract.provider.getTransactionReceipt(transactionHash);
      return logs
        .filter((log) => log.topics[0] === messageSentTopic)
        .map((log) => {
          const parsed = messageServiceContract.contract.interface.parseLog(log) as unknown as MessageSentEvent.Log;
          const decodedArgs = parsed.args;
          // Start with the TokenBridge calldata format.
          try {
            const decoded = bridgeContract.interface.decodeFunctionData("completeBridging", decodedArgs._calldata);
            const isMatch =
              compareAddressesSimple(decoded._recipient, args.recipient) &&
              decoded._amount.toString() === args.amount.toString();

            if (!isMatch) {
              return null;
            }

            return {
              parsed,
              logIndex: log.logIndex,
              transactionHash: log.transactionHash,
              blockNumber: log.blockNumber,
            };
          } catch {
            return null;
          }
        })
        .filter((e): e is ParsedMessageSentLog => e !== null);
    })
  );
  return associatedMessages.flat();
}
