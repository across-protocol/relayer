import { LineaSDK, Message, OnChainMessageStatus } from "@consensys/linea-sdk";
import { L1MessageServiceContract, L2MessageServiceContract } from "@consensys/linea-sdk/dist/lib/contracts";
import { L1ClaimingService } from "@consensys/linea-sdk/dist/lib/sdk/claiming/L1ClaimingService";
import { MessageSentEvent } from "@consensys/linea-sdk/dist/typechain/L2MessageService";
import { Linea_Adapter__factory } from "@across-protocol/contracts-v2";
import {
  BigNumber,
  Contract,
  EventSearchConfig,
  TOKEN_SYMBOLS_MAP,
  TransactionReceipt,
  ethers,
  getBlockForTimestamp,
  getCurrentTime,
  getNodeUrlList,
  getRedisCache,
  paginatedEventQuery,
} from "../../../utils";
import { HubPoolClient } from "../../../clients";
import { CHAIN_MAX_BLOCK_LOOKBACK } from "../../../common";

export type MessageWithStatus = Message & {
  logIndex: number;
  status: OnChainMessageStatus;
  txHash: string;
};

export const lineaAdapterIface = Linea_Adapter__factory.createInterface();

export function initLineaSdk(l1ChainId: number, l2ChainId: number): LineaSDK {
  return new LineaSDK({
    l1RpcUrl: getNodeUrlList(l1ChainId)[0],
    l2RpcUrl: getNodeUrlList(l2ChainId)[0],
    network: l1ChainId === 1 ? "linea-mainnet" : "linea-goerli",
    mode: "read-only",
  });
}

export function makeGetMessagesWithStatusByTxHash(
  srcMessageService: L1MessageServiceContract | L2MessageServiceContract,
  dstClaimingService: L1ClaimingService | L2MessageServiceContract
) {
  /**
   * Retrieves Linea's MessageSent events for a given transaction hash and enhances them with their status.
   * Note that there can be multiple MessageSent events per transaction hash.
   * @param txHash Transaction hash to retrieve MessageSent events for.
   * @returns Array of MessageSent events with their status.
   */
  return async (txHashOrReceipt: string | TransactionReceipt): Promise<MessageWithStatus[]> => {
    const txReceipt =
      typeof txHashOrReceipt === "string"
        ? await srcMessageService.provider.getTransactionReceipt(txHashOrReceipt)
        : txHashOrReceipt;

    if (!txReceipt) {
      return [];
    }

    const messages = txReceipt.logs
      .filter((log) => log.address === srcMessageService.contract.address)
      .flatMap((log) => {
        const parsedLog = srcMessageService.contract.interface.parseLog(log);

        if (!parsedLog || parsedLog.name !== "MessageSent") {
          return [];
        }

        const { _from, _to, _fee, _value, _nonce, _calldata, _messageHash } =
          parsedLog.args as MessageSentEvent["args"];

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
      messages.map((message) => dstClaimingService.getMessageStatus(message.messageHash))
    );
    return messages.map((message, index) => ({
      ...message,
      status: messageStatus[index],
    }));
  };
}

export async function getBlockRangeByHoursOffsets(
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
    getBlockForTimestamp(chainId, fromBlockTimestamp, undefined, redisCache),
    getBlockForTimestamp(chainId, toBlockTimestamp, undefined, redisCache),
  ]);

  return { fromBlock, toBlock };
}

export function determineMessageType(
  { args: { _calldata, _value } }: MessageSentEvent,
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
  // First check a WETH deposit. A WETH deposit is a message with a positive
  // value and an empty calldata.
  if (_calldata === "0x") {
    return {
      type: "bridge",
      l1TokenSymbol: "WETH",
      l1TokenAddress: TOKEN_SYMBOLS_MAP.WETH.addresses[hubPoolClient.chainId],
      amount: _value,
    };
  }
  // Next check if the calldata is a valid Linea bridge. This can either be in the form of a
  // UsdcTokenBridge or a TokenBridge. Both have a different calldata format.

  // Start with the TokenBridge calldata format.
  try {
    const functionSignature = "completeBridging(address,uint256,address,uint256,bytes)";
    const functionFragment = ethers.utils.FunctionFragment.from(functionSignature);
    const contractInterface = new ethers.utils.Interface([functionFragment]);
    const decoded = contractInterface.decodeFunctionData(functionFragment.name, _calldata);
    // If we've made it this far, then the calldata is a valid TokenBridge calldata.
    const token = hubPoolClient.getTokenInfo(hubPoolClient.chainId, decoded._nativeToken);
    return {
      type: "bridge",
      l1TokenSymbol: token.symbol,
      l1TokenAddress: decoded._nativeToken,
      amount: decoded._amount,
    };
  } catch (_e) {
    // We don't care about this because we have more to check
  }
  // Next check the UsdcTokenBridge calldata format.
  try {
    const functionSignature = "receiveFromOtherLayer(address,uint256)";
    const functionFragment = ethers.utils.FunctionFragment.from(functionSignature);
    const contractInterface = new ethers.utils.Interface([functionFragment]);
    const decoded = contractInterface.decodeFunctionData(functionFragment.name, _calldata);
    // If we've made it this far, then the calldata is a valid UsdcTokenBridge calldata.
    return {
      type: "bridge",
      l1TokenSymbol: "USDC",
      l1TokenAddress: TOKEN_SYMBOLS_MAP.USDC.addresses[hubPoolClient.chainId],
      amount: decoded.amount,
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
  contract: L1MessageServiceContract | L2MessageServiceContract,
  l1ToL2AddressesToFinalize: string[],
  searchConfig: EventSearchConfig
): Promise<MessageSentEvent[]> {
  return paginatedEventQuery(
    contract.contract,
    (contract.contract as Contract).filters.MessageSent(l1ToL2AddressesToFinalize),
    searchConfig
  ) as Promise<MessageSentEvent[]>;
}
