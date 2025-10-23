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
      const {
        burnTransactionHash,
        sourceChainId,
        message: cctpMessage,
        attestation: cctpAttestation,
        destinationChainId: providedDestinationChainId,
      } = message;

      this.logger.info({
        at: "CCTPService#processBurnTransaction",
        message: "Processing burn transaction",
        burnTransactionHash,
        sourceChainId,
        hasProvidedMessage: !!cctpMessage,
        hasProvidedAttestation: !!cctpAttestation,
        hasProvidedDestinationChainId: !!providedDestinationChainId,
      });

      let attestation: { message: string; attestation: string; status?: string };
      let destinationChainId: number;

      // If message and attestation are provided, use them directly
      if (cctpMessage && cctpAttestation) {
        this.logger.info({
          at: "CCTPService#processBurnTransaction",
          message: "Using provided message and attestation, skipping attestation fetch",
        });

        attestation = {
          message: cctpMessage,
          attestation: cctpAttestation,
        };

        // If destination chain ID is also provided, use it
        if (providedDestinationChainId) {
          this.logger.info({
            at: "CCTPService#processBurnTransaction",
            message: "Using provided destination chain ID, skipping burn transaction fetch",
            destinationChainId: providedDestinationChainId,
          });
          destinationChainId = providedDestinationChainId;
        } else {
          // Need to fetch burn transaction to decode destination chain ID
          const sourceProvider = await this.getProviderWithFallback(sourceChainId);
          const burnTx = await sourceProvider.getTransaction(burnTransactionHash);

          if (!burnTx) {
            return {
              success: false,
              error: "Could not fetch burn transaction details",
            };
          }

          destinationChainId = this.getDestinationChainId(burnTx, sourceChainId);
        }
      } else {
        this.logger.info({
          at: "CCTPService#processBurnTransaction",
          message: "Fetching attestation from API",
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

        attestation = attestationResponse.messages[0];

        if (!this.isAttestationReady(attestation.status!)) {
          return {
            success: false,
            error: `Attestation not ready. Status: ${attestation.status}`,
          };
        }

        // Get burn transaction details
        const sourceProvider = await this.getProviderWithFallback(sourceChainId);
        const burnTx = await sourceProvider.getTransaction(burnTransactionHash);

        if (!burnTx) {
          return {
            success: false,
            error: "Could not fetch burn transaction details",
          };
        }

        // Decode transaction to get destination domain
        destinationChainId = this.getDestinationChainId(burnTx, sourceChainId);
      }

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

  private getDestinationChainId(burnTx: ethers.providers.TransactionResponse, sourceChainId: number): number {
    // Get the ABI (we'll use mainnet for the ABI)
    const { abi } = getCctpV2TokenMessenger(1);
    const tokenMessengerInterface = new ethers.utils.Interface(abi!);
    const decodedCall = tokenMessengerInterface.parseTransaction({ data: burnTx.data });

    if (!decodedCall || decodedCall.name !== "depositForBurn") {
      throw new Error("Transaction is not a CCTP depositForBurn call");
    }

    const destinationDomainId = Number(decodedCall.args.destinationDomain);

    // Map domain to chain ID
    const destinationChainId = getCctpDestinationChainFromDomain(destinationDomainId, chainIsProd(sourceChainId));

    return destinationChainId;
  }

  private async checkIfAlreadyProcessed(chainId: number, message: string): Promise<boolean> {
    try {
      const provider = await this.getProviderWithFallback(chainId);
      const { address, abi } = getCctpV2MessageTransmitter(chainId);
      const contract = new ethers.Contract(address!, abi, provider);

      const messageBytes = ethers.utils.arrayify(message);
      const nonceBytes = messageBytes.slice(12, 44);
      const nonce = ethers.utils.hexlify(nonceBytes);

      const usedNonce = await contract.usedNonces(nonce);
      // usedNonces returns a BigNumber: 0 for false, 1 for true
      return usedNonce.gt(0);
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
    const provider = await this.getProviderWithFallback(chainId);
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

  private async getProviderWithFallback(chainId: number): Promise<ethers.providers.JsonRpcProvider> {
    try {
      return await getProvider(chainId, this.logger);
    } catch (error) {
      // Fallback to simple ethers provider if Redis is unavailable
      this.logger.warn({
        at: "CCTPService#getProviderWithFallback",
        message: "Redis unavailable, using simple ethers provider",
        chainId,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      const rpcUrl = this.getRpcUrlForChain(chainId);
      return new ethers.providers.JsonRpcProvider(rpcUrl);
    }
  }

  private getRpcUrlForChain(chainId: number): string {
    const rpcUrlMap: { [chainId: number]: string } = {
      // Production networks
      1: process.env.ETHEREUM_RPC_URL!,
      10: process.env.OPTIMISM_RPC_URL!,
      137: process.env.POLYGON_RPC_URL!,
      42161: process.env.ARBITRUM_RPC_URL!,
      8453: process.env.BASE_RPC_URL!,
      130: process.env.ARBITRUM_NOVA_RPC_URL!,
      59144: process.env.LINEA_RPC_URL!,
      480: process.env.ZKSYNC_RPC_URL!,
      999: process.env.POLYGON_ZKEVM_RPC_URL!,
      // Test networks
      11155111: process.env.SEPOLIA_RPC_URL!,
      11155420: process.env.OPTIMISM_SEPOLIA_RPC_URL!,
      421614: process.env.ARBITRUM_SEPOLIA_RPC_URL!,
      84532: process.env.BASE_SEPOLIA_RPC_URL!,
      80002: process.env.POLYGON_AMOY_RPC_URL!,
      1301: process.env.ARBITRUM_NOVA_SEPOLIA_RPC_URL!,
      998: process.env.POLYGON_ZKEVM_SEPOLIA_RPC_URL!,
    };

    const rpcUrl = rpcUrlMap[chainId];
    if (!rpcUrl) {
      throw new Error(`No RPC URL configured for chain ID ${chainId}`);
    }
    return rpcUrl;
  }
}
