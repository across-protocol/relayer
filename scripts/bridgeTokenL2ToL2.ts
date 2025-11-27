import winston from "winston";
import minimist from "minimist";
import {
  retrieveSignerFromCLIArgs,
  getProvider,
  parseUnits,
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
import { UsdcCCTPBridge } from "../src/adapter/l2Bridges/UsdcCCTPBridge";
import { MultiCallerClient } from "../src/clients";
import { askYesNoQuestion } from "./utils";

const args = minimist(process.argv.slice(2), {
  string: ["amount", "srcChainId", "dstChainId", "token"],
  boolean: ["sendTx"],
});

// Example run:
// ts-node ./scripts/bridgeTokenL2ToL2.ts --token USDC --srcChainId 8453 --dstChainId 42161 --amount 3  # Shows calldata, doesn't execute
// ts-node ./scripts/bridgeTokenL2ToL2.ts --token USDC --srcChainId 8453 --dstChainId 42161 --amount 5 --sendTx --wallet gckms --keys bot1  # Actually sends transaction

const MAINNET_CHAIN_ID = CHAIN_IDs.MAINNET;

// Supported tokens
const SUPPORTED_TOKENS = ["USDC", "USDT"] as const;
type SupportedToken = (typeof SUPPORTED_TOKENS)[number];

async function run(): Promise<void> {
  // Validate arguments
  if (!args.token) {
    throw new Error(
      `Define \`token\` as the token symbol to bridge (e.g., --token USDC or --token USDT). Supported tokens: ${SUPPORTED_TOKENS.join(
        ", "
      )}`
    );
  }

  const tokenSymbol = args.token.toUpperCase() as SupportedToken;
  if (!SUPPORTED_TOKENS.includes(tokenSymbol)) {
    throw new Error(`Unsupported token: ${tokenSymbol}. Supported tokens: ${SUPPORTED_TOKENS.join(", ")}`);
  }

  if (!args.srcChainId) {
    throw new Error(
      "Define `srcChainId` as the source L2 chain ID (e.g., --srcChainId 8453 for Base, --srcChainId 42161 for Arbitrum)"
    );
  }
  if (!args.dstChainId) {
    throw new Error(
      "Define `dstChainId` as the destination L2 chain ID (e.g., --dstChainId 42161 for Arbitrum, --dstChainId 8453 for Base)"
    );
  }
  if (!args.amount) {
    throw new Error(
      `Define \`amount\` as the amount of ${tokenSymbol} to bridge (e.g., --amount 3 for 3 ${tokenSymbol})`
    );
  }

  const srcChainId = Number(args.srcChainId);
  const dstChainId = Number(args.dstChainId);
  if (isNaN(srcChainId) || srcChainId <= 0) {
    throw new Error("srcChainId must be a positive number");
  }
  if (isNaN(dstChainId) || dstChainId <= 0) {
    throw new Error("dstChainId must be a positive number");
  }
  if (srcChainId === MAINNET_CHAIN_ID || dstChainId === MAINNET_CHAIN_ID) {
    throw new Error("Both srcChainId and dstChainId must be L2 chains, not Mainnet (1)");
  }
  if (srcChainId === dstChainId) {
    throw new Error("Source and destination chain IDs must be different");
  }

  const bridgeAmount = parseFloat(args.amount);
  if (isNaN(bridgeAmount) || bridgeAmount <= 0) {
    throw new Error("Amount must be a positive number");
  }

  // Default to not executing. Only execute if --sendTx is explicitly set
  const sendTransactions = args.sendTx === true;

  const srcChainName = getNetworkName(srcChainId);
  const dstChainName = getNetworkName(dstChainId);
  console.log(
    `🚀 Bridging ${tokenSymbol} from ${srcChainName} (Chain ID: ${srcChainId}) to ${dstChainName} (Chain ID: ${dstChainId})`
  );

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

  // Get signers for both L2 chains
  const srcL2Signer = baseSigner.connect(await getProvider(srcChainId));
  const dstL2Signer = baseSigner.connect(await getProvider(dstChainId));
  const mainnetSigner = baseSigner.connect(await getProvider(MAINNET_CHAIN_ID));

  // Get token addresses
  const tokenInfo = TOKEN_SYMBOLS_MAP[tokenSymbol];
  if (!tokenInfo) {
    throw new Error(`Token ${tokenSymbol} not found in TOKEN_SYMBOLS_MAP`);
  }

  const l1TokenAddress = tokenInfo.addresses[MAINNET_CHAIN_ID];
  if (!l1TokenAddress) {
    throw new Error(`${tokenSymbol} not found on Mainnet`);
  }

  const l1Token = EvmAddress.from(l1TokenAddress);
  const srcL2Token = getRemoteTokenForL1Token(l1Token, srcChainId, MAINNET_CHAIN_ID);
  const dstL2Token = getRemoteTokenForL1Token(l1Token, dstChainId, MAINNET_CHAIN_ID);
  if (!isDefined(srcL2Token)) {
    throw new Error(`${tokenSymbol} not found on ${srcChainName} (chain ID: ${srcChainId})`);
  }
  if (!isDefined(dstL2Token)) {
    throw new Error(`${tokenSymbol} not found on ${dstChainName} (chain ID: ${dstChainId})`);
  }

  const srcL2TokenInfo = getTokenInfo(srcL2Token, srcChainId);

  // Convert amount to token decimals
  const amountInWei = parseUnits(bridgeAmount.toString(), srcL2TokenInfo.decimals);
  const formatter = createFormatFunction(2, 4, false, srcL2TokenInfo.decimals);

  // Check balance on source L2
  const srcTokenContract = new Contract(srcL2Token.toNative(), ERC20.abi, srcL2Signer);
  const balance = await srcTokenContract.balanceOf(signerAddr);
  const balanceFormatted = formatter(balance.toString());

  console.log(`\n📊 Current ${tokenSymbol} balance on ${srcChainName}: ${balanceFormatted} ${tokenSymbol}`);
  console.log(`💸 Amount to bridge: ${formatter(amountInWei.toString())} ${tokenSymbol}`);

  if (balance.lt(amountInWei)) {
    throw new Error(
      `Insufficient balance! You have ${balanceFormatted} ${tokenSymbol} on ${srcChainName}, but trying to bridge ${formatter(
        amountInWei.toString()
      )} ${tokenSymbol}`
    );
  }

  // For L2->L2 transfers, we currently only support USDC via CCTP
  if (tokenSymbol !== "USDC") {
    throw new Error(
      `L2->L2 transfers are currently only supported for USDC via CCTP. ${tokenSymbol} is not supported.`
    );
  }

  // Check if both chains have CCTP domain IDs
  logger.info(`Checking CCTP support for ${srcChainName} and ${dstChainName}...`);
  const srcCctpDomain = getCctpDomainForChainId(srcChainId);
  const dstCctpDomain = getCctpDomainForChainId(dstChainId);

  if (srcCctpDomain === CCTP_NO_DOMAIN) {
    throw new Error(
      `Source chain ${srcChainName} (chain ID: ${srcChainId}) does not have CCTP support. CCTP domain ID not found.`
    );
  }

  if (dstCctpDomain === CCTP_NO_DOMAIN) {
    throw new Error(
      `Destination chain ${dstChainName} (chain ID: ${dstChainId}) does not have CCTP support. CCTP domain ID not found.`
    );
  }

  // Initialize UsdcCCTPBridge directly for L2->L2 transfers
  logger.info("Initializing UsdcCCTPBridge for L2->L2 transfer...");
  const l2Bridge = new UsdcCCTPBridge(
    srcChainId,
    MAINNET_CHAIN_ID,
    srcL2Signer,
    mainnetSigner,
    l1Token,
    dstChainId,
    dstL2Signer
  );

  // Construct L2->L2 bridge transaction
  logger.info("Constructing L2->L2 bridge transaction...");
  const toAddress = EvmAddress.from(signerAddr);
  const txns = await (l2Bridge as any).constructL2ToL2Txn(toAddress, srcL2Token, dstL2Token, amountInWei);

  // Confirm transaction
  console.log("\n📍 Bridge Details:");
  console.log(`   From: ${srcChainName} (Chain ID: ${srcChainId})`);
  console.log(`   To: ${dstChainName} (Chain ID: ${dstChainId})`);
  console.log(`   Token: ${tokenSymbol}`);
  console.log(`   Amount: ${formatter(amountInWei.toString())} ${tokenSymbol}`);
  console.log(`   Recipient: ${signerAddr}`);
  console.log("   Bridge: UsdcCCTPBridge");

  // Only execute if --sendTx is explicitly set
  if (!sendTransactions) {
    console.log(`\n📋 Transaction Calldata (${txns.length} transaction(s)):`);
    txns.forEach((txn, index) => {
      const calldata = txn.contract.interface.encodeFunctionData(txn.method, txn.args);
      console.log(`\n   Transaction ${index + 1}:`);
      console.log(`   ${calldata}`);
    });
    console.log("\n💡 To execute transactions, run with --sendTx flag");
    console.log(
      `   Example: yarn ts-node ./scripts/bridgeTokenL2ToL2.ts --token ${tokenSymbol} --srcChainId ${srcChainId} --dstChainId ${dstChainId} --amount ${bridgeAmount} --sendTx --wallet gckms --keys bot1`
    );
    return;
  }

  // Confirm before sending
  if (!(await askYesNoQuestion("\n⚠️  Confirm that you want to execute this L2->L2 bridge?"))) {
    console.log("Transaction cancelled.");
    return;
  }

  // Execute bridge transaction
  logger.info("Executing L2->L2 bridge transaction...");
  const multicallerClient = new MultiCallerClient(logger);
  txns.forEach((txn) => multicallerClient.enqueueTransaction(txn));
  const txnReceipts = await multicallerClient.executeTxnQueues(false, [srcChainId]);
  const transactionHashes = txnReceipts[srcChainId] || [];

  console.log("\n✅ Bridge transaction submitted!");
  console.log(`Transaction hash(es): ${transactionHashes.join(", ")}`);
  if (transactionHashes.length > 0) {
    console.log(`\n🔗 Monitor on ${srcChainName}: ${blockExplorerLink(transactionHashes[0], srcChainId)}`);
  }
  console.log(`\n⏳ The bridge will be finalized on ${dstChainName} by the finalizer bot.`);
  console.log("   You can monitor the finalization on the destination chain once the bridge message is processed.");
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
