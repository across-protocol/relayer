import winston from "winston";
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
  console.log(
    `🚀 Checking USDC balances on ${sourceChainIds.length} chain(s) and bridging to ${destinationChainName} (Chain ID: ${destinationChainId})`
  );
  console.log(`📊 Minimum balance threshold: ${MIN_BALANCE_THRESHOLD_USDC} USDC`);
  console.log("⚙️  Configuration:");
  console.log(`   Source chains: ${sourceChainIds.join(", ")}`);
  console.log(`   Destination chain: ${destinationChainName} (${destinationChainId})`);
  console.log(`   Send transactions: ${sendTransactions ? "Yes" : "No (dry run)"}`);
  console.log(`   Balance threshold: ${MIN_BALANCE_THRESHOLD_USDC} USDC`);

  // Initialize logger
  const logger = winston.createLogger({
    level: "info",
    format: winston.format.json(),
    transports: [new winston.transports.Console({ format: winston.format.simple() })],
  });

  // Get signer
  const baseSigner = await retrieveSignerFromCLIArgs();
  const signerAddr = await baseSigner.getAddress();
  console.log(`Connected to account: ${signerAddr}`);

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

  console.log("\n📊 Checking balances on source chains...\n");

  for (const sourceChainId of sourceChainIds) {
    const sourceChainName = getNetworkName(sourceChainId);

    // Validate source chain has CCTP support
    const srcCctpDomain = getCctpDomainForChainId(sourceChainId);
    if (srcCctpDomain === CCTP_NO_DOMAIN) {
      console.log(`⚠️  Skipping ${sourceChainName} (chain ID: ${sourceChainId}): No CCTP support`);
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
          console.log(`⚠️  Skipping ${sourceChainName} (chain ID: ${sourceChainId}): USDC not found on this chain`);
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

      console.log(`${sourceChainName} (${sourceChainId}): ${balanceFormatted} USDC`);

      // Check if balance exceeds threshold
      if (balanceInUsdc >= MIN_BALANCE_THRESHOLD_USDC) {
        console.log(`  ✓ Balance (${balanceFormatted} USDC) exceeds threshold (${MIN_BALANCE_THRESHOLD_USDC} USDC)`);

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

        console.log(`  → Queued transaction to bridge ${balanceFormatted} USDC to ${destinationChainName}`);
      } else {
        console.log(
          `  ✗ Balance (${balanceFormatted} USDC) below threshold (${MIN_BALANCE_THRESHOLD_USDC} USDC) - skipping`
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Error processing ${sourceChainName} (chain ID: ${sourceChainId}):`, errorMessage);
      // Continue with other chains
    }
  }

  if (transactionsToExecute.length === 0) {
    console.log("\n✅ No transactions to execute. All balances are below the threshold.");
    return;
  }

  // Summary
  console.log("\n📍 Transaction Summary:");
  console.log(`   Total transactions: ${transactionsToExecute.length}`);
  console.log(`   Destination: ${destinationChainName} (Chain ID: ${destinationChainId})`);
  transactionsToExecute.forEach(({ chainName, amount }) => {
    console.log(`   - ${chainName}: ${amount} USDC`);
  });

  // Only execute if --sendTx is explicitly set
  if (!sendTransactions) {
    console.log("\n📋 Transaction Calldata:");
    transactionsToExecute.forEach(({ chainId, chainName }, index) => {
      const txns = multicallerClient.getQueuedTransactions(chainId);
      txns.forEach((txn, txnIndex) => {
        const calldata = txn.contract.interface.encodeFunctionData(txn.method, txn.args);
        console.log(`\n   Transaction ${index + 1}.${txnIndex + 1} (${chainName}):`);
        console.log(`   ${calldata}`);
      });
    });
    console.log("\n💡 To execute transactions, set SEND_TRANSACTIONS=true in your environment variables");
    console.log(
      "   Example: SEND_TRANSACTIONS=true yarn ts-node ./scripts/refillUsdcToSpecificChain.ts --wallet gckms --keys bot1"
    );
    return;
  }

  // Execute all transactions
  logger.info("Executing bridge transactions...");
  const chainIdsToExecute = transactionsToExecute.map(({ chainId }) => chainId);
  const txnReceipts = await multicallerClient.executeTxnQueues(false, chainIdsToExecute);

  console.log("\n✅ Bridge transactions submitted!");
  transactionsToExecute.forEach(({ chainId, chainName, amount }) => {
    const hashes = txnReceipts[chainId] || [];
    if (hashes.length > 0) {
      console.log(`\n${chainName} (${chainId}):`);
      console.log(`   Amount: ${amount} USDC`);
      console.log(`   Transaction hash(es): ${hashes.join(", ")}`);
      console.log(`   🔗 Monitor: ${blockExplorerLink(hashes[0], chainId)}`);
    }
  });

  console.log(`\n⏳ The bridges will be finalized on ${destinationChainName} by the finalizer bot.`);
  console.log("   You can monitor the finalization on the destination chain once the bridge messages are processed.");
}

if (require.main === module) {
  run()
    .then(async () => {
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("❌ Process exited with error:", error.message);
      if (error.stack) {
        console.error(error.stack);
      }
      // eslint-disable-next-line no-process-exit
      process.exit(1);
    });
}
