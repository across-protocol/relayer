import { LineaSDK, Message, OnChainMessageStatus } from "@consensys/linea-sdk";
import { L1MessageServiceContract, L2MessageServiceContract } from "@consensys/linea-sdk/dist/lib/contracts";
import { MessageSentEvent } from "@consensys/linea-sdk/dist/typechain/L2MessageService";
import { Wallet } from "ethers";
import { groupBy } from "lodash";

import { HubPoolClient, SpokePoolClient } from "../../clients";
import { CONTRACT_ADDRESSES } from "../../common";
import { Signer, winston, getNodeUrlList, convertFromWei } from "../../utils";
import { FinalizerPromise, Withdrawal } from "../types";
import { TokensBridged } from "../../interfaces";

type MessageWithStatus = Message & {
  logIndex: number;
  status: OnChainMessageStatus;
  txHash: string;
};

export async function lineaFinalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  latestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const [l1ChainId, l2ChainId] = [hubPoolClient.chainId, spokePoolClient.chainId, hubPoolClient.hubPool.address];
  const lineaSdk = new LineaSDK({
    l1RpcUrl: getNodeUrlList(l1ChainId)[0],
    l2RpcUrl: getNodeUrlList(l2ChainId)[0],
    l1SignerPrivateKey: (signer as Wallet).privateKey,
    l2SignerPrivateKey: (signer as Wallet).privateKey,
    network: l1ChainId === 1 ? "linea-mainnet" : "linea-goerli",
    mode: "read-write",
  });
  const l2MessageService = lineaSdk.getL2Contract(CONTRACT_ADDRESSES[l2ChainId]?.lineaMessageService.address);
  const l1MessageService = lineaSdk.getL1Contract(CONTRACT_ADDRESSES[l1ChainId]?.lineaMessageService.address);
  const getMessagesWithStatusByTxHash = makeGetMessagesWithStatusByTxHash(
    hubPoolClient.hubPool.address,
    l2MessageService,
    l1MessageService
  );

  // Get src events
  const l2SrcEvents = spokePoolClient
    .getTokensBridged()
    .filter(({ blockNumber }) => blockNumber > latestBlockToFinalize);

  // Get Linea's MessageSent events for each src event
  const uniqueTxHashes = Array.from(new Set(l2SrcEvents.map((event) => event.transactionHash)));
  const relevantMessages = (
    await Promise.all(uniqueTxHashes.map((txHash) => getMessagesWithStatusByTxHash(txHash)))
  ).flat();

  // Merge messages with TokensBridged events
  const mergedMessages = mergeMessagesWithTokensBridged(relevantMessages, l2SrcEvents);

  // Group messages by status
  const {
    claimed = [],
    claimable = [],
    unknown = [],
  } = groupBy(mergedMessages, ({ message }) => {
    return message.status === OnChainMessageStatus.CLAIMED
      ? "claimed"
      : message.status === OnChainMessageStatus.CLAIMABLE
      ? "claimable"
      : "unknown";
  });

  // Populate txns for claimable messages
  const populatedTxns = await Promise.all(
    claimable.map(({ message }) =>
      l1MessageService.contract.populateTransaction.claimMessage(
        message.messageSender,
        message.destination,
        message.fee,
        message.value,
        (signer as Wallet).address,
        message.calldata,
        message.messageNonce
      )
    )
  );
  const multicall2Call = populatedTxns.map((txn) => ({
    target: l1MessageService.contract.address,
    callData: txn.data,
  }));

  // Populate withdrawals for claimed messages
  const withdrawals = claimable.map(({ tokensBridged }) => {
    const { l2TokenAddress, amountToReturn } = tokensBridged;
    const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
      l2TokenAddress,
      l2ChainId,
      hubPoolClient.latestBlockSearched
    );
    const { decimals, symbol: l1TokenSymbol } = hubPoolClient.getTokenInfo(l1ChainId, l1TokenCounterpart);
    const amountFromWei = convertFromWei(amountToReturn.toString(), decimals);
    const withdrawal: Withdrawal = {
      l2ChainId,
      l1TokenSymbol,
      amount: amountFromWei,
      type: "withdrawal",
    };

    return withdrawal;
  });

  logger.debug({
    at: "Finalizer#LineaFinalizer",
    message: `Detected ${mergedMessages.length} relevant messages`,
    statuses: {
      claimed: claimed.length,
      claimable: claimable.length,
      notReceived: unknown.length,
    },
  });

  return { callData: multicall2Call, withdrawals };
}

function makeGetMessagesWithStatusByTxHash(
  hubPoolAddress: string,
  l2MessageService: L2MessageServiceContract,
  l1MessageService: L1MessageServiceContract
) {
  /**
   * Retrieves Linea's MessageSent events for a given transaction hash and enhances them with their status.
   * Note that there can be multiple MessageSent events per transaction hash.
   * @param l2MessageService L2MessageService contract instance.
   * @param l1MessageService L1MessageService contract instance.
   * @param txHash Transaction hash to retrieve MessageSent events for.
   * @returns Array of MessageSent events with their status.
   */
  return async function getMessagesWithStatusByTxHash(txHash: string): Promise<MessageWithStatus[]> {
    const txReceipt = await l2MessageService.provider.getTransactionReceipt(txHash);

    if (!txReceipt) {
      return [];
    }

    const messages = txReceipt.logs
      .filter((log) => log.address === l2MessageService.contract.address)
      .flatMap((log) => {
        const parsedLog = l2MessageService.contract.interface.parseLog(log);

        if (!parsedLog || parsedLog.name !== "MessageSent") {
          return [];
        }

        const { _from, _to, _fee, _value, _nonce, _calldata, _messageHash } = (parsedLog as unknown as MessageSentEvent)
          .args;

        if (_to !== hubPoolAddress) {
          return [];
        }

        return {
          messageSender: _from,
          destination: _to,
          fee: _fee,
          value: _value,
          messageNonce: _nonce,
          calldata: _calldata,
          messageHash: _messageHash,
          txHash,
          logIndex: log.logIndex,
        };
      });

    const messageStatus = await Promise.all(
      messages.map((message) => l1MessageService.getMessageStatus(message.messageHash))
    );
    return messages.map((message, index) => ({
      ...message,
      status: messageStatus[index],
    }));
  };
}

/**
 * Merges Linea's MessageSent events with their corresponding TokensBridged events of the SpokePool.
 * @param messages
 * @param allTokensBridgedEvents
 * @returns Matched MessageSent and TokensBridged events.
 */
function mergeMessagesWithTokensBridged(messages: MessageWithStatus[], allTokensBridgedEvents: TokensBridged[]) {
  const messagesByTxHash = groupBy(messages, ({ txHash }) => txHash);
  const tokensBridgedEventByTxHash = groupBy(allTokensBridgedEvents, ({ transactionHash }) => transactionHash);

  const merged: {
    message: MessageWithStatus;
    tokensBridged: TokensBridged;
  }[] = [];
  for (const txHash of Object.keys(messagesByTxHash)) {
    const messages = messagesByTxHash[txHash].sort((a, b) => a.logIndex - b.logIndex);
    const tokensBridgedEvents = tokensBridgedEventByTxHash[txHash].sort((a, b) => a.logIndex - b.logIndex);

    if (messages.length !== tokensBridgedEvents.length) {
      throw new Error(
        `Mismatched number of MessageSent and TokensBridged events for transaction hash ${txHash}. ` +
          `Found ${messages.length} MessageSent events and ${tokensBridgedEvents.length} TokensBridged events.`
      );
    }

    for (const [i, message] of messages.entries()) {
      merged.push({
        message,
        tokensBridged: tokensBridgedEvents[i],
      });
    }
  }

  return merged;
}
