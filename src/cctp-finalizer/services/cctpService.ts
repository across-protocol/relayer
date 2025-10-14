import { ethers } from "ethers";
import { ProcessBurnTransactionResponse, PubSubMessage } from "../types";
import {
  winston,
  getProvider,
  getCctpDestinationChainFromDomain,
  runTransaction,
  getCctpV2MessageTransmitter,
  getCctpDomainForChainId,
  PUBLIC_NETWORKS,
  chainIsProd,
  _fetchAttestationsForTxn,
  getCctpV2TokenMessenger,
} from "../../utils";

export class CCTPService {
  private privateKey: string;
  private logger: winston.Logger;

  constructor(logger?: winston.Logger) {
    this.privateKey = process.env.PRIVATE_KEY!;
    this.logger =
      logger ||
      winston.createLogger({
        level: "info",
        format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
        transports: [new winston.transports.Console()],
      });
  }

  async processBurnTransaction(message: PubSubMessage): Promise<ProcessBurnTransactionResponse> {
    try {
      const { burnTransactionHash, sourceChainId } = message;

      this.logger.info({
        at: "CCTPService#processBurnTransaction",
        message: "Processing burn transaction",
        burnTransactionHash,
        sourceChainId,
      });

      // Get source chain CCTP domain
      const sourceCctpDomain = getCctpDomainForChainId(sourceChainId);

      // Fetch attestation
      const attestationResponse = await _fetchAttestationsForTxn(
        sourceCctpDomain,
        burnTransactionHash,
        chainIsProd(sourceChainId)
      );

      if (!attestationResponse.messages?.length) {
        return {
          success: false,
          error: "No attestation found for the burn transaction",
        };
      }

      const attestation = attestationResponse.messages[0];

      if (!this.isAttestationReady(attestation.status)) {
        return {
          success: false,
          error: `Attestation not ready. Status: ${attestation.status}`,
        };
      }

      // Get burn transaction details
      const sourceProvider = await getProvider(sourceChainId, this.logger);
      const burnTx = await sourceProvider.getTransaction(burnTransactionHash);

      if (!burnTx) {
        return {
          success: false,
          error: "Could not fetch burn transaction details",
        };
      }

      // Decode transaction to get destination domain
      const destinationChainId = this.getDestinationChainId(burnTx);

      // Check if already processed
      const isAlreadyProcessed = await this.checkIfAlreadyProcessed(destinationChainId, attestation.message);

      if (isAlreadyProcessed) {
        return {
          success: true,
          mintTxHash: "ALREADY_PROCESSED",
          error: "Message has already been processed on-chain",
        };
      }

      // Process the mint
      return await this.processMint(destinationChainId, attestation);
    } catch (error) {
      this.logger.error({
        at: "CCTPService#processBurnTransaction",
        message: "Error processing burn transaction",
        error,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  private getDestinationChainId(burnTx: ethers.providers.TransactionResponse): number {
    // Get the ABI (we'll use mainnet for the ABI)
    const { abi } = getCctpV2TokenMessenger(1);
    const tokenMessengerInterface = new ethers.utils.Interface(abi!);
    const decodedCall = tokenMessengerInterface.parseTransaction({ data: burnTx.data });

    if (!decodedCall || decodedCall.name !== "depositForBurn") {
      throw new Error("Transaction is not a CCTP depositForBurn call");
    }

    const destinationDomainId = Number(decodedCall.args.destinationDomain);

    // Map domain to chain ID
    const destinationChainId = getCctpDestinationChainFromDomain(destinationDomainId, true); // true for production networks

    return destinationChainId;
  }

  private async checkIfAlreadyProcessed(chainId: number, message: string): Promise<boolean> {
    try {
      const provider = await getProvider(chainId, this.logger);
      const { address, abi } = getCctpV2MessageTransmitter(chainId);
      const contract = new ethers.Contract(address!, abi, provider);

      const messageBytes = ethers.utils.arrayify(message);
      const nonceBytes = messageBytes.slice(12, 44);
      const nonce = ethers.utils.hexlify(nonceBytes);

      return await contract.usedNonces(nonce);
    } catch (error) {
      this.logger.warn({
        at: "CCTPService#checkIfAlreadyProcessed",
        message: "Could not check used nonces, proceeding anyway",
        error,
      });
      return false;
    }
  }

  private async processMint(chainId: number, attestation: any): Promise<ProcessBurnTransactionResponse> {
    const provider = await getProvider(chainId, this.logger);
    const signer = new ethers.Wallet(this.privateKey, provider);

    const { address, abi } = getCctpV2MessageTransmitter(chainId);
    const contract = new ethers.Contract(address!, abi, signer);

    const chainName = PUBLIC_NETWORKS[chainId]?.name || `Chain ${chainId}`;
    this.logger.info({
      at: "CCTPService#processMint",
      message: `Calling receiveMessage on ${chainName} (${chainId})`,
    });

    try {
      const mintTx = await runTransaction(this.logger, contract, "receiveMessage", [
        attestation.message,
        attestation.attestation,
      ]);

      this.logger.info({
        at: "CCTPService#processMint",
        message: "Mint transaction confirmed",
        txHash: mintTx.hash,
      });

      return {
        success: true,
        mintTxHash: mintTx.hash,
      };
    } catch (error) {
      this.logger.error({
        at: "CCTPService#processMint",
        message: "Mint transaction failed",
        error,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Mint transaction failed",
      };
    }
  }

  private isAttestationReady(status: string): boolean {
    return ["complete", "done", "succeeded"].includes(status);
  }
}
