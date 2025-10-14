import { ethers } from "ethers";
import { getChainConfig } from "../config/chains";
import { AttestationService } from "./attestationService";
import { MESSAGE_TRANSMITTER_ABI, TOKEN_MESSENGER_ABI } from "../utils/contracts/abis";
import { ProcessBurnTransactionResponse, PubSubMessage } from "../types";

export class CCTPService {
  private attestationService: AttestationService;
  private privateKey: string;

  constructor(isMainnet: boolean = true) {
    this.attestationService = new AttestationService(isMainnet);
    this.privateKey = process.env.PRIVATE_KEY!;
  }

  async processBurnTransaction(message: PubSubMessage): Promise<ProcessBurnTransactionResponse> {
    try {
      const { burnTransactionHash, sourceChainId } = message;

      console.log(`Processing burn transaction: ${burnTransactionHash}`);
      console.log(`Source chain: ${sourceChainId}`);

      // Get source chain config
      const sourceConfig = getChainConfig(sourceChainId);

      // Fetch attestation
      const attestationResponse = await this.attestationService.fetchAttestation(
        sourceConfig.cctpDomain,
        burnTransactionHash
      );

      if (!attestationResponse.messages?.length) {
        return {
          success: false,
          error: "No attestation found for the burn transaction",
        };
      }

      const attestation = attestationResponse.messages[0];

      if (!this.attestationService.isAttestationReady(attestation.status)) {
        return {
          success: false,
          error: `Attestation not ready. Status: ${attestation.status}`,
        };
      }

      // Get burn transaction details
      const sourceProvider = new ethers.providers.JsonRpcProvider(sourceConfig.rpcUrl);
      const burnTx = await sourceProvider.getTransaction(burnTransactionHash);

      if (!burnTx) {
        return {
          success: false,
          error: "Could not fetch burn transaction details",
        };
      }

      // Decode transaction to get destination domain
      const destinationChainId = this.getDestinationChainId(burnTx);
      const destinationConfig = getChainConfig(destinationChainId);

      // Check if already processed
      const isAlreadyProcessed = await this.checkIfAlreadyProcessed(destinationConfig, attestation.message);

      if (isAlreadyProcessed) {
        return {
          success: true,
          mintTxHash: "ALREADY_PROCESSED",
          error: "Message has already been processed on-chain",
        };
      }

      // Process the mint
      return await this.processMint(destinationConfig, attestation);
    } catch (error) {
      console.error("Error processing burn transaction:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  private getDestinationChainId(burnTx: ethers.providers.TransactionResponse): number {
    const tokenMessengerInterface = new ethers.utils.Interface(TOKEN_MESSENGER_ABI);
    const decodedCall = tokenMessengerInterface.parseTransaction({ data: burnTx.data });

    if (!decodedCall || decodedCall.name !== "depositForBurn") {
      throw new Error("Transaction is not a CCTP depositForBurn call");
    }

    const destinationDomainId = Number(decodedCall.args.destinationDomain);

    // Map domain IDs to chain IDs
    const domainToChainId: Record<number, number> = {
      0: 1, // Ethereum
      1: 42161, // Arbitrum
      2: 10, // Optimism
      3: 137, // Polygon
      6: 8453, // Base
    };

    const destinationChainId = domainToChainId[destinationDomainId];
    if (!destinationChainId) {
      throw new Error(`Unknown destination domain ID: ${destinationDomainId}`);
    }

    return destinationChainId;
  }

  private async checkIfAlreadyProcessed(config: any, message: string): Promise<boolean> {
    try {
      const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
      const contract = new ethers.Contract(config.messageTransmitterAddress, MESSAGE_TRANSMITTER_ABI, provider);

      const messageBytes = ethers.utils.arrayify(message);
      const nonceBytes = messageBytes.slice(12, 44);
      const nonce = ethers.utils.hexlify(nonceBytes);

      return await contract.usedNonces(nonce);
    } catch (error) {
      console.warn("Could not check used nonces, proceeding anyway:", error);
      return false;
    }
  }

  private async processMint(config: any, attestation: any): Promise<ProcessBurnTransactionResponse> {
    const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
    const signer = new ethers.Wallet(this.privateKey, provider);

    const contract = new ethers.Contract(config.messageTransmitterAddress, MESSAGE_TRANSMITTER_ABI, signer);

    console.log(`Calling receiveMessage on ${config.name} (${config.chainId})`);

    const mintTx = await contract.receiveMessage(attestation.message, attestation.attestation);

    console.log(`Mint transaction submitted: ${mintTx.hash}`);

    const receipt = await mintTx.wait();

    if (receipt.status === 1) {
      console.log(`Mint transaction confirmed: ${receipt.transactionHash}`);
      return {
        success: true,
        mintTxHash: receipt.transactionHash,
      };
    } else {
      return {
        success: false,
        error: "Mint transaction failed",
      };
    }
  }
}
