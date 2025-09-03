import { getBase64EncodedWireTransaction, KeyPairSigner, signTransactionMessageWithSigners } from "@solana/kit";
import { updateOrAppendSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { SVMSpokePoolClient } from "../../../../clients";
import { AttestedCCTPMessage, isDepositForBurnEvent } from "../../../../utils/CCTPUtils";
import { mapAsync, winston, SvmAddress, isDefined } from "../../../../utils";
import { arch } from "@across-protocol/sdk";

/**
 * Finalizes CCTP deposits and messages on Solana.
 *
 * @param solanaClient The Solana client.
 * @param attestedMessages The CCTP messages to Solana.
 * @param signer A base signer to be converted into a Solana signer.
 * @param simulate Whether to simulate the transaction.
 * @param hubChainId The chain ID of the hub.
 * @returns A list of executed transaction signatures.
 */
export async function finalizeCCTPV1MessagesSVM(
  solanaClient: SVMSpokePoolClient,
  attestedMessages: AttestedCCTPMessage[],
  signer: KeyPairSigner,
  logger: winston.Logger,
  simulate = false,
  hubChainId = 1
): Promise<string[]> {
  const svmProvider = solanaClient.svmEventsClient.getRpc();
  return mapAsync(attestedMessages, async (message) => {
    const attestedCCTPMessage = attestedCCTPMessageToSvmAttestedCCTPMessage(message);
    const _receiveMessageIx = await arch.svm.getCCTPV1ReceiveMessageTx(
      svmProvider,
      signer,
      attestedCCTPMessage,
      hubChainId,
      SvmAddress.from(message.recipient)
    );

    const computeUnitAmount = process.env["SVM_COMPUTE_UNIT_OVERRIDE"];
    const receiveMessageIx = isDefined(computeUnitAmount)
      ? updateOrAppendSetComputeUnitLimitInstruction(Number(computeUnitAmount), _receiveMessageIx)
      : _receiveMessageIx;
    if (simulate) {
      const result = await svmProvider
        .simulateTransaction(
          getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(receiveMessageIx)),
          {
            encoding: "base64",
          }
        )
        .send();
      if (result.value.err) {
        throw new Error(result.value.err.toString());
      }
      return "";
    }

    try {
      const signedTransaction = await signTransactionMessageWithSigners(receiveMessageIx);
      const encodedTransaction = getBase64EncodedWireTransaction(signedTransaction);
      return await svmProvider
        .sendTransaction(encodedTransaction, { preflightCommitment: "confirmed", encoding: "base64" })
        .send();
    } catch (err) {
      logger.error({
        at: `Finalizer#finalizeSvmMessages:${solanaClient.chainId}`,
        message: `Failed to finalize CCTP message ${message.log.transactionHash} ; log index ${message.log.logIndex}`,
        error: err,
      });
      throw err;
    }
  });
}

export function attestedCCTPMessageToSvmAttestedCCTPMessage(
  message: AttestedCCTPMessage
): arch.svm.AttestedCCTPMessage {
  return {
    nonce: message.nonce,
    sourceDomain: message.sourceDomain,
    messageBytes: message.messageBytes,
    attestation: message.attestation,
    type: isDepositForBurnEvent(message) ? "transfer" : "message",
  };
}
