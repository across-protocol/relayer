import { config } from "dotenv";
import {
  retrieveSignerFromCLIArgs,
  getProvider,
  getTokenInfo,
  getNetworkName,
  EvmAddress,
  CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
  createFormatFunction,
  ERC20,
  Contract,
  getRemoteTokenForL1Token,
  isDefined,
  blockExplorerLink,
  getCctpDomainForChainId,
  Logger,
  winston,
} from "../src/utils";
import { CCTP_NO_DOMAIN } from "@across-protocol/constants";
import { constructCctpDepositForBurnTxn } from "../src/utils/CCTPUtils";
import { MultiCallerClient } from "../src/clients";

// Load environment variables from .env file
config();

// Example usage:
//   ts-node ./scripts/refillUsdcToSpecificChain.ts --wallet gckms --keys bot1
//
// Required environment variables (set in .env file):
//   SOURCE_CHAIN_IDS="[8453,42161,137]"  # JSON array of source chain IDs
//   DST_CHAIN_ID=42161                   # Destination chain ID (optional, defaults to DEFAULT_DST_CHAIN_ID or Arbitrum)
//   SEND_TRANSACTIONS=true                         # Set to "true" to execute transactions (default: false)
//   MIN_BALANCE_THRESHOLD_USDC=4         # Minimum USDC balance to trigger transfer (default: 100)

const MAINNET_CHAIN_ID = CHAIN_IDs.MAINNET;

// Configuration constants with environment variable support
const MIN_BALANCE_THRESHOLD_USDC = Number(process.env.MIN_BALANCE_THRESHOLD_USDC) || 100; // Minimum USDC balance (in human-readable units) to trigger transfer
const DEFAULT_DESTINATION_CHAIN_ID = CHAIN_IDs.ARBITRUM; // Default to Arbitrum

let logger: winston.Logger;

async function run(): Promise<void> {
  // Get configuration from environment variables only
  const chainIdsInput = process.env.SOURCE_CHAIN_IDS;
  if (!chainIdsInput) {
    throw new Error("Missing required environment variable: SOURCE_CHAIN_IDS");
  }

  let sourceChainIds: number[];
  try {
    sourceChainIds = JSON.parse(chainIdsInput);
    if (!Array.isArray(sourceChainIds) || sourceChainIds.length === 0) {
      throw new Error("SOURCE_CHAIN_IDS must be a non-empty array");
    }
  } catch (error) {
    throw new Error(`Invalid SOURCE_CHAIN_IDS format. Expected JSON array, got: ${chainIdsInput}`);
  }

  // Validate destination chain from ENV var
  const destinationChainId = Number(process.env.DST_CHAIN_ID) || DEFAULT_DESTINATION_CHAIN_ID;
  if (isNaN(destinationChainId) || destinationChainId <= 0) {
    throw new Error(`Invalid DST_CHAIN_ID: must be a positive number, got: ${process.env.DST_CHAIN_ID}`);
  }
  if (destinationChainId === MAINNET_CHAIN_ID) {
    throw new Error("Destination chain must be an L2 chain, not Mainnet (1)");
  }

  // Validate all source chains are L2 and different from destination
  sourceChainIds.forEach((chainId) => {
    if (chainId === CHAIN_IDs.SOLANA) {
      throw new Error(`Source chain ${chainId} cannot be Solana.`);
    }
    if (chainId === destinationChainId) {
      throw new Error(`Source chain ${chainId} cannot be the same as destination chain ${destinationChainId}`);
    }
  });

  // Get sendTx flag from ENV var
  const sendTransactions = process.env.SEND_TRANSACTIONS === "true";

  const destinationChainName = getNetworkName(destinationChainId);
  logger.info({
    at: "RefillUsdcToSpecificChain#run",
    message: "🚀 Starting USDC balance check and bridge",
    sourceChainCount: sourceChainIds.length,
    sourceChains: sourceChainIds,
    destinationChain: destinationChainName,
    destinationChainId,
    minBalanceThreshold: MIN_BALANCE_THRESHOLD_USDC,
    sendTransactions,
  });

  // Get signer
  const baseSigner = await retrieveSignerFromCLIArgs();
  const signerAddr = await baseSigner.getAddress();
  logger.info({
    at: "RefillUsdcToSpecificChain#run",
    message: "Connected to account",
    signerAddress: signerAddr,
  });

  // Get L1 token address
  const usdcTokenInfo = TOKEN_SYMBOLS_MAP.USDC;
  if (!usdcTokenInfo) {
    throw new Error("USDC not found in TOKEN_SYMBOLS_MAP");
  }

  const l1UsdcAddress = usdcTokenInfo.addresses[MAINNET_CHAIN_ID];
  if (!l1UsdcAddress) {
    throw new Error("USDC not found on Mainnet");
  }
  const l1UsdcToken = EvmAddress.from(l1UsdcAddress);

  // Validate destination chain has CCTP support
  const dstCctpDomain = getCctpDomainForChainId(destinationChainId);
  if (dstCctpDomain === CCTP_NO_DOMAIN) {
    throw new Error(
      `Destination chain ${destinationChainName} (chain ID: ${destinationChainId}) does not have CCTP support.`
    );
  }

  // Check balances and collect transactions
  const multicallerClient = new MultiCallerClient(logger);
  const transactionsToExecute: Array<{ chainId: number; chainName: string; amount: string; balance: string }> = [];

  logger.info({
    at: "RefillUsdcToSpecificChain#run",
    message: "📊 Checking balances on source chains",
    sourceChainCount: sourceChainIds.length,
  });

  for (const sourceChainId of sourceChainIds) {
    const sourceChainName = getNetworkName(sourceChainId);

    // Validate source chain has CCTP support
    const srcCctpDomain = getCctpDomainForChainId(sourceChainId);
    if (srcCctpDomain === CCTP_NO_DOMAIN) {
      logger.warn({
        at: "RefillUsdcToSpecificChain#run",
        message: "⚠️  Skipping chain: No CCTP support",
        chainName: sourceChainName,
        chainId: sourceChainId,
      });
      continue;
    }

    try {
      // Get signer for this chain
      const sourceSigner = baseSigner.connect(await getProvider(sourceChainId));

      // Get USDC token address on source chain
      let sourceUsdcToken: EvmAddress = l1UsdcToken;
      if (sourceChainId !== MAINNET_CHAIN_ID) {
        const sourceUsdcTokenAddress = getRemoteTokenForL1Token(l1UsdcToken, sourceChainId, MAINNET_CHAIN_ID);
        if (!isDefined(sourceUsdcTokenAddress)) {
          logger.warn({
            at: "RefillUsdcToSpecificChain#run",
            message: "⚠️  Skipping chain: USDC not found",
            chainName: sourceChainName,
            chainId: sourceChainId,
          });
          continue;
        }
        sourceUsdcToken = EvmAddress.from(sourceUsdcTokenAddress.toNative());
      }

      const sourceUsdcTokenInfo = getTokenInfo(sourceUsdcToken, sourceChainId);
      const formatter = createFormatFunction(2, 4, false, sourceUsdcTokenInfo.decimals);

      // Check balance
      const usdcContract = new Contract(sourceUsdcToken.toNative(), ERC20.abi, sourceSigner);
      const balance = await usdcContract.balanceOf(signerAddr);
      const balanceFormatted = formatter(balance.toString());
      const balanceInUsdc = parseFloat(balanceFormatted);

      logger.info({
        at: "RefillUsdcToSpecificChain#run",
        message: "Checked balance on source chain",
        chainName: sourceChainName,
        chainId: sourceChainId,
        balance: balanceFormatted,
        balanceInUsdc,
      });

      // Check if balance exceeds threshold
      if (balanceInUsdc >= MIN_BALANCE_THRESHOLD_USDC) {
        logger.info({
          at: "RefillUsdcToSpecificChain#run",
          message: "✓ Balance exceeds threshold - queuing transaction",
          chainName: sourceChainName,
          chainId: sourceChainId,
          balance: balanceFormatted,
          threshold: MIN_BALANCE_THRESHOLD_USDC,
        });

        // Construct transaction to send entire balance to destination chain
        const toAddress = EvmAddress.from(signerAddr);
        const txn = await constructCctpDepositForBurnTxn(
          sourceChainId,
          destinationChainId,
          sourceSigner,
          toAddress,
          sourceUsdcToken,
          balance, // Send entire balance
          undefined // No fast mode for now
        );

        // Enqueue transaction
        multicallerClient.enqueueTransaction(txn);
        transactionsToExecute.push({
          chainId: sourceChainId,
          chainName: sourceChainName,
          amount: balanceFormatted,
          balance: balanceFormatted,
        });

        logger.info({
          at: "RefillUsdcToSpecificChain#run",
          message: "→ Queued transaction to bridge USDC",
          chainName: sourceChainName,
          chainId: sourceChainId,
          amount: balanceFormatted,
          destinationChain: destinationChainName,
          destinationChainId,
        });
      } else {
        logger.info({
          at: "RefillUsdcToSpecificChain#run",
          message: "✗ Balance below threshold - skipping",
          chainName: sourceChainName,
          chainId: sourceChainId,
          balance: balanceFormatted,
          threshold: MIN_BALANCE_THRESHOLD_USDC,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({
        at: "RefillUsdcToSpecificChain#run",
        message: "❌ Error processing chain",
        chainName: sourceChainName,
        chainId: sourceChainId,
        error: errorMessage,
      });
      // Continue with other chains
    }
  }

  if (transactionsToExecute.length === 0) {
    logger.info({
      at: "RefillUsdcToSpecificChain#run",
      message: "✅ No transactions to execute. All balances are below the threshold.",
    });
    return;
  }

  // Summary
  logger.info({
    at: "RefillUsdcToSpecificChain#run",
    message: "📍 Transaction Summary",
    totalTransactions: transactionsToExecute.length,
    destinationChain: destinationChainName,
    destinationChainId,
    transactions: transactionsToExecute.map(({ chainName, amount }) => ({
      chainName,
      amount,
    })),
  });

  // Only execute if --sendTx is explicitly set
  if (!sendTransactions) {
    const calldataList: Array<{ chainName: string; chainId: number; calldata: string }> = [];
    transactionsToExecute.forEach(({ chainId, chainName }) => {
      const txns = multicallerClient.getQueuedTransactions(chainId);
      txns.forEach((txn) => {
        const calldata = txn.contract.interface.encodeFunctionData(txn.method, txn.args);
        calldataList.push({ chainName, chainId, calldata });
      });
    });
    logger.info({
      at: "RefillUsdcToSpecificChain#run",
      message: "📋 Transaction Calldata (dry run)",
      calldataList,
    });
    logger.info({
      at: "RefillUsdcToSpecificChain#run",
      message: "💡 To execute transactions, set SEND_TRANSACTIONS=true in your environment variables",
      example: "SEND_TRANSACTIONS=true yarn ts-node ./scripts/refillUsdcToSpecificChain.ts --wallet gckms --keys bot1",
    });
    return;
  }

  // Execute all transactions
  logger.info({
    at: "RefillUsdcToSpecificChain#run",
    message: "Executing bridge transactions",
    transactionCount: transactionsToExecute.length,
  });
  const chainIdsToExecute = transactionsToExecute.map(({ chainId }) => chainId);
  const txnReceipts = await multicallerClient.executeTxnQueues(false, chainIdsToExecute);

  const transactionResults = transactionsToExecute.map(({ chainId, chainName, amount }) => {
    const hashes = txnReceipts[chainId] || [];
    return {
      chainName,
      chainId,
      amount,
      transactionHashes: hashes,
      explorerLink: hashes.length > 0 ? blockExplorerLink(hashes[0], chainId) : undefined,
    };
  });

  logger.info({
    at: "RefillUsdcToSpecificChain#run",
    message: "✅ Bridge transactions submitted",
    transactions: transactionResults,
  });

  logger.info({
    at: "RefillUsdcToSpecificChain#run",
    message: "⏳ The bridges will be finalized by the finalizer bot",
    destinationChain: destinationChainName,
    destinationChainId,
  });
}

if (require.main === module) {
  logger = Logger;
  run()
    .then(async () => {
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    })
    .catch(async (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error({
        at: "RefillUsdcToSpecificChain",
        message: "❌ Process exited with error",
        error: errorMessage,
        stack: errorStack,
      });
      // eslint-disable-next-line no-process-exit
      process.exit(1);
    });
}
