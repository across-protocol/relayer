import { LineaSDK, Message, OnChainMessageStatus } from "@consensys/linea-sdk";
import { L1MessageServiceContract, L2MessageServiceContract } from "@consensys/linea-sdk/dist/lib/contracts";
import { L1ClaimingService } from "@consensys/linea-sdk/dist/lib/sdk/claiming/L1ClaimingService";
import { MessageSentEvent } from "@consensys/linea-sdk/dist/typechain/L2MessageService";
import { Linea_Adapter__factory } from "@across-protocol/contracts-v2";

import { TransactionReceipt, getNodeUrlList } from "../../../utils";

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
  return async function getMessagesWithStatusByTxHash(
    txHashOrReceipt: string | TransactionReceipt
  ): Promise<MessageWithStatus[]> {
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
