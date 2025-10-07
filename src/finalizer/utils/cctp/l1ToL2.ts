import { HubPoolClient, SpokePoolClient } from "../../../clients";
import {
  EventSearchConfig,
  Signer,
  TOKEN_SYMBOLS_MAP,
  assert,
  groupObjectCountsByProp,
  winston,
  convertFromWei,
  isEVMSpokePoolClient,
  isSVMSpokePoolClient,
  getKitKeypairFromEvmSigner,
  mapAsync,
} from "../../../utils";
import {
  AttestedCCTPMessage,
  getCctpV1Messages,
  isDepositForBurnEvent,
  getCctpReceiveMessageCallData,
} from "../../../utils/CCTPUtils";
import { FinalizerPromise, CrossChainMessage, AddressesToFinalize } from "../../types";
import { KeyPairSigner } from "@solana/kit";
import { finalizeCCTPV1MessagesSVM } from "./svm/l1Tol2";
import { CCTPMessageStatus } from "../../../common/Constants";

/**
 * Finalizes CCTP V1 token and message relays originating on Ethereum and destined to the input L2, as indicated
 * by the input SpokePoolCLient.
 * @param logger Logger instance.
 * @param _signer Signer instance.
 * @param hubPoolClient HubPool client instance.
 * @param l2SpokePoolClient Destination SpokePool client instance.
 * @param l1SpokePoolClient Origin SpokePool client instance.
 * @param senderAddresses Sender addresses to finalize for.
 * @returns FinalizerPromise instance.
 */
export async function cctpV1L1toL2Finalizer(
  logger: winston.Logger,
  _signer: Signer,
  hubPoolClient: HubPoolClient,
  l2SpokePoolClient: SpokePoolClient,
  l1SpokePoolClient: SpokePoolClient,
  senderAddresses: AddressesToFinalize
): Promise<FinalizerPromise> {
  assert(isEVMSpokePoolClient(l1SpokePoolClient));
  const searchConfig: EventSearchConfig = {
    from: l1SpokePoolClient.eventSearchConfig.from,
    to: l1SpokePoolClient.latestHeightSearched,
    maxLookBack: l1SpokePoolClient.eventSearchConfig.maxLookBack,
  };
  let signer: KeyPairSigner;
  if (isSVMSpokePoolClient(l2SpokePoolClient)) {
    signer = await getKitKeypairFromEvmSigner(_signer);
  }
  const outstandingMessages = await getCctpV1Messages(
    Array.from(senderAddresses.keys()),
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
    at: `Finalizer#CCTPL1ToL2Finalizer:${l2SpokePoolClient.chainId}`,
    message: `Detected ${unprocessedMessages.length} ready to finalize messages for CCTP L1 to ${l2SpokePoolClient.chainId}`,
    statusesGrouped,
  });

  if (isEVMSpokePoolClient(l2SpokePoolClient)) {
    return {
      crossChainMessages: await generateCrosschainMessages(
        unprocessedMessages,
        hubPoolClient.chainId,
        l2SpokePoolClient.chainId
      ),
      callData: await mapAsync(unprocessedMessages, async (message) => {
        const callData = await getCctpReceiveMessageCallData(
          {
            destinationChainId: l2SpokePoolClient.chainId,
            attestationData: {
              attestation: message.attestation,
              message: message.messageBytes,
            },
          },
          true /* CCTP V1 */
        );
        return {
          target: callData.to,
          callData: callData.data,
        };
      }),
    };
  } else {
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
        at: `Finalizer#CCTPL1ToL2Finalizer:${l2SpokePoolClient.chainId}`,
        message: `Finalized ${logMessageParts.join(" and ")} on Solana.`,
        signatures,
      });
    }

    return {
      crossChainMessages: [],
      callData: [],
    };
  }
}

/**
 * Generates a list of valid withdrawals for a given list of CCTP messages.
 * @param messages The CCTP messages to generate withdrawals for.
 * @param originationChainId The chain that these messages originated from
 * @param destinationChainId The chain that these messages will be executed on
 * @returns A list of valid withdrawals for a given list of CCTP messages.
 */
async function generateCrosschainMessages(
  messages: AttestedCCTPMessage[],
  originationChainId: number,
  destinationChainId: number
): Promise<CrossChainMessage[]> {
  return messages.map((message) => {
    if (isDepositForBurnEvent(message)) {
      return {
        l1TokenSymbol: "USDC", // Always USDC b/c that's the only token we support on CCTP
        amount: convertFromWei(message.amount, TOKEN_SYMBOLS_MAP.USDC.decimals), // Format out to 6 decimal places for USDC
        type: "deposit",
        originationChainId,
        destinationChainId,
      };
    } else {
      return {
        type: "misc",
        miscReason: `Finalization of CCTP crosschain message ${message.log.transactionHash} ; log index ${message.log.logIndex}`,
        originationChainId,
        destinationChainId,
      };
    }
  });
}
