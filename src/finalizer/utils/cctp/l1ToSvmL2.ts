import { HubPoolClient, SpokePoolClient } from "../../../clients";
import {
  EventSearchConfig,
  Signer,
  TOKEN_SYMBOLS_MAP,
  assert,
  groupObjectCountsByProp,
  winston,
  convertFromWei,
  isSVMSpokePoolClient,
  getKitKeypairFromEvmSigner,
} from "../../../utils";
import { getCctpV1Messages, isDepositForBurnEvent } from "../../../utils/CCTPUtils";
import { FinalizerPromise, AddressesToFinalize } from "../../types";
import { KeyPairSigner } from "@solana/kit";
import { finalizeCCTPV1MessagesSVM } from "./svmUtils/l1Tol2";
import { CCTPMessageStatus } from "../../../common/Constants";

/**
 * Finalizes CCTP V1 token and message relays originating on Ethereum and destined to the input L2, as indicated
 * by the input SpokePoolCLient. Only works for SVM L2's since all EVM L2's use CCTP V2.
 * @param logger Logger instance.
 * @param _signer Signer instance.
 * @param hubPoolClient HubPool client instance.
 * @param l2SpokePoolClient Destination SpokePool client instance. Must be an SVM SpokePool client.
 * @param l1SpokePoolClient Origin SpokePool client instance.
 * @param senderAddresses Sender addresses to finalize for.
 * @returns FinalizerPromise instance.
 */
export async function cctpV1L1toSvmL2Finalizer(
  logger: winston.Logger,
  _signer: Signer,
  hubPoolClient: HubPoolClient,
  l2SpokePoolClient: SpokePoolClient,
  l1SpokePoolClient: SpokePoolClient,
  senderAddresses: AddressesToFinalize
): Promise<FinalizerPromise> {
  assert(isSVMSpokePoolClient(l2SpokePoolClient));
  const searchConfig: EventSearchConfig = {
    from: l1SpokePoolClient.eventSearchConfig.from,
    to: l1SpokePoolClient.latestHeightSearched,
    maxLookBack: l1SpokePoolClient.eventSearchConfig.maxLookBack,
  };
  const signer: KeyPairSigner = await getKitKeypairFromEvmSigner(_signer);
  const outstandingMessages = await getCctpV1Messages(
    Array.from(senderAddresses.keys()).filter((address) => address.isEVM()),
    hubPoolClient.chainId,
    l2SpokePoolClient.chainId,
    searchConfig,
    signer
  );
  const unprocessedMessages = outstandingMessages.filter(
    (message) => message.status === "ready" && message.attestation !== "PENDING"
  );
  const statusesGrouped = groupObjectCountsByProp(
    outstandingMessages,
    (message: { status: CCTPMessageStatus }) => message.status
  );
  logger.debug({
    at: `Finalizer#CCTPV1L1ToL2Finalizer:${l2SpokePoolClient.chainId}`,
    message: `Detected ${unprocessedMessages.length} ready to finalize messages for CCTP L1 to ${l2SpokePoolClient.chainId}`,
    statusesGrouped,
  });

  assert(isSVMSpokePoolClient(l2SpokePoolClient));
  const simulate = process.env["SEND_TRANSACTIONS"] !== "true";
  // If the l2SpokePoolClient is not an EVM client, then we must have send the finalization here, since we cannot return SVM calldata.
  const signatures = await finalizeCCTPV1MessagesSVM(
    l2SpokePoolClient,
    unprocessedMessages,
    signer,
    logger,
    simulate,
    hubPoolClient.chainId
  );

  let depositMessagesCount = 0;
  let tokenlessMessagesCount = 0;
  const amountFinalized = unprocessedMessages.reduce((acc, event) => {
    if (isDepositForBurnEvent(event)) {
      depositMessagesCount++;
      return acc + Number(event.amount);
    } else {
      tokenlessMessagesCount++;
      return acc;
    }
  }, 0);

  const anythingFinalized = unprocessedMessages.length > 0;
  if (anythingFinalized) {
    const logMessageParts: string[] = [];
    if (depositMessagesCount > 0) {
      logMessageParts.push(
        `${depositMessagesCount} deposits for ${convertFromWei(
          String(amountFinalized),
          TOKEN_SYMBOLS_MAP.USDC.decimals
        )} USDC`
      );
    }
    if (tokenlessMessagesCount > 0) {
      logMessageParts.push(`${tokenlessMessagesCount} tokenless messages`);
    }

    logger[simulate ? "debug" : "info"]({
      at: `Finalizer#CCTPV1L1ToL2Finalizer:${l2SpokePoolClient.chainId}`,
      message: `Finalized ${logMessageParts.join(" and ")} on Solana.`,
      signatures,
    });
  }

  return {
    crossChainMessages: [],
    callData: [],
  };
}
