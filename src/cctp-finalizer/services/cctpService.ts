import { ethers } from "ethers";
import { utils } from "@across-protocol/sdk";
import { ProcessBurnTransactionResponse, PubSubMessage } from "../types";
import {
  winston,
  getCctpDestinationChainFromDomain,
  PUBLIC_NETWORKS,
  chainIsProd,
  chainIsSvm,
  getCctpV2TokenMessenger,
} from "../../utils";
import { checkIfAlreadyProcessedEvm, processMintEvm, getEvmProvider } from "../utils/evmUtils";
import { checkIfAlreadyProcessedSvm, processMintSvm, getSvmProvider } from "../utils/svmUtils";

export class CCTPService {
  private privateKey: string;
  private svmPrivateKey?: Uint8Array;
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

    if (process.env.SVM_PRIVATE_KEY) {
      try {
        this.svmPrivateKey = Uint8Array.from(JSON.parse(process.env.SVM_PRIVATE_KEY));
      } catch (error) {
        this.logger.warn({ at: "CCTPService#constructor", message: "Failed to parse SVM private key", error });
      }
    }
  }

  async processBurnTransaction(message: PubSubMessage): Promise<ProcessBurnTransactionResponse> {
    try {
      const {
        burnTransactionHash,
        sourceChainId,
        message: cctpMessage,
        attestation: cctpAttestation,
        destinationChainId: providedDestinationChainId,
        signature,
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
          const rpcUrl = this.getRpcUrlForChain(sourceChainId);
          const sourceProvider = getEvmProvider(rpcUrl);
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

        // Fetch attestation
        const attestationResponse = await utils.fetchCctpV2Attestations([burnTransactionHash], sourceChainId);

        const attestations = attestationResponse[burnTransactionHash];

        if (!attestations?.messages?.length) {
          return {
            success: false,
            error: "No attestation found for the burn transaction",
          };
        }

        attestation = attestations.messages[0];

        if (!this.isAttestationReady(attestation.status!)) {
          return {
            success: false,
            error: `Attestation not ready. Status: ${attestation.status}`,
          };
        }

        // Get burn transaction details
        const rpcUrl = this.getRpcUrlForChain(sourceChainId);
        const sourceProvider = getEvmProvider(rpcUrl);
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
      return await this.processMint(destinationChainId, attestation, signature);
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
      if (chainIsSvm(chainId)) {
        if (!this.svmPrivateKey) {
          this.logger.warn({
            at: "CCTPService#checkIfAlreadyProcessed",
            message: "SVM private key not available, cannot check if message processed on Solana",
          });
          return false;
        }

        const rpcUrl = this.getRpcUrlForChain(chainId);
        const svmProvider = getSvmProvider(rpcUrl);
        return await checkIfAlreadyProcessedSvm(message, this.svmPrivateKey, svmProvider, this.logger);
      } else {
        const rpcUrl = this.getRpcUrlForChain(chainId);
        const provider = getEvmProvider(rpcUrl);
        return await checkIfAlreadyProcessedEvm(chainId, message, provider);
      }
    } catch (error) {
      this.logger.warn({
        at: "CCTPService#checkIfAlreadyProcessed",
        message: "Could not check used nonces, proceeding anyway",
        error,
      });
      return false;
    }
  }

  private async processMint(
    chainId: number,
    attestation: any,
    signature?: string
  ): Promise<ProcessBurnTransactionResponse> {
    const chainName = PUBLIC_NETWORKS[chainId]?.name || `Chain ${chainId}`;
    this.logger.info({
      at: "CCTPService#processMint",
      message: `Calling receiveMessage on ${chainName} (${chainId})`,
    });

    try {
      if (chainIsSvm(chainId)) {
        if (!this.svmPrivateKey) {
          return {
            success: false,
            error: "SVM private key not configured for Solana CCTP finalization",
          };
        }

        const rpcUrl = this.getRpcUrlForChain(chainId);
        const svmProvider = getSvmProvider(rpcUrl);
        const result = await processMintSvm(attestation, this.svmPrivateKey, svmProvider, this.logger);
        return {
          success: true,
          mintTxHash: result.txHash,
        };
      } else {
        const rpcUrl = this.getRpcUrlForChain(chainId);
        const provider = getEvmProvider(rpcUrl);
        const result = await processMintEvm(chainId, attestation, provider, this.privateKey, this.logger, signature);
        return {
          success: true,
          mintTxHash: result.txHash,
        };
      }
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
      999: process.env.HYPEREVM_RPC_URL!,
      34268394551451: process.env.SOLANA_RPC_URL!,
      // Test networks
      11155111: process.env.SEPOLIA_RPC_URL!,
      11155420: process.env.OPTIMISM_SEPOLIA_RPC_URL!,
      421614: process.env.ARBITRUM_SEPOLIA_RPC_URL!,
      84532: process.env.BASE_SEPOLIA_RPC_URL!,
      80002: process.env.POLYGON_AMOY_RPC_URL!,
      1301: process.env.ARBITRUM_NOVA_SEPOLIA_RPC_URL!,
      998: process.env.HYPEREVM_TESTNET_RPC_URL!,
      133268194659241: process.env.SOLANA_DEVNET_RPC_URL!,
    };

    const rpcUrl = rpcUrlMap[chainId];
    if (!rpcUrl) {
      throw new Error(`No RPC URL configured for chain ID ${chainId}`);
    }
    return rpcUrl;
  }
}
