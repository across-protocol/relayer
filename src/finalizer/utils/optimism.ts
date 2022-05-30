import * as optimismSDK from "@eth-optimism/sdk";
import { HubPoolClient, MultiCallerClient } from "../../clients";
import { TokensBridged } from "../../interfaces";
import { ethers, getProvider, groupObjectCountsByTwoProps, Wallet, winston } from "../../utils";

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
          amount: ethers.utils.formatUnits(event.amountToReturn.toString(), tokenInfo.decimals),
        };
      })
    )
  ).reduce((flattenedMessages, messagesInTransaction) => {
    for (const message of messagesInTransaction.messages) {
      flattenedMessages.push({
        message,
        tokenInfo: messagesInTransaction.tokenInfo,
        amount: messagesInTransaction.amount,
      });
    }
    return flattenedMessages;
  }, []);
}

export interface CrossChainMessageStatus {
  status: string;
  message: optimismSDK.MessageLike;
  token: string;
  amount: string;
}
export async function getMessageStatuses(
  crossChainMessages: { message: optimismSDK.MessageLike; tokenInfo: any; amount: string }[],
  crossChainMessenger: optimismSDK.CrossChainMessenger
): Promise<CrossChainMessageStatus[]> {
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
      amount: crossChainMessages[i].amount,
    };
  });
}

export async function getOptimismFinalizableMessages(
  logger: winston.Logger,
  tokensBridged: TokensBridged[],
  hubPoolClient: HubPoolClient,
  crossChainMessenger: optimismSDK.CrossChainMessenger
) {
  const crossChainMessages = await getCrossChainMessages(tokensBridged, hubPoolClient, crossChainMessenger);
  const messageStatuses = await getMessageStatuses(crossChainMessages, crossChainMessenger);
  logger.debug({
    at: "OptimismFinalizer",
    message: "Optimism message statuses",
    statusesGrouped: groupObjectCountsByTwoProps(messageStatuses, "status", (message) => message.token),
  });
  return messageStatuses.filter(
    (message) => message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_FOR_RELAY]
  );
}

export function finalizeOptimismMessage(
  multiCallerClient: MultiCallerClient,
  crossChainMessenger: optimismSDK.CrossChainMessenger,
  message: CrossChainMessageStatus,
  logger: winston.Logger
) {
  console.log(message);
  try {
    multiCallerClient.enqueueTransaction({
      contract: crossChainMessenger.contracts.l1.L1CrossDomainMessenger,
      chainId: 1,
      method: "relayMessage",
      args: crossChainMessenger.populateTransaction.finalizeMessage(message.message),
      message: `Finalized optimism withdrawal for ${message.amount} of ${message.token}`,
      mrkdwn: `Finalized optimism withdrawal for ${message.amount} of ${message.token}`,
    });
  } catch (error) {
    logger.error({
      at: "OptimismFinalizer",
      message: "Error creating relayMessageTx",
      error,
      notificationPath: "across-error",
    });
  }
}
