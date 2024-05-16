import { OnChainMessageStatus } from "@consensys/linea-sdk";
import { Wallet } from "ethers";
import { groupBy } from "lodash";

import { HubPoolClient, SpokePoolClient } from "../../../clients";
import { Signer, winston, convertFromWei, getL1TokenInfo } from "../../../utils";
import { FinalizerPromise, CrossChainMessage } from "../../types";
import { TokensBridged } from "../../../interfaces";
import {
  initLineaSdk,
  makeGetMessagesWithStatusByTxHash,
  MessageWithStatus,
  getBlockRangeByHoursOffsets,
} from "./common";

export async function lineaL2ToL1Finalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient
): Promise<FinalizerPromise> {
  const [l1ChainId, l2ChainId] = [hubPoolClient.chainId, spokePoolClient.chainId];
  const lineaSdk = initLineaSdk(l1ChainId, l2ChainId);
  const l2Contract = lineaSdk.getL2Contract();
  const l1Contract = lineaSdk.getL1Contract();
  const l1ClaimingService = lineaSdk.getL1ClaimingService(l1Contract.contractAddress);
  const getMessagesWithStatusByTxHash = makeGetMessagesWithStatusByTxHash(l2Contract, l1ClaimingService);

  // Optimize block range for querying relevant source events on L2.
  // We want to conservatively query for events that are between 8 and 72 hours old
  // because Linea L2->L1 messages are claimable after 6 - 32 hours
  const { fromBlock, toBlock } = await getBlockRangeByHoursOffsets(l2ChainId, 72, 8);
  logger.debug({
    at: "Finalizer#LineaL2ToL1Finalizer",
    message: "Linea TokensBridged event filter",
    fromBlock,
    toBlock,
  });
  // Get src events
  const l2SrcEvents = spokePoolClient
    .getTokensBridged()
    .filter(({ blockNumber }) => blockNumber >= fromBlock && blockNumber <= toBlock);

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
    claimable.map(async ({ message }) => {
      const isProofNeeded = await l1ClaimingService.isClaimingNeedingProof(message.messageHash);

      if (isProofNeeded) {
        const proof = await l1ClaimingService.getMessageProof(message.messageHash);
        return l1ClaimingService.l1Contract.contract.populateTransaction.claimMessageWithProof({
          from: message.messageSender,
          to: message.destination,
          fee: message.fee,
          value: message.value,
          feeRecipient: (signer as Wallet).address,
          data: message.calldata,
          messageNumber: message.messageNonce,
          proof: proof.proof,
          leafIndex: proof.leafIndex,
          merkleRoot: proof.root,
        });
      }

      return l1ClaimingService.l1Contract.contract.populateTransaction.claimMessage(
        message.messageSender,
        message.destination,
        message.fee,
        message.value,
        (signer as Wallet).address,
        message.calldata,
        message.messageNonce
      );
    })
  );
  const multicall3Call = populatedTxns.map((txn) => ({
    target: l1Contract.contractAddress,
    callData: txn.data,
  }));

  // Populate cross chain transfers for claimed messages
  const transfers = claimable.map(({ tokensBridged }) => {
    const { l2TokenAddress, amountToReturn } = tokensBridged;
    const { decimals, symbol: l1TokenSymbol } = getL1TokenInfo(l2TokenAddress, l2ChainId);
    const amountFromWei = convertFromWei(amountToReturn.toString(), decimals);
    const transfer: CrossChainMessage = {
      originationChainId: l2ChainId,
      destinationChainId: l1ChainId,
      l1TokenSymbol,
      amount: amountFromWei,
      type: "withdrawal",
    };

    return transfer;
  });

  logger.debug({
    at: "Finalizer#LineaL2ToL1Finalizer",
    message: "Linea L2->L1 message statuses",
    statuses: {
      claimed: claimed.length,
      claimable: claimable.length,
      notReceived: unknown.length,
    },
  });

  return { callData: multicall3Call, crossChainMessages: transfers };
}

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
