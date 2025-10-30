import { SpokePoolClient } from "../../clients";
import {
  EventSearchConfig,
  assert,
  groupObjectCountsByProp,
  winston,
  isEVMSpokePoolClient,
  chunk,
  getSrcOftMessages,
  getLzTransactionDetails,
  mapAsync,
  getChainIdFromEndpointId,
} from "../../utils";
import { FinalizerPromise, CrossChainMessage } from "../types";

/**
 * Finalizes failed lzCompose messages on destination by checking for failed transactions and resubmitting its calldata..
 * @param logger Logger instance.
 * @param spokePoolClient Origin SpokePool client instance.
 * @returns FinalizerPromise instance.
 */
export async function oftRetryFinalizer(
  logger: winston.Logger,
  spokePoolClient: SpokePoolClient
): Promise<FinalizerPromise> {
  assert(isEVMSpokePoolClient(spokePoolClient), "Cannot retry LZ messages on non-EVM networks.");
  const srcProvider = spokePoolClient.spokePool.provider;
  const searchConfig: EventSearchConfig = {
    from: spokePoolClient.eventSearchConfig.from,
    to: spokePoolClient.latestHeightSearched,
    maxLookBack: spokePoolClient.eventSearchConfig.maxLookBack,
  };
  const depositInitiatedMessages = await getSrcOftMessages(spokePoolClient.chainId, searchConfig, srcProvider);
  const outstandingMessages = [];
  // To avoid rate-limiting, chunk API queries.
  const chunkSize = Number(process.env["LZ_API_CHUNK_SIZE"] ?? 8);
  for (const depositInitiatedMessageChunk of chunk(depositInitiatedMessages, chunkSize)) {
    outstandingMessages.push(
      ...(await mapAsync(depositInitiatedMessageChunk, async ({ txnRef }) => {
        return await getLzTransactionDetails(txnRef);
      }))
    );
  }
  // Lz messages are executed automatically and must be retried only if their execution reverts on chain.
  const unprocessedMessages = outstandingMessages.filter((message) => message.status !== "SUCCEEDED");
  const statusesGrouped = groupObjectCountsByProp(
    outstandingMessages.map(({ destination }) => destination),
    (message: { status: string }) => message.status
  );
  logger.debug({
    at: `Finalizer#OftRetryFinalizer:${spokePoolClient.chainId}`,
    message: `Detected ${unprocessedMessages.length} LZ retryable messages for origin ${spokePoolClient.chainId}`,
    statusesGrouped,
  });

  const destinationTransactions = await mapAsync(unprocessedMessages, async ({ txnRef }) => {
    return await srcProvider.getTransaction(txnRef);
  });

  const callData = destinationTransactions.map((txData) => {
    return {
      target: txData.to,
      callData: txData.data,
    };
  });

  const crossChainMessages = unprocessedMessages.map((unprocessedMessage) => {
    return {
      originationChainId: spokePoolClient.chainId,
      destinationChainId: getChainIdFromEndpointId(unprocessedMessage.pathway.dstEid),
      type: "misc",
      miscReason: "oftRetry",
    } as CrossChainMessage;
  });

  return {
    crossChainMessages,
    callData,
  };
}
