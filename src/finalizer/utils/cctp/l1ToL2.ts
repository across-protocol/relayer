import { TransactionRequest } from "@ethersproject/abstract-provider";
import { HubPoolClient, SpokePoolClient } from "../../../clients";
import {
  Contract,
  EventSearchConfig,
  Signer,
  TOKEN_SYMBOLS_MAP,
  assert,
  groupObjectCountsByProp,
  isDefined,
  Multicall2Call,
  winston,
  convertFromWei,
  isEVMSpokePoolClient,
  ethers,
  isSVMSpokePoolClient,
  Address,
  getKitKeypairFromEvmSigner,
} from "../../../utils";
import {
  AttestedCCTPMessage,
  CCTPMessageStatus,
  getAttestedCCTPMessages,
  getCctpMessageTransmitter,
  isDepositForBurnEvent,
} from "../../../utils/CCTPUtils";
import { FinalizerPromise, CrossChainMessage } from "../../types";
import { KeyPairSigner } from "@solana/kit";
import { finalizeCCTPV1MessagesSVM } from "./svm/l1Tol2";

export async function cctpL1toL2Finalizer(
  logger: winston.Logger,
  _signer: Signer,
  hubPoolClient: HubPoolClient,
  l2SpokePoolClient: SpokePoolClient,
  l1SpokePoolClient: SpokePoolClient,
  senderAddresses: Address[]
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
  const outstandingMessages = await getAttestedCCTPMessages(
    senderAddresses,
    hubPoolClient.chainId,
    l2SpokePoolClient.chainId,
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

  const { address, abi } = getCctpMessageTransmitter(l2SpokePoolClient.chainId, l2SpokePoolClient.chainId);
  if (isEVMSpokePoolClient(l2SpokePoolClient)) {
    const l2Messenger = new ethers.Contract(address, abi, l2SpokePoolClient.spokePool.provider);
    return {
      crossChainMessages: await generateCrosschainMessages(
        unprocessedMessages,
        hubPoolClient.chainId,
        l2SpokePoolClient.chainId
      ),
      callData: await generateMultiCallData(l2Messenger, unprocessedMessages),
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
 * Generates a series of populated transactions that can be consumed by the Multicall2 contract.
 * @param messageTransmitter The CCTPMessageTransmitter contract that will be used to populate the transactions.
 * @param messages The messages to generate transactions for.
 * @returns A list of populated transactions that can be consumed by the Multicall2 contract.
 */
async function generateMultiCallData(
  messageTransmitter: Contract,
  messages: Pick<AttestedCCTPMessage, "attestation" | "messageBytes">[]
): Promise<Multicall2Call[]> {
  assert(messages.every(({ attestation }) => isDefined(attestation) && attestation !== "PENDING"));
  return Promise.all(
    messages.map(async (message) => {
      const txn = (await messageTransmitter.populateTransaction.receiveMessage(
        message.messageBytes,
        message.attestation
      )) as TransactionRequest;
      return {
        target: txn.to,
        callData: txn.data,
      };
    })
  );
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
