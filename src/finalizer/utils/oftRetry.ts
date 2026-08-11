import { SpokePoolClient } from "../../clients";
import {
  EventSearchConfig,
  Multicall2Call,
  assert,
  groupObjectCountsByProp,
  winston,
  isDefined,
  isEVMSpokePoolClient,
  isPromiseFulfilled,
  chainIsEvm,
  chunk,
  getSrcOftMessages,
  getLzTransactionDetails,
  getChainIdFromEndpointId,
  getNetworkName,
  getProvider,
  stringifyThrownValue,
  LzTransactionDetails,
} from "../../utils";
import { FinalizerPromise, CrossChainMessage } from "../types";

/**
 * Finalizes failed lzCompose messages by replaying the reverted destination transaction's calldata.
 * @param logger Logger instance.
 * @param spokePoolClient Origin SpokePool client instance.
 * @returns FinalizerPromise instance.
 */
export async function oftRetryFinalizer(
  logger: winston.Logger,
  spokePoolClient: SpokePoolClient
): Promise<FinalizerPromise> {
  assert(isEVMSpokePoolClient(spokePoolClient), "Cannot retry LZ messages on non-EVM networks.");
  const originChainId = spokePoolClient.chainId;
  const at = `Finalizer#OftRetryFinalizer:${originChainId}`;
  const srcProvider = spokePoolClient.spokePool.provider;
  const searchConfig: EventSearchConfig = {
    from: spokePoolClient.eventSearchConfig.from,
    to: spokePoolClient.latestHeightSearched,
    maxLookBack: spokePoolClient.eventSearchConfig.maxLookBack,
  };
  const depositInitiatedMessages = await getSrcOftMessages(originChainId, searchConfig, srcProvider);

  // @dev The LZ scan API 4xxs for sends it hasn't indexed yet, which is the common case on a chain with recent
  // activity. Settle each lookup independently so one fresh send can't discard every older failed message with it.
  const outstandingMessages: LzTransactionDetails[] = [];
  const unindexedSends: string[] = [];
  // To avoid rate-limiting, chunk API queries.
  const chunkSize = Number(process.env["LZ_API_CHUNK_SIZE"] ?? 8);
  for (const depositInitiatedMessageChunk of chunk(depositInitiatedMessages, chunkSize)) {
    const results = await Promise.allSettled(
      depositInitiatedMessageChunk.map(({ txnRef }) => getLzTransactionDetails(txnRef))
    );
    results.forEach((result, idx) => {
      if (isPromiseFulfilled(result)) {
        outstandingMessages.push(...result.value.flat());
      } else {
        unindexedSends.push(depositInitiatedMessageChunk[idx].txnRef);
      }
    });
  }

  const statusesGrouped = groupObjectCountsByProp(
    outstandingMessages,
    // @dev destination is undefined until the message reaches the far side.
    ({ destination }: LzTransactionDetails) => destination?.status ?? "PENDING"
  );

  // Lz messages are executed automatically and must be retried only if their execution reverts on chain. Requiring
  // a failedTx entry is what separates a reverted execution from one that is merely still in flight, and it is also
  // the transaction that gets replayed below.
  const retryableMessages = outstandingMessages.filter(
    ({ destination }) => destination?.status !== "SUCCEEDED" && (destination?.failedTx?.length ?? 0) > 0
  );

  logger.debug({
    at,
    message: `Detected ${retryableMessages.length} LZ retryable messages for origin ${originChainId}`,
    statusesGrouped,
    unindexedSends: unindexedSends.length,
  });

  // @dev Retry the *destination* execution. The reverted destination transaction is refetched from the destination
  // chain and its calldata replayed there; the origin transaction is a different contract on a different chain, so
  // replaying that against the destination would just target an unrelated (usually codeless) address.
  const retries = await Promise.allSettled(
    retryableMessages.map(async (message) => {
      const destinationChainId = getChainIdFromEndpointId(message.pathway.dstEid);
      assert(chainIsEvm(destinationChainId), `Cannot replay LZ messages on non-EVM chain ${destinationChainId}`);

      // @dev Last entry: LZ appends an entry per execution attempt, so the most recent one is the live failure.
      const failedTx = message.destination?.failedTx?.at(-1);
      assert(isDefined(failedTx), `oftRetry: message ${message.source.tx} has no failed destination transaction`);

      const { txHash } = failedTx;
      const dstProvider = await getProvider(destinationChainId);
      const txn = await dstProvider.getTransaction(txHash);
      assert(isDefined(txn), `oftRetry: destination transaction ${txHash} not found on chain ${destinationChainId}`);
      assert(isDefined(txn.to), `oftRetry: destination transaction ${txHash} has no recipient`);

      return {
        txn: { target: txn.to, callData: txn.data },
        crossChainMessage: {
          originationChainId: originChainId,
          destinationChainId,
          type: "misc",
          miscReason: "oftRetry",
        } as CrossChainMessage,
      };
    })
  );

  // @dev finalize() pairs callData[i] with crossChainMessages[i], so these must be appended in lockstep.
  const callData: Multicall2Call[] = [];
  const crossChainMessages: CrossChainMessage[] = [];
  const skipped: { srcTxn: string; dstEid: number; reason: string }[] = [];
  retries.forEach((result, idx) => {
    if (isPromiseFulfilled(result)) {
      callData.push(result.value.txn);
      crossChainMessages.push(result.value.crossChainMessage);
      return;
    }
    const { source, pathway } = retryableMessages[idx];
    skipped.push({ srcTxn: source.tx, dstEid: pathway.dstEid, reason: stringifyThrownValue(result.reason) });
  });

  if (skipped.length > 0) {
    logger.warn({
      at,
      message: `Skipped ${skipped.length} unretryable LZ message(s) from ${getNetworkName(originChainId)}.`,
      skipped,
    });
  }

  return {
    crossChainMessages,
    callData,
  };
}
