import { ethers } from "ethers";
import { utils } from "@across-protocol/sdk";
import { winston, runTransaction, getCctpV2MessageTransmitter } from "../../utils";

/**
 * Gets EVM provider from RPC URL
 */
export function getEvmProvider(rpcUrl: string): ethers.providers.JsonRpcProvider {
  return new ethers.providers.JsonRpcProvider(rpcUrl);
}

/**
 * Checks if a CCTP message has already been processed on EVM chain (CCTP V2)
 */
export async function checkIfAlreadyProcessedEvm(
  chainId: number,
  message: string,
  provider: ethers.providers.JsonRpcProvider
): Promise<boolean> {
  const { address, abi } = getCctpV2MessageTransmitter(chainId);
  const contract = new ethers.Contract(address!, abi, provider);

  const messageBytes = ethers.utils.arrayify(message);
  const nonceBytes = messageBytes.slice(12, 44);
  const nonce = ethers.utils.hexlify(nonceBytes);

  return await utils.hasCCTPMessageBeenProcessedEvm(nonce, contract);
}

/**
 * Processes a CCTP mint transaction on EVM chain (CCTP V2)
 */
export async function processMintEvm(
  chainId: number,
  attestation: { message: string; attestation: string },
  provider: ethers.providers.JsonRpcProvider,
  privateKey: string,
  logger: winston.Logger
): Promise<{ txHash: string }> {
  const signer = new ethers.Wallet(privateKey, provider);
  const { address, abi } = getCctpV2MessageTransmitter(chainId);
  const contract = new ethers.Contract(address!, abi, signer);

  const mintTx = await runTransaction(logger, contract, "receiveMessage", [
    attestation.message,
    attestation.attestation,
  ]);

  const mintTxReceipt = await mintTx.wait();

  logger.info({
    at: "evmUtils#processMintEvm",
    message: "Mint transaction confirmed",
    txHash: mintTxReceipt.transactionHash,
  });

  return { txHash: mintTxReceipt.transactionHash };
}
