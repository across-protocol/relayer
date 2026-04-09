import { ethers } from "ethers";
import { utils } from "@across-protocol/sdk";
import {
  winston,
  submitTransaction,
  getCctpV2MessageTransmitter,
  CHAIN_IDs,
  decodeCctpV2HookData,
  TOKEN_SYMBOLS_MAP,
  CCTPHookData,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common/ContractAddresses";
import { DestinationInfo } from "../types";
import { TransactionClient } from "../../clients";
import { extractMintRecipientAddress } from "./commonUtils";

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

export function shouldCreateHyperCoreAccount(hookData?: CCTPHookData): boolean {
  const isDestinationUsdc = hookData?.finalToken === TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.HYPEREVM];
  const isSponsoredFlow = hookData?.maxBpsToSponsor > 0;
  return isSponsoredFlow || isDestinationUsdc;
}

export async function createHyperCoreAccountIfNotExists(
  message: string,
  contract: ethers.Contract,
  chainId: number,
  logger: winston.Logger
): Promise<void> {
  const hookData = decodeCctpV2HookData(message);
  if (!shouldCreateHyperCoreAccount(hookData)) {
    logger.debug({
      at: "evmUtils#createHyperCoreAccountIfNotExists",
      message: "Skipping account activation because its not sponsored flow",
      maxBpsToSponsor: hookData?.maxBpsToSponsor,
      finalRecipient: hookData?.finalRecipient,
    });
    return;
  }
  const isHypercoreAccountActive = await utils.isHlAccountActive(hookData.finalRecipient);
  if (!isHypercoreAccountActive) {
    logger.debug({
      at: "evmUtils#createHyperCoreAccountIfNotExists",
      message: "Recipient account not activated, calling activateUserAccount",
      finalRecipient: hookData.finalRecipient,
    });
    const transactionClient = new TransactionClient(logger);
    const fundingToken = TOKEN_SYMBOLS_MAP.USDC.addresses[chainId];
    await submitTransaction(
      {
        contract,
        method: "activateUserAccount",
        args: [hookData.nonce, hookData.finalRecipient, fundingToken],
        chainId,
      },
      transactionClient
    );
  }
}

/**
 * Determines the destination type and contract info based on chainId and signature presence.
 * All destination-based finalizer calls will pass signature.
 * - HyperCore: chainId = 999 or 998 with signature
 * - Lighter: chainId = 1 with signature
 * - Direct EVM: Any other EVM chain with signature
 * - Standard: All other cases without signature
 */
function getDestination(chainId: number, messageBytes: string, signature?: string): DestinationInfo {
  if (signature) {
    const isHyperEVM = chainId === CHAIN_IDs.HYPEREVM || chainId === CHAIN_IDs.HYPEREVM_TESTNET;
    const isMainnet = chainId === CHAIN_IDs.MAINNET;

    // Extract mint recipient from CCTP message - this is the SponsoredCCTPDstPeriphery contract
    const mintRecipient = extractMintRecipientAddress(messageBytes);
    const { abi } = CONTRACT_ADDRESSES[chainId]?.sponsoredCCTPDstPeriphery || {};

    if (!abi) {
      throw new Error(`SponsoredCCTPDstPeriphery ABI not configured for chain ${chainId}`);
    }

    const type = isHyperEVM ? "hypercore" : isMainnet ? "lighter" : "direct-evm";
    const accountInitialization = isHyperEVM ? createHyperCoreAccountIfNotExists : undefined;

    return {
      type,
      address: mintRecipient,
      abi,
      requiresSignature: true,
      accountInitialization,
    };
  }

  const { address, abi } = getCctpV2MessageTransmitter(chainId);
  if (!address) {
    throw new Error(`CCTP V2 MessageTransmitter address not configured for chain ${chainId}`);
  }
  return {
    type: "standard",
    address,
    abi,
    requiresSignature: false,
  };
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
  signature?: string,
  quoteDeadline?: number
): Promise<{ txHash: string }> {
  const signer = new ethers.Wallet(privateKey, provider);

  const destination = getDestination(chainId, attestation.message, signature);
  const contract = new ethers.Contract(destination.address, destination.abi, signer);

  if (destination.accountInitialization) {
    await destination.accountInitialization(attestation.message, contract, chainId, logger);
  }

  let receiveMessageArgs = destination.requiresSignature
    ? [attestation.message, attestation.attestation, signature]
    : [attestation.message, attestation.attestation];

  // if the quote deadline has expired, we don't need to pass the signature
  let method = "receiveMessage";
  if (destination.requiresSignature && quoteDeadline < Date.now() / 1000) {
    receiveMessageArgs = [attestation.message, attestation.attestation];
    method = "emergencyReceiveMessage";
  }

  logger.info({
    at: "evmUtils#processMintEvm",
    message: `Using ${destination.type} destination contract`,
    chainId,
    destinationType: destination.type,
    contractAddress: destination.address,
  });
  const transactionClient = new TransactionClient(logger);

  const mintTx = await submitTransaction(
    {
      contract: contract,
      method,
      args: receiveMessageArgs,
      chainId,
    },
    transactionClient
  );

  const mintTxReceipt = await mintTx.wait();

  logger.info({
    at: "evmUtils#processMintEvm",
    message: "Mint transaction confirmed",
    txHash: mintTxReceipt.transactionHash,
  });

  return { txHash: mintTxReceipt.transactionHash };
}
