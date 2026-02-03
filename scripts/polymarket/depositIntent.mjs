#!/usr/bin/env node
// Submits an Across v3 deposit with a Polymarket intent message.
//
// This is intended for mainnet testing. It sends real transactions.
//
// Usage (example: Base -> Polygon):
//   export PRIVATE_KEY=...
//   node scripts/polymarket/depositIntent.mjs \
//     --originChainId 8453 \
//     --originRpcUrl https://mainnet.base.org \
//     --spokePool 0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64 \
//     --inputToken 0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913 \
//     --inputAmount 10000000 \
//     --outputToken 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 \
//     --outputAmount 6000000 \
//     --handler 0xYourHandler \
//     --recipient 0xYourRecipient \
//     --solver 0xYourRelayerEoa \
//     --outcomeToken 0xYourErc1155 \
//     --tokenId 123 \
//     --outcomeAmount 10000000 \
//     --limitPrice 600000 \
//     --clientOrderId 0x...32bytes
//     --exclusiveRelayer 0xYourRelayerEoa \
//     --exclusivityDeadline 1710000000
//
// Notes:
// - Amounts are integer base units (USDC is 6 decimals).
// - outcomeAmount + limitPrice are both 1e6-scaled per SPEC.MD.
// - If --exclusiveRelayer is omitted, it defaults to --solver.
// - If --exclusivityDeadline is omitted and exclusive relayer is set, it defaults to fillDeadline.

import { Wallet, ethers } from "ethers";

function usage(msg) {
  if (msg) console.error(msg);
  console.error("See file header for usage.");
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) usage(`Unexpected arg: ${a}`);
    const k = a.slice(2);
    const v = argv[++i];
    if (!v) usage(`Missing value for --${k}`);
    args[k] = v;
  }
  return args;
}

const args = parseArgs(process.argv);

const required = [
  "originChainId",
  "originRpcUrl",
  "spokePool",
  "inputToken",
  "inputAmount",
  "outputToken",
  "outputAmount",
  "handler",
  "recipient",
  "solver",
  "outcomeToken",
  "tokenId",
  "outcomeAmount",
  "limitPrice",
  "clientOrderId",
];
for (const k of required) {
  if (!args[k]) usage(`Missing --${k}`);
}

const pk = process.env.PRIVATE_KEY;
if (!pk) usage("Missing PRIVATE_KEY env var.");

const provider = new ethers.providers.JsonRpcProvider(args.originRpcUrl);
const wallet = new Wallet(pk, provider);

const erc20Abi = [
  "function decimals() view returns (uint8)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
];
const spokePoolAbi = [
  "function fillDeadlineBuffer() view returns (uint32)",
  "function deposit(bytes32 depositor,bytes32 recipient,bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,bytes32 exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message)",
];

const inputToken = new ethers.Contract(args.inputToken, erc20Abi, wallet);
const spokePool = new ethers.Contract(args.spokePool, spokePoolAbi, wallet);

const now = Math.floor(Date.now() / 1000);
const fillDeadlineBuffer = Number(await spokePool.fillDeadlineBuffer());
const quoteTimestamp = now;
const fillDeadline = now + fillDeadlineBuffer;

const toBytes32 = (addr) => ethers.utils.hexZeroPad(addr, 32).toLowerCase();
const depositorB32 = toBytes32(wallet.address);
const recipientB32 = toBytes32(args.handler);
const inputTokenB32 = toBytes32(args.inputToken);
const outputTokenB32 = toBytes32(args.outputToken);
const exclusiveRelayer = args.exclusiveRelayer ?? args.solver;
const exclusiveRelayerB32 =
  exclusiveRelayer && exclusiveRelayer !== ethers.constants.AddressZero ? toBytes32(exclusiveRelayer) : ethers.constants.HashZero;
const exclusivityDeadline =
  args.exclusivityDeadline !== undefined
    ? Number(args.exclusivityDeadline)
    : exclusiveRelayerB32 === ethers.constants.HashZero
      ? 0
      : fillDeadline;

const POLYMARKET_INTENT_TUPLE =
  "tuple(uint8 version,address recipient,address solver,address outcomeToken,uint256 tokenId,uint256 outcomeAmount,uint256 limitPrice,bytes32 clientOrderId)";
const message = ethers.utils.defaultAbiCoder.encode(
  [POLYMARKET_INTENT_TUPLE],
  [
    {
      version: 1,
      recipient: args.recipient,
      solver: args.solver,
      outcomeToken: args.outcomeToken,
      tokenId: ethers.BigNumber.from(args.tokenId),
      outcomeAmount: ethers.BigNumber.from(args.outcomeAmount),
      limitPrice: ethers.BigNumber.from(args.limitPrice),
      clientOrderId: args.clientOrderId,
    },
  ]
);

const inputAmount = ethers.BigNumber.from(args.inputAmount);
const outputAmount = ethers.BigNumber.from(args.outputAmount);
const allowance = await inputToken.allowance(wallet.address, spokePool.address);
if (allowance.lt(inputAmount)) {
  const tx = await inputToken.approve(spokePool.address, inputAmount);
  console.log(`approve tx: ${tx.hash}`);
  await tx.wait();
}

const tx = await spokePool.deposit(
  depositorB32,
  recipientB32,
  inputTokenB32,
  outputTokenB32,
  inputAmount,
  outputAmount,
  137, // destinationChainId = Polygon for MVP
  exclusiveRelayerB32,
  quoteTimestamp,
  fillDeadline,
  exclusivityDeadline,
  message
);

console.log(`deposit tx: ${tx.hash}`);
await tx.wait();
console.log("deposit confirmed");
