import { ethers } from "ethers";
import { utils } from "@across-protocol/sdk";
import {
  winston,
  runTransaction,
  getCctpV2MessageTransmitter,
  CHAIN_IDs,
  isHlAccountActive,
  depositToHypercore,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common/ContractAddresses";

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

export async function createHyperCoreAccountIfNotExists(
  message: string,
  signer: ethers.Wallet,
  logger: winston.Logger
): Promise<void> {
  const messageBytes = ethers.utils.arrayify(message);

  // Extract recipient address: starts at byte 36, 32 bytes long (bytes32 format)
  // The address is the last 20 bytes of the 32-byte value
  const recipientBytes32 = messageBytes.slice(36, 68);
  const recipientAddress = ethers.utils.getAddress(
    ethers.utils.hexlify(recipientBytes32.slice(12)) // Take last 20 bytes
  );

  const isHypercoreAccountActive = await isHlAccountActive(recipientAddress);
  if (!isHypercoreAccountActive) {
    await depositToHypercore(recipientAddress, signer, logger);
  }
}

/**
 * Processes a CCTP mint transaction on EVM chain (CCTP V2)
 */
export async function processMintEvm(
  chainId: number,
  attestation: { message: string; attestation: string },
  provider: ethers.providers.JsonRpcProvider,
  privateKey: string,
  logger: winston.Logger,
  signature?: string
): Promise<{ txHash: string }> {
  const signer = new ethers.Wallet(privateKey, provider);

  const isHyperEVM = chainId === CHAIN_IDs.HYPEREVM || chainId === CHAIN_IDs.HYPEREVM_TESTNET;

  let contract: ethers.Contract;
  let receiveMessageArgs: unknown[];

  const isHyperCoreDestination = isHyperEVM && signature;

  if (isHyperCoreDestination) {
    await createHyperCoreAccountIfNotExists(attestation.message, signer, logger);
    // Use SponsoredCCTPDstPeriphery for HyperCore destinations (both sponsored and non-sponsored flows)
    const { address, abi } = CONTRACT_ADDRESSES[chainId].sponsoredCCTPDstPeriphery;
    if (!address) {
      throw new Error(`SponsoredCCTPDstPeriphery address not configured for chain ${chainId}`);
    }
    contract = new ethers.Contract(address, abi, signer);
    receiveMessageArgs = [attestation.message, attestation.attestation, signature];
    logger.info({
      at: "evmUtils#processMintEvm",
      message: "Using SponsoredCCTPDstPeriphery contract for HyperCore destination",
      chainId,
      contractAddress: address,
    });
  } else {
    // Use standard MessageTransmitter for non-HyperCore destinations
    const { address, abi } = getCctpV2MessageTransmitter(chainId);
    contract = new ethers.Contract(address!, abi, signer);
    receiveMessageArgs = [attestation.message, attestation.attestation];
    logger.info({
      at: "evmUtils#processMintEvm",
      message: "Using standard MessageTransmitter contract",
      chainId,
      contractAddress: address,
    });
  }

  const mintTx = await runTransaction(logger, contract, "receiveMessage", receiveMessageArgs);

  const mintTxReceipt = await mintTx.wait();

  logger.info({
    at: "evmUtils#processMintEvm",
    message: "Mint transaction confirmed",
    txHash: mintTxReceipt.transactionHash,
  });

  return { txHash: mintTxReceipt.transactionHash };
}
