import { SpokePoolClient } from "../../../clients";
import {
  TOKEN_SYMBOLS_MAP,
  assert,
  groupObjectCountsByProp,
  winston,
  convertFromWei,
  EventSearchConfig,
  chainIsSvm,
  getCachedProvider,
  getNetworkName,
  mapAsync,
} from "../../../utils";
import {
  getCctpV2DepositForBurnTxnHashes,
  getCctpV2DepositForBurnStatuses,
  getCctpReceiveMessageCallData,
} from "../../../utils/CCTPUtils";
import { FinalizerPromise, AddressesToFinalize } from "../../types";

/**
 * @notice This finalizes only CCTP V2 token relays that emit DepositForBurn events and where the sender or
 * recipient addresses are in the list of addressesToFinalize passed in.
 * @param logger
 * @param spokePoolClient Origin chain spoke pool client
 * @param addressesToFinalize Addresses sending or receiving Deposits that we want to finalize for.
 * @returns
 */
export async function cctpV2Finalizer(
  logger: winston.Logger,
  spokePoolClient: SpokePoolClient,
  addressesToFinalize: AddressesToFinalize
): Promise<FinalizerPromise> {
  const searchConfig: EventSearchConfig = {
    from: spokePoolClient.eventSearchConfig.from,
    to: spokePoolClient.latestHeightSearched,
    maxLookBack: spokePoolClient.eventSearchConfig.maxLookBack,
  };
  const sourceChainId = spokePoolClient.chainId;
  assert(!chainIsSvm(sourceChainId), "cctpFinalizer only supports EVM chains");

  const senderAndRecipientAddresses = Array.from(addressesToFinalize.keys());

  // Get all DepositForBurn events from source chain sent from one of the addresses in addressesToFinalize.
  const sourceProvider = getCachedProvider(sourceChainId);
  const depositForBurnEvents = await getCctpV2DepositForBurnTxnHashes(
    sourceProvider,
    sourceChainId,
    senderAndRecipientAddresses,
    searchConfig
  );

  const { pendingDepositTxnHashes, finalizedDepositTxnHashes, readyToFinalizeDeposits } =
    await getCctpV2DepositForBurnStatuses(depositForBurnEvents, sourceChainId, senderAndRecipientAddresses);

  const finalizedGrouped = groupObjectCountsByProp(
    finalizedDepositTxnHashes,
    (deposit: { txnHash: string; destinationChainId: number }) => getNetworkName(deposit.destinationChainId)
  );
  const readyToFinalizeGrouped = groupObjectCountsByProp(
    readyToFinalizeDeposits,
    (deposit: { txnHash: string; destinationChainId: number }) => getNetworkName(deposit.destinationChainId)
  );
  logger.debug({
    at: `Finalizer#CCTPV2AnyToAnyFinalizer:${sourceChainId}`,
    message: `Detected ${
      readyToFinalizeDeposits.length
    } ready to finalize messages originating from CCTP on ${getNetworkName(sourceChainId)}`,
    pending: pendingDepositTxnHashes.length,
    finalized: finalizedGrouped,
    readyToFinalize: readyToFinalizeGrouped,
  });
  return {
    crossChainMessages: readyToFinalizeDeposits.map((attestation) => ({
      l1TokenSymbol: "USDC", // Always USDC b/c that's the only token we support on CCTP
      amount: convertFromWei(attestation.attestationData.amount, TOKEN_SYMBOLS_MAP.USDC.decimals),
      type: "withdrawal",
      originationChainId: sourceChainId,
      destinationChainId: attestation.destinationChainId,
    })),
    callData: await mapAsync(readyToFinalizeDeposits, async (attestation) => {
      const txn = await getCctpReceiveMessageCallData(attestation, false /* CCTP V2 */);
      return {
        target: txn.to,
        callData: txn.data,
      };
    }),
  };
}
