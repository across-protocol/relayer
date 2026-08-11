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
} from "../src/utils";
import { CUSTOM_L2_BRIDGE, CANONICAL_L2_BRIDGE } from "../src/common/Constants";
import { MultiCallerClient, isAugmentedTransaction } from "../src/clients";
import { askYesNoQuestion } from "./utils";

const args = minimist(process.argv.slice(2), {
  string: ["amount", "chainId", "token"],
  boolean: ["sendTx"],
});

// Example run:
// tsx ./scripts/withdrawTokenFromL2.ts --token USDC --chainId 143 --amount 3  # Shows calldata, doesn't execute
// tsx ./scripts/withdrawTokenFromL2.ts --token USDT --chainId 8453 --amount 5 --sendTx  # Actually sends transaction
// tsx ./scripts/withdrawTokenFromL2.ts --token USDC --chainId 137 --amount 2
// tsx ./scripts/withdrawTokenFromL2.ts --token WGHO --chainId 232 --amount 1 --sendTx --wallet secret

const MAINNET_CHAIN_ID = CHAIN_IDs.MAINNET;

// Supported tokens
const SUPPORTED_TOKENS = ["USDC", "USDT", "WETH", "WGHO"] as const;
type SupportedToken = (typeof SUPPORTED_TOKENS)[number];

async function run(): Promise<void> {
  // Validate arguments
  if (!args.token) {
    throw new Error(
      `Define \`token\` as the token symbol to withdraw (e.g., --token USDC or --token USDT). Supported tokens: ${SUPPORTED_TOKENS.join(
        ", "
      )}`
    );
  }

  const tokenSymbol = args.token.toUpperCase() as SupportedToken;
  if (!SUPPORTED_TOKENS.includes(tokenSymbol)) {
    throw new Error(`Unsupported token: ${tokenSymbol}. Supported tokens: ${SUPPORTED_TOKENS.join(", ")}`);
  }

  if (!args.chainId) {
    throw new Error(
      "Define `chainId` as the source L2 chain ID (e.g., --chainId 143 for Monad, --chainId 8453 for Base)"
    );
  }
  if (!args.amount) {
    throw new Error(
      `Define \`amount\` as the amount of ${tokenSymbol} to withdraw (e.g., --amount 3 for 3 ${tokenSymbol})`
    );
  }

  const l2ChainId = Number(args.chainId);
  if (isNaN(l2ChainId) || l2ChainId <= 0) {
    throw new Error("chainId must be a positive number");
  }
  if (l2ChainId === MAINNET_CHAIN_ID) {
    throw new Error("chainId must be an L2 chain, not Mainnet (1)");
  }

  const withdrawAmount = parseFloat(args.amount);
  if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
    throw new Error("Amount must be a positive number");
  }

  // Default to not executing. Only execute if --sendTx is explicitly set
  const sendTransactions = args.sendTx === true;

  const l2ChainName = getNetworkName(l2ChainId);
  console.log(`🚀 Withdrawing ${tokenSymbol} from ${l2ChainName} (Chain ID: ${l2ChainId}) to Mainnet`);

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

  // Get signers for both chains
  const l2Signer = baseSigner.connect(await getProvider(l2ChainId));
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
  const l2Token = getRemoteTokenForL1Token(l1Token, l2ChainId, MAINNET_CHAIN_ID);
  if (!isDefined(l2Token)) {
    throw new Error(`${tokenSymbol} not found on ${l2ChainName} (chain ID: ${l2ChainId})`);
  }

  const l2TokenInfo = getTokenInfo(l2Token, l2ChainId);

  // Convert amount to token decimals
  const amountInWei = parseUnits(withdrawAmount.toString(), l2TokenInfo.decimals);
  const formatter = createFormatFunction(2, 4, false, l2TokenInfo.decimals);

  // Check balance on L2
  const tokenContract = new Contract(l2Token.toNative(), ERC20.abi, l2Signer);
  const balance = await tokenContract.balanceOf(signerAddr);
  const balanceFormatted = formatter(balance.toString());

  console.log(`\n📊 Current ${tokenSymbol} balance on ${l2ChainName}: ${balanceFormatted} ${tokenSymbol}`);
  console.log(`💸 Amount to withdraw: ${formatter(amountInWei.toString())} ${tokenSymbol}`);

  if (balance.lt(amountInWei)) {
    throw new Error(
      `Insufficient balance! You have ${balanceFormatted} ${tokenSymbol} on ${l2ChainName}, but trying to withdraw ${formatter(
        amountInWei.toString()
      )} ${tokenSymbol}`
    );
  }

  // Determine which L2 bridge to use
  logger.info(`Determining L2 bridge for ${tokenSymbol} on ${l2ChainName}...`);
  const BridgeConstructor = CUSTOM_L2_BRIDGE[l2ChainId]?.[l1Token.toNative()] ?? CANONICAL_L2_BRIDGE[l2ChainId];
  if (!isDefined(BridgeConstructor)) {
    throw new Error(
      `No L2 bridge configured for ${tokenSymbol} on ${l2ChainName} (chain ID: ${l2ChainId}). Check CUSTOM_L2_BRIDGE and CANONICAL_L2_BRIDGE in Constants.ts`
    );
  }

  // Initialize L2 bridge adapter
  logger.info(`Initializing ${BridgeConstructor.name}...`);
  const l2Bridge = new BridgeConstructor(l2ChainId, MAINNET_CHAIN_ID, l2Signer, mainnetSigner, l1Token, logger);

  // Construct withdrawal transaction
  logger.info("Constructing withdrawal transaction...");
  const toAddress = EvmAddress.from(signerAddr);
  const txns = await l2Bridge.constructWithdrawToL1Txns(toAddress, l2Token, l1Token, amountInWei);
  if (txns.length === 0) {
    // Bridges skip withdrawals they deem non-viable right now (e.g. OFT paths with insufficient or
    // dust-sized quoted capacity) by returning no transactions; the bot retries on a later run, but
    // this one-shot script must fail loudly instead.
    throw new Error(
      `${BridgeConstructor.name} produced no withdrawal transactions for this amount — the bridge is ` +
        "skipping the withdrawal, typically because its quoted capacity is currently insufficient. " +
        "Retry later or with a different amount."
    );
  }

  // Bridges that pull tokens via transferFrom (e.g. the ZK Stack native token vault and the standalone
  // ZK Stack USDC bridge) need an allowance. The bot grants these elsewhere; this one-shot script grants
  // the exact withdrawal amount itself.
  const approvals: { erc20: Contract; spender: string }[] = [];
  for (const { token, bridge } of l2Bridge.requiredTokenApprovals()) {
    const erc20 = new Contract(token.toNative(), ERC20.abi, l2Signer);
    const allowance = await erc20.allowance(signerAddr, bridge.toNative());
    if (allowance.lt(amountInWei)) {
      approvals.push({ erc20, spender: bridge.toNative() });
    }
  }

  // Confirm transaction
  console.log("\n📍 Withdrawal Details:");
  console.log(`   From: ${l2ChainName} (Chain ID: ${l2ChainId})`);
  console.log(`   To: Mainnet (Chain ID: ${MAINNET_CHAIN_ID})`);
  console.log(`   Token: ${tokenSymbol}`);
  console.log(`   Amount: ${formatter(amountInWei.toString())} ${tokenSymbol}`);
  console.log(`   Recipient: ${signerAddr}`);
  console.log(`   Bridge: ${BridgeConstructor.name}`);
  approvals.forEach(({ erc20, spender }) =>
    console.log(`   Approval to send first: ${erc20.address} allowance for ${spender}`)
  );

  // Only execute if --sendTx is explicitly set
  if (!sendTransactions) {
    console.log(`\n📋 Transaction Calldata (${txns.length} transaction(s)):`);
    txns.filter(isAugmentedTransaction).forEach((txn, index) => {
      const calldata = txn.contract.interface.encodeFunctionData(txn.method, txn.args);
      console.log(`\n   Transaction ${index + 1}:`);
      console.log(`   ${calldata}`);
    });
    console.log("\n💡 To execute transactions, run with --sendTx flag");
    console.log(
      `   Example: yarn tsx ./scripts/withdrawTokenFromL2.ts --token ${tokenSymbol} --chainId ${l2ChainId} --amount ${withdrawAmount} --sendTx --wallet gckms --keys bot1`
    );
    return;
  }

  // Confirm before sending
  if (!(await askYesNoQuestion("\n⚠️  Confirm that you want to execute this withdrawal?"))) {
    console.log("Transaction cancelled.");
    return;
  }

  // The withdrawal spends the allowance, so each approval must be confirmed before it is submitted.
  for (const { erc20, spender } of approvals) {
    logger.info(`Approving ${spender} to spend ${formatter(amountInWei.toString())} ${tokenSymbol}...`);
    const txn = await erc20.approve(spender, amountInWei);
    await txn.wait();
    console.log(`Approval confirmed: ${blockExplorerLink(txn.hash, l2ChainId)}`);
  }

  // Execute withdrawal
  logger.info("Executing withdrawal...");
  const multicallerClient = new MultiCallerClient(logger);
  txns.filter(isAugmentedTransaction).forEach((txn) => multicallerClient.enqueueTransaction(txn));
  const txnReceipts = await multicallerClient.executeTxnQueues(false, [l2ChainId]);
  const transactionHashes = txnReceipts[l2ChainId] || [];

  console.log("\n✅ Withdrawal transaction submitted!");
  console.log(`Transaction hash(es): ${transactionHashes.join(", ")}`);
  if (transactionHashes.length > 0) {
    console.log(`\n🔗 Monitor on ${l2ChainName}: ${blockExplorerLink(transactionHashes[0], l2ChainId)}`);
  }
  console.log("\n⏳ The withdrawal will be finalized on Mainnet by the finalizer bot.");
  console.log("   You can monitor the finalization on Mainnet once the bridge message is processed.");
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
