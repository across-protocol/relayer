import { HubPoolClient, SpokePoolClient } from "../../../clients";
import {
  Signer,
  TOKEN_SYMBOLS_MAP,
  assert,
  groupObjectCountsByProp,
  isDefined,
  winston,
  convertFromWei,
  EventSearchConfig,
  SvmAddress,
  chainIsSvm,
  Address,
  toKitAddress,
  getStatePda,
  toAddressType,
  createFormatFunction,
  getKitKeypairFromEvmSigner,
  isSVMSpokePoolClient,
  mapAsync,
} from "../../../utils";
import { AttestedCCTPDeposit, getCCTPV1Deposits, getCctpReceiveMessageCallData } from "../../../utils/CCTPUtils";
import { bridgeTokensToHubPool } from "./svmUtils";
import { FinalizerPromise, CrossChainMessage, AddressesToFinalize } from "../../types";
import { CCTPMessageStatus } from "../../../common";

/**
 * Finalizes CCTP V1 token and message relays originating on an SVM L2 and destined to Ethereum, where the L2 is indicated
 * by the input SpokePoolCLient. Only works for SVM L2's since all EVM L2's use CCTP V2.
 * @param logger Logger instance.
 * @param _signer Signer instance.
 * @param hubPoolClient HubPool client instance.
 * @param spokePoolClient Origin SpokePool client instance. Should be an SVM SpokePool client.
 * @param _l1SpokePoolClient Hub chain spoke pool client, unused
 * @param senderAddresses Sender addresses to finalize for.
 * @returns FinalizerPromise instance.
 */
export async function cctpV1SvmL2toL1Finalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  _l1SpokePoolClient: SpokePoolClient,
  _senderAddresses: AddressesToFinalize
): Promise<FinalizerPromise> {
  const searchConfig: EventSearchConfig = {
    from: spokePoolClient.eventSearchConfig.from,
    to: spokePoolClient.latestHeightSearched,
    maxLookBack: spokePoolClient.eventSearchConfig.maxLookBack,
  };
  assert(isSVMSpokePoolClient(spokePoolClient));
  assert(chainIsSvm(spokePoolClient.chainId));
  const senderAddresses = Array.from(_senderAddresses.keys());
  const augmentedSenderAddresses = await augmentSendersListForSolana(senderAddresses, spokePoolClient);

  // Solana has a two step withdrawal process, where the funds in the spoke pool's transfer liability PDA must be manually withdrawn after
  // a refund leaf has been executed.
  const svmSigner = await getKitKeypairFromEvmSigner(signer);
  const bridgeTokens = await bridgeTokensToHubPool(spokePoolClient, svmSigner, logger, hubPoolClient.chainId);
  logger[isDefined(bridgeTokens.signature) ? "info" : "debug"]({
    at: `Finalizer#CCTPV1L2ToL1Finalizer:${spokePoolClient.chainId}`,
    message: bridgeTokens.message,
    signature: bridgeTokens.signature,
  });
  const outstandingDeposits = await getCCTPV1Deposits(
    augmentedSenderAddresses,
    spokePoolClient.chainId,
    hubPoolClient.chainId,
    searchConfig
  );

  const unprocessedMessages = outstandingDeposits.filter(
    ({ status, attestation }) => status === "ready" && attestation !== "PENDING"
  );
  const statusesGrouped = groupObjectCountsByProp(
    outstandingDeposits,
    (message: { status: CCTPMessageStatus }) => message.status
  );
  const pending = outstandingDeposits
    .filter(({ status }) => status === "pending")
    .map((deposit) => {
      const formatter = createFormatFunction(2, 4, false, 6);
      const recipient = toAddressType(deposit.recipient, spokePoolClient.chainId);
      const transactionHash = deposit.log?.transactionHash;
      return {
        amount: formatter(deposit.amount),
        recipient,
        transactionHash,
      };
    });
  logger.debug({
    at: `Finalizer#CCTPV1L2ToL1Finalizer:${spokePoolClient.chainId}`,
    message: `Detected ${unprocessedMessages.length} ready to finalize messages for CCTP ${spokePoolClient.chainId} to L1`,
    statusesGrouped,
    pending,
  });

  return {
    crossChainMessages: await generateWithdrawalData(
      unprocessedMessages,
      spokePoolClient.chainId,
      hubPoolClient.chainId
    ),
    callData: await mapAsync(unprocessedMessages, async (message) => {
      const callData = await getCctpReceiveMessageCallData(
        {
          destinationChainId: hubPoolClient.chainId,
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
}

/**
 * Generates a list of valid withdrawals for a given list of CCTP messages.
 * @param messages The CCTP messages to generate withdrawals for.
 * @param originationChainId The chain that these messages originated from
 * @param destinationChainId The chain that these messages will be executed on
 * @returns A list of valid withdrawals for a given list of CCTP messages.
 */
async function generateWithdrawalData(
  messages: Pick<AttestedCCTPDeposit, "amount">[],
  originationChainId: number,
  destinationChainId: number
): Promise<CrossChainMessage[]> {
  return messages.map((message) => ({
    l1TokenSymbol: "USDC", // Always USDC b/c that's the only token we support on CCTP
    amount: convertFromWei(message.amount, TOKEN_SYMBOLS_MAP.USDC.decimals),
    type: "withdrawal",
    originationChainId,
    destinationChainId,
  }));
}

/**
 * When finalizing CCTP token transfers from Solana to Ethereum, especially transfers from the SpokePool, it's not enough
 * to have SpokePool address in the `senderAddresses`. We instead need SpokePool's `statePda` in there, because that is
 * what gets recorded as `depositor` in the `DepositForBurn` event
 */
async function augmentSendersListForSolana(
  senderAddresses: Address[],
  spokePoolClient: SpokePoolClient
): Promise<Address[]> {
  const spokeAddress = spokePoolClient.spokePoolAddress;
  // This format is taken from `src/finalizer/index.ts`
  if (senderAddresses.some((address) => address.eq(spokeAddress))) {
    const _statePda = await getStatePda(toKitAddress(spokeAddress));
    // This format has to match format in CCTPUtils.ts >
    const statePda = SvmAddress.from(_statePda.toString());
    return [...senderAddresses, statePda];
  } else {
    return senderAddresses;
  }
}
