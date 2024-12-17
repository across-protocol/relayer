import { OnChainMessageStatus } from "@consensys/linea-sdk";
import { Wallet } from "ethers";
import { groupBy } from "lodash";

import { HubPoolClient, SpokePoolClient } from "../../../clients";
import {
  Signer,
  winston,
  convertFromWei,
  getL1TokenInfo,
  getProvider,
  EventSearchConfig,
  ethers,
  Contract,
  paginatedEventQuery,
  mapAsync,
  BigNumber,
} from "../../../utils";
import { FinalizerPromise, CrossChainMessage } from "../../types";
import { TokensBridged } from "../../../interfaces";
import {
  initLineaSdk,
  makeGetMessagesWithStatusByTxHash,
  MessageWithStatus,
  getBlockRangeByHoursOffsets,
  getMessageSentEventForMessageHash,
  getL1MessageServiceContractFromL1ClaimingService,
  getL2MessageServiceContractFromL1ClaimingService,
  getL2MessagingBlockAnchoredFromMessageSentEvent,
} from "./common";
import { CHAIN_MAX_BLOCK_LOOKBACK } from "../../../common";
import { utils as sdkUtils } from "@across-protocol/sdk";
import {
  L1ClaimingService,
  SparseMerkleTreeFactory,
  DEFAULT_L2_MESSAGE_TREE_DEPTH,
  L2_MERKLE_TREE_ADDED_EVENT_SIGNATURE,
  L2_MESSAGING_BLOCK_ANCHORED_EVENT_SIGNATURE,
} from "./imports";

// Normally we avoid importing directly from a node_modules' /dist package but we need access to some
// of the internal classes and functions in order to replicate SDK logic so that we can by pass hardcoded
// ethers.Provider instances and use our own custom provider instead.

// Ideally we could call this function through the LineaSDK but its hardcoded to use an ethers.Provider instance
// that doesn't have our custom caching logic or ability for us to customize the block lookback. This means we can't
// use the SDK on providers that have maxBlockLookbacks constraint. So, we re-implement this function here.
async function getMessageProof(
  messageHash: string,
  l1ClaimingService: L1ClaimingService,
  l2Provider: ethers.providers.Provider,
  l1Provider: ethers.providers.Provider,
  l2SearchConfig: EventSearchConfig,
  l1SearchConfig: EventSearchConfig
) {
  const l2Contract = getL2MessageServiceContractFromL1ClaimingService(l1ClaimingService, l2Provider);
  const messageEvent = await getMessageSentEventForMessageHash(messageHash, l2Contract, l2SearchConfig);
  const l1Contract = getL1MessageServiceContractFromL1ClaimingService(l1ClaimingService, l1Provider);
  const [l2MessagingBlockAnchoredEvent] = await getL2MessagingBlockAnchoredFromMessageSentEvent(
    messageEvent,
    l1Contract,
    l1SearchConfig
  );
  if (!l2MessagingBlockAnchoredEvent) {
    throw new Error(`L2 block number ${messageEvent.blockNumber} has not been finalized on L1.`);
  }
  // This SDK function is complex but only makes one l1Provider.getTransactionReceipt call so we can make this
  // through the SDK rather than re-implement it.
  const finalizationInfo = await getFinalizationMessagingInfo(
    l1ClaimingService,
    l2MessagingBlockAnchoredEvent.transactionHash
  );
  const l2MessageHashesInBlockRange = await getL2MessageHashesInBlockRange(l2Contract, {
    fromBlock: finalizationInfo.l2MessagingBlocksRange.startingBlock,
    toBlock: finalizationInfo.l2MessagingBlocksRange.endBlock,
    maxBlockLookBack: l2SearchConfig.maxBlockLookBack,
  });
  const l2Messages = l1ClaimingService.getMessageSiblings(
    messageHash,
    l2MessageHashesInBlockRange,
    finalizationInfo.treeDepth
  );
  // This part is really janky because the SDK doesn't expose any helper functions that use the
  // merkle tree or the merkle tree class itself.
  const merkleTreeFactory = new SparseMerkleTreeFactory(DEFAULT_L2_MESSAGE_TREE_DEPTH);
  const tree = merkleTreeFactory.createAndAddLeaves(l2Messages);
  if (!finalizationInfo.l2MerkleRoots.includes(tree.getRoot())) {
    throw new Error("Merkle tree build failed.");
  }
  return tree.getProof(l2Messages.indexOf(messageHash));
}

async function getFinalizationMessagingInfo(
  l1ClaimingService: L1ClaimingService,
  transactionHash: string
): Promise<{
  l2MessagingBlocksRange: { startingBlock: number; endBlock: number };
  l2MerkleRoots: string[];
  treeDepth: number;
}> {
  const l1Contract = l1ClaimingService.l1Contract;
  const receipt = await l1Contract.provider.getTransactionReceipt(transactionHash);
  if (!receipt || receipt.logs.length === 0) {
    throw new Error(`Transaction does not exist or no logs found in this transaction: ${transactionHash}.`);
  }
  let treeDepth = 0;
  const l2MerkleRoots = [];
  const blocksNumber = [];
  const filteredLogs = receipt.logs.filter((log) => log.address === l1Contract.contractAddress);
  for (let i = 0; i < filteredLogs.length; i++) {
    const log = filteredLogs[i];
    // This part changes from the SDK: remove any logs with topic hashes that don't exist in the current SDK's ABI,
    // otherwise parseLog will fail.
    const topic = log.topics[0];
    if (topic !== L2_MERKLE_TREE_ADDED_EVENT_SIGNATURE && topic !== L2_MESSAGING_BLOCK_ANCHORED_EVENT_SIGNATURE) {
      continue;
    }

    const parsedLog = l1Contract.contract.interface.parseLog(log);
    if (topic === L2_MERKLE_TREE_ADDED_EVENT_SIGNATURE) {
      treeDepth = BigNumber.from(parsedLog.args.treeDepth).toNumber();
      l2MerkleRoots.push(parsedLog.args.l2MerkleRoot);
    } else if (topic === L2_MESSAGING_BLOCK_ANCHORED_EVENT_SIGNATURE) {
      blocksNumber.push(parsedLog.args.l2Block);
    }
  }
  if (l2MerkleRoots.length === 0) {
    throw new Error("No L2MerkleRootAdded events found in this transaction.");
  }
  if (blocksNumber.length === 0) {
    throw new Error("No L2MessagingBlocksAnchored events found in this transaction.");
  }
  return {
    l2MessagingBlocksRange: {
      startingBlock: Math.min(...blocksNumber),
      endBlock: Math.max(...blocksNumber),
    },
    l2MerkleRoots,
    treeDepth,
  };
}

async function getL2MessageHashesInBlockRange(
  l2MessageServiceContract: Contract,
  l2SearchConfig: EventSearchConfig
): Promise<string[]> {
  const events = await paginatedEventQuery(
    l2MessageServiceContract,
    l2MessageServiceContract.filters.MessageSent(),
    l2SearchConfig
  );
  if (events.length === 0) {
    throw new Error("No MessageSent events found in this block range on L2.");
  }
  return events.map((event) => event.args._messageHash);
}

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
  // We need a longer lookback period for L1 to ensure we find all L1 events containing finalized
  // L2 block heights.
  const { fromBlock: l1FromBlock, toBlock: l1ToBlock } = await getBlockRangeByHoursOffsets(l1ChainId, 24 * 14, 0);
  // Optimize block range for querying relevant source events on L2.
  // Linea L2->L1 messages are claimable after 6 - 32 hours
  const { fromBlock: l2FromBlock, toBlock: l2ToBlock } = await getBlockRangeByHoursOffsets(l2ChainId, 24 * 8, 6);
  const l1SearchConfig = {
    fromBlock: l1FromBlock,
    toBlock: l1ToBlock,
    maxBlockLookBack: CHAIN_MAX_BLOCK_LOOKBACK[l1ChainId] || 10_000,
  };
  const l2SearchConfig = {
    fromBlock: l2FromBlock,
    toBlock: l2ToBlock,
    maxBlockLookBack: CHAIN_MAX_BLOCK_LOOKBACK[l2ChainId] || 5_000,
  };
  const l2Provider = await getProvider(l2ChainId);
  const l1Provider = await getProvider(l1ChainId);
  const getMessagesWithStatusByTxHash = makeGetMessagesWithStatusByTxHash(
    l2Provider,
    l1Provider,
    l2Contract,
    l1ClaimingService,
    l1SearchConfig,
    l2SearchConfig
  );

  logger.debug({
    at: "Finalizer#LineaL2ToL1Finalizer",
    message: "Linea TokensBridged event filter",
    l1SearchConfig,
    l2SearchConfig,
  });
  // Get src events
  const l2SrcEvents = spokePoolClient
    .getTokensBridged()
    .filter(({ blockNumber }) => blockNumber >= l2FromBlock && blockNumber <= l2ToBlock);

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
      // As of this upgrade, proofs are always needed to submit claims:
      // https://lineascan.build/tx/0x01ef3ec3c09c4fe828ec2c0e67a3f3adf768d34026adf8948e05f7871abaa327
      const proof = await getMessageProof(
        message.messageHash,
        l1ClaimingService,
        l2Provider,
        l1Provider,
        l2SearchConfig,
        l1SearchConfig
      );
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

  const averageBlockTimeSeconds = await sdkUtils.averageBlockTime(spokePoolClient.spokePool.provider);
  logger.debug({
    at: "Finalizer#LineaL2ToL1Finalizer",
    message: "Linea L2->L1 message statuses",
    averageBlockTimeSeconds,
    latestSpokePoolBlock: spokePoolClient.latestBlockSearched,
    statuses: {
      claimed: claimed.length,
      claimable: claimable.length,
      notReceived: unknown.length,
    },
    notReceivedTxns: await mapAsync(unknown, async ({ message, tokensBridged }) => {
      const withdrawalBlock = tokensBridged.blockNumber;
      return {
        txnHash: message.txHash,
        withdrawalBlock,
        maturedHours:
          (averageBlockTimeSeconds.average * (spokePoolClient.latestBlockSearched - withdrawalBlock)) / 60 / 60,
      };
    }),
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
