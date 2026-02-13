import { ethers } from "ethers";
import { PRODUCTION_OFT_EIDs } from "@across-protocol/constants";
import LZEndpoint from "../../common/abi/LayerZeroV2Endpoint.json";
import LZMessenger from "../../common/abi/LayerZeroV2Messenger.json";
import { SpokePoolClient } from "../../clients";
import * as OFT from "../../utils/OFTUtils";
import {
  CHAIN_IDs,
  EventSearchConfig,
  EvmAddress,
  isDefined,
  assert,
  getProvider,
  groupObjectCountsByProp,
  winston,
  getSrcOftPeriphery,
  isEVMSpokePoolClient,
  chunk,
  mapAsync,
  paginatedEventQuery,
  Provider,
  spreadEventWithBlockNumber,
  toAddressType,
  TOKEN_SYMBOLS_MAP,
} from "../../utils";
import { AddressesToFinalize, CrossChainMessage, FinalizerPromise } from "../types";

const OFT_RETRY_TOKENS = ["USDT"];

/**
 * Finalizes failed lzCompose messages on destination by checking for failed transactions and resubmitting its calldata..
 * @param logger Logger instance.
 * @param spokePoolClient Origin SpokePool client instance.
 * @returns FinalizerPromise instance.
 */
export async function oftRetryFinalizer(
  logger: winston.Logger,
  spokePoolClient: SpokePoolClient,
  addressesToFinalize: AddressesToFinalize
): Promise<FinalizerPromise> {
  assert(isEVMSpokePoolClient(spokePoolClient), "Cannot retry LZ messages on non-EVM networks.");
  const srcProvider = spokePoolClient.spokePool.provider;

  const searchConfig: EventSearchConfig = {
    from: spokePoolClient.eventSearchConfig.from,
    to: spokePoolClient.latestHeightSearched,
    maxLookBack: spokePoolClient.eventSearchConfig.maxLookBack,
  };

  const senderAddresses = Array.from(addressesToFinalize.keys())
    .filter((address) => address.isEVM())
    .map((address) => address.toNative());
  const getDeposits = async () => {
    const deposits = await Promise.all(
      OFT_RETRY_TOKENS.map((symbol) => TOKEN_SYMBOLS_MAP[symbol]?.addresses[spokePoolClient.chainId])
        .filter(isDefined)
        .map((address) => OFT.getOFTSent(spokePoolClient.chainId, EvmAddress.from(address), searchConfig, srcProvider))
    );
    return deposits.flat().filter(({ fromAddress }) => senderAddresses.includes(fromAddress));
  };

  const deposits = (
    await Promise.all([getSrcOftMessages(spokePoolClient.chainId, searchConfig, srcProvider), getDeposits()])
  ).flat();

  // To avoid rate-limiting, chunk API queries.
  const chunkSize = Number(process.env["LZ_API_CHUNK_SIZE"] ?? 8);

  const _outstandingMessages = [];
  for (const depositChunk of chunk(deposits, chunkSize)) {
    _outstandingMessages.push(
      ...(await mapAsync(depositChunk, async ({ txnRef }) => await OFT.getLzTransactionDetails(txnRef)))
    );
  }
  const outstandingMessages = _outstandingMessages.map(({ data }) => data.flat()).flat();

  // Lz messages are executed automatically and must be retried only if their execution reverts on chain.
  const knownEids = Object.values(PRODUCTION_OFT_EIDs);
  const uniqueEids: number[] = [];
  const checkStatus = (status?: string) => !["WAITING", "SUCCEEDED"].includes(status);
  const unprocessedMessages = outstandingMessages.filter(({ pathway, destination }) => {
    if (!knownEids.includes(pathway.dstEid)) {
      return false;
    }
    if (!uniqueEids.includes(pathway.dstEid)) {
      uniqueEids.push(pathway.dstEid);
    }

    return checkStatus(destination?.status);
  });

  const statusesGrouped = groupObjectCountsByProp(
    unprocessedMessages.map(({ destination }) => destination),
    (message: { status: string }) => message.status
  );
  logger.debug({
    at: `Finalizer#OftRetryFinalizer:${spokePoolClient.chainId}`,
    message: `Detected ${unprocessedMessages.length} LZ retryable messages for origin ${spokePoolClient.chainId}`,
    statusesGrouped,
  });

  const endpointAbi = new ethers.utils.Interface(LZEndpoint);
  const messengerAbi = new ethers.utils.Interface(LZMessenger);
  const callData = await Promise.all(
    unprocessedMessages.map(async (message) => {
      const { guid } = message;
      const {
        srcEid,
        dstEid,
        nonce,
        sender: { address: senderAddress },
        receiver: { address: receiver },
      } = message.pathway;
      const { payload } = message.source.tx;

      const dstChainId = OFT.getChainIdFromEndpointId(dstEid);
      const provider = await getProvider(dstChainId);
      const messenger = new ethers.Contract(receiver, messengerAbi, provider);
      const target = await messenger.endpoint();

      const sender = toAddressType(senderAddress, spokePoolClient.chainId).toBytes32();
      const extraData = OFT.boostGasLimit(dstEid);

      const args = [{ srcEid, sender, nonce }, receiver, guid, payload, extraData];
      const callData = endpointAbi.encodeFunctionData("lzReceive", args);

      return { target, callData };
    })
  );

  const crossChainMessages = unprocessedMessages.map(({ pathway: { dstEid } }) => {
    return {
      originationChainId: spokePoolClient.chainId,
      destinationChainId: OFT.getChainIdFromEndpointId(dstEid),
      type: "misc",
      miscReason: "oftRetry",
    } as CrossChainMessage;
  });

  return {
    crossChainMessages,
    callData,
  };
}

/**
 * @notice Fetches OFT messages initiated from a srcOft contract
 * @param srcChainId Chain ID corresponding to the deployed srcOftMessenger.
 * @param searchConfig Event search config to use on srcChainId.
 * @param srcProvider ethers Provider instance for the srcChainId.
 * @returns A list of SortableEvents corresponding to bridge events on srcChainId.
 */
export async function getSrcOftMessages(
  srcChainId: number,
  searchConfig: EventSearchConfig,
  srcProvider: Provider
): Promise<OFT.LzBridgeEvent[]> {
  // srfOft contract currently only deployed to Arbitrum. @todo.
  if (![CHAIN_IDs.ARBITRUM].includes(srcChainId)) {
    return [];
  }

  const srcOft = getSrcOftPeriphery(srcChainId).connect(srcProvider);
  const messageInitiatedEvents = await paginatedEventQuery(srcOft, srcOft.filters.SponsoredOFTSend(), searchConfig);
  return messageInitiatedEvents.map(spreadEventWithBlockNumber);
}
