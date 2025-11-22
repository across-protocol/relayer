import { ethers } from "ethers";
import { arch } from "@across-protocol/sdk";
import { createKeyPairSignerFromBytes, createDefaultRpcTransport, createSolanaRpcFromTransport } from "@solana/kit";
import { winston, SvmAddress, sendAndConfirmSolanaTransaction, SVMProvider } from "../../utils";

/**
 * Gets SVM provider from RPC URL
 */
export function getSvmProvider(rpcUrl: string): SVMProvider {
  const transport = createDefaultRpcTransport({ url: rpcUrl });
  return createSolanaRpcFromTransport(transport);
}

/**
 * PLACEHOLDER: Checks if a CCTP V2 message has been processed on Solana
 * TODO: Implement this once SDK supports V2
 */
async function hasCCTPV2MessageBeenProcessed(): Promise<boolean> {
  throw new Error(
    "CCTP V2 for Solana is not yet implemented. Need to integrate with MessageTransmitterV2 program (CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC)"
  );
}

/**
 * PLACEHOLDER: Gets CCTP V2 receiveMessage transaction for Solana
 * TODO: Implement this once SDK supports V2
 */
async function getCCTPV2ReceiveMessageTx(): Promise<never> {
  throw new Error(
    "CCTP V2 for Solana is not yet implemented. Need to integrate with MessageTransmitterV2 program (CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC)"
  );
}

/**
 * Checks if a CCTP message has already been processed on Solana
 * Detects message version and uses appropriate V1 or V2 function
 */
export async function checkIfAlreadyProcessedSvm(
  message: string,
  svmPrivateKey: Uint8Array,
  svmProvider: SVMProvider,
  logger: winston.Logger
): Promise<boolean> {
  const svmSigner = await createKeyPairSignerFromBytes(svmPrivateKey);
  const latestBlockhash = await svmProvider.getLatestBlockhash().send();

  const messageBytes = ethers.utils.arrayify(message);
  const messageBytesArray = ethers.utils.arrayify(messageBytes);

  const version = Number(ethers.utils.hexlify(messageBytesArray.slice(0, 4)));
  const sourceDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(4, 8)));
  const nonce = Number(ethers.utils.hexlify(messageBytesArray.slice(12, 20)));

  logger.info({
    at: "svmUtils#checkIfAlreadyProcessedSvm",
    message: "Checking CCTP message version",
    version,
    sourceDomain,
    nonce,
  });

  // Version 0 = V1, Version 1 = V2
  if (version === 0) {
    return await arch.svm.hasCCTPV1MessageBeenProcessed(
      svmProvider,
      svmSigner,
      nonce,
      sourceDomain,
      latestBlockhash.value
    );
  } else {
    // V2 (version 1)
    return await hasCCTPV2MessageBeenProcessed();
  }
}

/**
 * Processes a CCTP mint transaction on Solana
 * Detects message version and uses appropriate V1 or V2 function
 */
export async function processMintSvm(
  attestation: { message: string; attestation: string },
  svmPrivateKey: Uint8Array,
  svmProvider: SVMProvider,
  logger: winston.Logger
): Promise<{ txHash: string }> {
  const svmSigner = await createKeyPairSignerFromBytes(svmPrivateKey);

  const messageBytes = ethers.utils.arrayify(attestation.message);
  const messageBytesArray = ethers.utils.arrayify(messageBytes);

  const version = Number(ethers.utils.hexlify(messageBytesArray.slice(0, 4)));
  const sourceDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(4, 8)));
  const nonce = Number(ethers.utils.hexlify(messageBytesArray.slice(12, 20)));
  const recipient = ethers.utils.hexlify(messageBytesArray.slice(52, 84));

  logger.info({
    at: "svmUtils#processMintSvm",
    message: "Processing CCTP message",
    version,
    sourceDomain,
    nonce,
  });

  const attestedMessage: arch.svm.AttestedCCTPMessage = {
    nonce,
    sourceDomain,
    messageBytes: attestation.message,
    attestation: attestation.attestation,
    type: "transfer",
  };

  let receiveMessageTx = undefined;

  // Version 0 = V1, Version 1 = V2
  if (version === 0) {
    receiveMessageTx = await arch.svm.getCCTPV1ReceiveMessageTx(
      svmProvider,
      svmSigner,
      attestedMessage,
      1, // hubChainId
      SvmAddress.from(recipient)
    );
  } else {
    // V2 (version 1)
    receiveMessageTx = await getCCTPV2ReceiveMessageTx();
  }

  const txSignature = await sendAndConfirmSolanaTransaction(receiveMessageTx, svmProvider);

  logger.info({
    at: "svmUtils#processMintSvm",
    message: "Mint transaction confirmed on Solana",
    version,
    txHash: txSignature,
  });

  return { txHash: txSignature };
}
