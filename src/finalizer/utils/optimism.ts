import * as optimismSDK from "@eth-optimism/sdk";
import { string } from "hardhat/internal/core/params/argumentTypes";
import { HubPoolClient } from "../../clients";
import { TokensBridged } from "../../interfaces";
import { getProvider, Wallet } from "../../utils";

export function getOptimismClient(mainnetSigner: Wallet) {
  return new optimismSDK.CrossChainMessenger({
    l1ChainId: 1,
    l1SignerOrProvider: mainnetSigner,
    l2SignerOrProvider: mainnetSigner.connect(getProvider(10)),
  });
}

export async function getCrossChainMessages(
  tokensBridged: TokensBridged[],
  hubPoolClient: HubPoolClient,
  crossChainMessenger: optimismSDK.CrossChainMessenger
) {
  return (
    await Promise.all(
      tokensBridged.map(async (event) => {
        const tokenInfo = hubPoolClient.getTokenInfo(
          1,
          hubPoolClient.getL1TokenCounterpartAtBlock(
            "10",
            event.l2TokenAddress.toLowerCase() === "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000" // Need to handle special case where
              ? // WETH is bridged as ETH and the contract address changes.
                "0x4200000000000000000000000000000000000006"
              : event.l2TokenAddress,
            hubPoolClient.latestBlockNumber
          )
        );
        return {
          messages: await crossChainMessenger.getMessagesByTransaction(event.transactionHash),
          tokenInfo,
        };
      })
    )
  ).reduce((flattenedMessages, messagesInTransaction) => {
    for (const message of messagesInTransaction.messages) {
      flattenedMessages.push({
        message,
        tokenInfo: messagesInTransaction.tokenInfo,
      });
    }
    return flattenedMessages;
  }, []);
}

export interface CrossChainMessageStatus {
  status: string;
  message: optimismSDK.MessageLike;
  token: string;
}
export async function getMessageStatuses(
  crossChainMessages: { message: optimismSDK.MessageLike; tokenInfo: any }[],
  crossChainMessenger: optimismSDK.CrossChainMessenger
) {
  const statuses = await Promise.all(
    crossChainMessages.map((message) => {
      return crossChainMessenger.getMessageStatus(message.message);
    })
  );
  return statuses.map((status, i) => {
    return {
      status: optimismSDK.MessageStatus[status],
      message: crossChainMessages[i].message,
      token: crossChainMessages[i].tokenInfo.symbol,
    };
  });
}

export function getOptimismFinalizableMessages(messageStatuses: CrossChainMessageStatus[]) {
  return messageStatuses.filter(
    (message) => message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_FOR_RELAY]
  );
}
