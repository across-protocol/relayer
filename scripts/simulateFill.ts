import assert from "assert";
import axios from "axios";
import minimist from "minimist";
import { config } from "dotenv";
import { Contract, ethers } from "ethers";
import { LogDescription } from "@ethersproject/abi";
import { CHAIN_IDs } from "@across-protocol/constants";
import { RelayData } from "../src/interfaces";
import {
  BigNumber,
  Address,
  disconnectRedisClients,
  EvmAddress,
  getNetworkName,
  getProvider,
  getSigner,
  isDefined,
  populateV3Relay,
  toAddressType,
  chainIsEvm,
  getBlockForTimestamp,
  winston,
} from "../src/utils";
import * as utils from "./utils";

type Log = ethers.providers.Log;

const { NODE_SUCCESS, NODE_INPUT_ERR, NODE_APP_ERR } = utils;
const DEPOSIT_EVENT = "FundsDeposited";

// Default relayer address for Tenderly simulations
const DEFAULT_RELAYER_ADDRESS = "0x07aE8551Be970cB1cCa11Dd7a11F47Ae82e70E67";

// Average block times for all chains in seconds
const AVERAGE_BLOCK_TIMES: { [chainId: number]: number } = {
  [CHAIN_IDs.MAINNET]: 12,
  [CHAIN_IDs.ARBITRUM]: 0.25,
  [CHAIN_IDs.BASE]: 2,
  [CHAIN_IDs.BLAST]: 2,
  [CHAIN_IDs.BSC]: 3,
  [CHAIN_IDs.HYPEREVM]: 60,
  [CHAIN_IDs.INK]: 1,
  [CHAIN_IDs.LENS]: 1,
  [CHAIN_IDs.LINEA]: 3,
  [CHAIN_IDs.LISK]: 2,
  [CHAIN_IDs.MODE]: 2,
  [CHAIN_IDs.MONAD]: 0.4,
  [CHAIN_IDs.OPTIMISM]: 2,
  [CHAIN_IDs.PLASMA]: 1,
  [CHAIN_IDs.POLYGON]: 2,
  [CHAIN_IDs.REDSTONE]: 2,
  [CHAIN_IDs.SCROLL]: 3,
  [CHAIN_IDs.SOLANA]: 0.4,
  [CHAIN_IDs.SONEIUM]: 2,
  [CHAIN_IDs.UNICHAIN]: 1,
  [CHAIN_IDs.WORLD_CHAIN]: 2,
  [CHAIN_IDs.ZK_SYNC]: 1,
  [CHAIN_IDs.ZORA]: 2,
  // Testnets
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: 0.25,
  [CHAIN_IDs.BASE_SEPOLIA]: 2,
  [CHAIN_IDs.BLAST_SEPOLIA]: 2,
  [CHAIN_IDs.INK_SEPOLIA]: 1,
  [CHAIN_IDs.HYPEREVM_TESTNET]: 60,
  [CHAIN_IDs.LENS_SEPOLIA]: 1,
  [CHAIN_IDs.LISK_SEPOLIA]: 2,
  [CHAIN_IDs.MODE_SEPOLIA]: 2,
  [CHAIN_IDs.MONAD_TESTNET]: 0.4,
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: 2,
  [CHAIN_IDs.PLASMA_TESTNET]: 1,
  [CHAIN_IDs.POLYGON_AMOY]: 2,
  [CHAIN_IDs.SEPOLIA]: 12,
  [CHAIN_IDs.UNICHAIN_SEPOLIA]: 1,
};

function decodeRelayData(originChainId: number, destinationChainId: number, log: LogDescription): RelayData {
  const eventArgs = Object.keys(log.args).filter((key) => isNaN(Number(key)));
  const relayData = Object.fromEntries(
    eventArgs.map((key) => {
      switch (key) {
        case "depositor":
        case "inputToken":
          return [key, toAddressType(log.args[key], originChainId)];

        case "recipient":
        case "outputToken":
        case "exclusiveRelayer":
          return [key, toAddressType(log.args[key], destinationChainId)];

        default:
          return [key, log.args[key]];
      }
    })
  ) as RelayData;

  return relayData;
}

async function fetchDepositFromTxn(
  originChainId: number,
  txnHash: string
): Promise<{ deposit: any; destinationChainId: number; depositBlockNumber: number; depositTimestamp: number }> {
  if (!utils.validateChainIds([originChainId])) {
    throw new Error(`Invalid origin chain ID (${originChainId}).`);
  }

  if (txnHash === undefined || typeof txnHash !== "string" || txnHash.length != 66 || !txnHash.startsWith("0x")) {
    throw new Error(`Missing or malformed transaction hash: ${txnHash}`);
  }

  const originProvider = await getProvider(originChainId);
  const originSpokePool = await utils.getSpokePoolContract(originChainId);

  const txn = await originProvider.getTransactionReceipt(txnHash);

  const fundsDeposited = originSpokePool.interface.getEventTopic(DEPOSIT_EVENT);
  const depositLogs = txn.logs
    .filter(({ topics, address }) => topics[0] === fundsDeposited && address === originSpokePool.address)
    .map((log) => originSpokePool.interface.parseLog(log));

  if (depositLogs.length === 0) {
    throw new Error("No deposits found in txn");
  }

  if (depositLogs.length > 1) {
    throw new Error(`Multiple deposits in transaction (${depositLogs.length}). Please specify --depositId`);
  }

  const [{ args: depositArgs }] = depositLogs;
  const destinationChainId = Number(depositArgs.destinationChainId.toString());

  const relayData = decodeRelayData(originChainId, destinationChainId, depositLogs[0]);

  // Get the deposit block timestamp
  const depositBlock = await originProvider.getBlock(txn.blockNumber);
  const depositTimestamp = depositBlock.timestamp;

  // Construct complete deposit object with all required fields for populateV3Relay
  const deposit = {
    depositId: depositArgs.depositId,
    originChainId,
    destinationChainId,
    ...relayData,
  };

  return { deposit, destinationChainId, depositBlockNumber: txn.blockNumber, depositTimestamp };
}

async function createTenderlySimulation(
  chainId: number,
  fillTxData: string,
  spokePoolAddress: string,
  relayerAddress: string,
  blockNumber: number
): Promise<string> {
  const tenderlyAccessKey = process.env.TENDERLY_ACCESS_KEY;
  const tenderlyUser = process.env.TENDERLY_USER;
  const tenderlyProject = process.env.TENDERLY_PROJECT;

  if (!tenderlyAccessKey || !tenderlyUser || !tenderlyProject) {
    throw new Error(
      "Missing Tenderly configuration. Please set TENDERLY_ACCESS_KEY, TENDERLY_USER, and TENDERLY_PROJECT in your .env file"
    );
  }

  const tenderlyUrl = `https://api.tenderly.co/api/v1/account/${tenderlyUser}/project/${tenderlyProject}/simulate`;

  const simulationPayload = {
    network_id: chainId.toString(),
    block_number: blockNumber,
    from: relayerAddress,
    to: spokePoolAddress,
    input: fillTxData,
    save: true,
    save_if_fails: true,
    public: true, // Make simulation publicly accessible
  };

  try {
    const response = await axios.post(tenderlyUrl, simulationPayload, {
      headers: {
        "X-Access-Key": tenderlyAccessKey,
        "Content-Type": "application/json",
      },
    });

    const simulationId = response.data.simulation.id;

    console.log(`\nDebug: Simulation created with ID: ${simulationId}`);

    // Enable sharing by calling the share endpoint
    const shareUrl = `https://api.tenderly.co/api/v1/account/${tenderlyUser}/project/${tenderlyProject}/simulations/${simulationId}/share`;

    try {
      await axios.post(
        shareUrl,
        {}, // Empty body
        {
          headers: {
            "X-Access-Key": tenderlyAccessKey,
            "Content-Type": "application/json",
          },
        }
      );

      console.log(`Debug: Share enabled for simulation`);

      // Once sharing is enabled, construct the public share URL
      const publicShareUrl = `https://www.tdly.co/shared/simulation/${simulationId}`;
      console.log(`Debug: Using public share URL: ${publicShareUrl}`);

      return publicShareUrl;
    } catch (shareError) {
      // If share endpoint fails, fall back to the regular dashboard URL
      console.warn("Could not enable sharing, using dashboard URL instead");
      if (axios.isAxiosError(shareError)) {
        console.warn("Share endpoint error:", shareError.response?.status, shareError.response?.data);
      }
    }

    // Fallback to dashboard URL
    return `https://dashboard.tenderly.co/${tenderlyUser}/${tenderlyProject}/simulator/${simulationId}`;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(
        `Tenderly simulation failed: ${error.response?.status} - ${JSON.stringify(error.response?.data)}`
      );
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function getBlockNumberForTimestamp(
  destinationChainId: number,
  targetTimestamp: number
): Promise<number> {
  const logger = winston.createLogger({
    level: "error", // Only show errors to keep output clean
    transports: [new winston.transports.Console()],
  });

  try {
    // Use the built-in block finder utility to find the block closest to the target timestamp
    const blockNumber = await getBlockForTimestamp(logger, destinationChainId, targetTimestamp);
    return blockNumber;
  } catch (error) {
    // Fallback: if block finder fails, use block time approximation
    const blockTime = AVERAGE_BLOCK_TIMES[destinationChainId];
    if (!blockTime) {
      throw new Error(`Unknown block time for chain ${destinationChainId}`);
    }

    const destProvider = await getProvider(destinationChainId);
    const currentBlock = await destProvider.getBlock("latest");
    const currentTimestamp = currentBlock.timestamp;

    // If target is in the future, we can't simulate it (shouldn't happen for historical deposits)
    if (targetTimestamp > currentTimestamp) {
      console.warn(`Warning: Target timestamp ${targetTimestamp} is in the future. Using latest block.`);
      return currentBlock.number;
    }

    // Calculate approximate block number based on time difference
    const timeDiff = currentTimestamp - targetTimestamp;
    const blocksBack = Math.floor(timeDiff / blockTime);
    return Math.max(0, currentBlock.number - blocksBack);
  }
}

async function simulateFill(args: Record<string, number | string>): Promise<boolean> {
  const { txnHash } = args;
  const originChainId = Number(args.originChainId);

  console.log(`Fetching deposit from transaction ${txnHash} on ${getNetworkName(originChainId)}...`);

  const { deposit, destinationChainId, depositBlockNumber, depositTimestamp } = await fetchDepositFromTxn(
    originChainId,
    txnHash as string
  );

  console.log(`Found deposit #${deposit.depositId}`);
  console.log(`  Origin: ${getNetworkName(originChainId)} (${originChainId})`);
  console.log(`  Destination: ${getNetworkName(destinationChainId)} (${destinationChainId})`);
  console.log(`  Deposit Block: ${depositBlockNumber}`);
  console.log(`  Deposit Timestamp: ${depositTimestamp} (${new Date(depositTimestamp * 1000).toUTCString()})`);
  console.log(`  Input Token: ${deposit.inputToken.toNative()}`);
  console.log(`  Output Token: ${deposit.outputToken.toNative()}`);
  console.log(`  Input Amount: ${deposit.inputAmount.toString()}`);
  console.log(`  Output Amount: ${deposit.outputAmount.toString()}`);
  console.log(`  Recipient: ${deposit.recipient.toNative()}`);

  if (!chainIsEvm(destinationChainId)) {
    throw new Error(`Non-EVM destination chains are not yet supported (chain ${destinationChainId})`);
  }

  // Get relayer address - use provided address or default for Tenderly simulation
  const simulationRelayerAddress = (args.relayer as string) || DEFAULT_RELAYER_ADDRESS;

  // We still need a signer to construct the fill transaction, but we'll use a different address for simulation
  const signer = await getSigner({ keyType: "secret", cleanEnv: true });
  const relayer = EvmAddress.from(simulationRelayerAddress);

  console.log(`\nConstructing fill transaction for relayer ${simulationRelayerAddress}...`);

  // Get destination spoke pool
  const destSpokePool = await utils.getSpokePoolContract(destinationChainId);

  // Construct fill transaction
  const fillTx = await populateV3Relay(destSpokePool, deposit, relayer);

  console.log(`Fill transaction constructed:`);
  console.log(`  To: ${fillTx.to}`);
  console.log(`  Data: ${fillTx.data?.substring(0, 66)}...`);

  // Calculate target timestamp: configurable seconds after deposit (default 2)
  const targetSecondsAfterDeposit = args.delay ? Number(args.delay) : 2;

  // Validate delay parameter
  if (targetSecondsAfterDeposit < 0 || targetSecondsAfterDeposit > 3600) {
    throw new Error(`Invalid delay: ${targetSecondsAfterDeposit}. Must be between 0 and 3600 seconds (1 hour).`);
  }

  const targetTimestamp = depositTimestamp + targetSecondsAfterDeposit;

  console.log(`\nFinding destination chain block for timestamp ${targetTimestamp} (${targetSecondsAfterDeposit}s after deposit)...`);

  // Find the block on destination chain that corresponds to target timestamp
  const simulationBlock = await getBlockNumberForTimestamp(destinationChainId, targetTimestamp);

  console.log(`Simulation block on ${getNetworkName(destinationChainId)}: ${simulationBlock}`);

  // Verify the block timestamp to show how close we got
  const destProvider = await getProvider(destinationChainId);
  const simBlock = await destProvider.getBlock(simulationBlock);
  const timeDiff = simBlock.timestamp - depositTimestamp;
  console.log(`Simulation block timestamp: ${simBlock.timestamp} (${timeDiff}s after deposit)`);

  console.log(`\nCreating Tenderly simulation...`);

  const simulationUrl = await createTenderlySimulation(
    destinationChainId,
    fillTx.data as string,
    destSpokePool.address,
    simulationRelayerAddress,
    simulationBlock
  );

  console.log(`\n✓ Simulation created successfully!`);
  console.log(`\nTenderly Simulation URL:`);
  console.log(simulationUrl);

  return true;
}

function usage(badInput?: string): boolean {
  let usageStr = badInput ? `\nUnrecognized input: "${badInput}".\n\n` : "";
  usageStr += `
    Usage:
    \tyarn ts-node ./scripts/simulateFill.ts --originChainId <chainId> --txnHash <transactionHash> [options]

    Description:
    \tSimulates a fill transaction for a deposit on Tenderly. This is a backward-looking debugging tool
    \tto understand why a fill would have reverted.

    Required Arguments:
    \t--originChainId\t\tThe chain ID where the deposit transaction occurred
    \t--txnHash\t\tThe transaction hash of the deposit

    Optional Arguments:
    \t--relayer\t\tThe address to use as the sender in the Tenderly simulation
    \t\t\t\tDefault: ${DEFAULT_RELAYER_ADDRESS}
    \t--delay\t\t\tSeconds after deposit to simulate the fill (0-3600)
    \t\t\t\tDefault: 2

    Environment Variables (required):
    \tTENDERLY_ACCESS_KEY\tYour Tenderly API access key
    \tTENDERLY_USER\t\tYour Tenderly account username
    \tTENDERLY_PROJECT\tYour Tenderly project name

    Examples:
    \tyarn ts-node ./scripts/simulateFill.ts --originChainId 1 --txnHash 0x123...
    \tyarn ts-node ./scripts/simulateFill.ts --originChainId 1 --txnHash 0x123... --relayer 0xYourAddress
    \tyarn ts-node ./scripts/simulateFill.ts --originChainId 1 --txnHash 0x123... --delay 10
    \tyarn ts-node ./scripts/simulateFill.ts --originChainId 1 --txnHash 0x123... --delay 5 --relayer 0xYourAddress
  `.slice(1); // Skip leading newline
  console.log(usageStr);

  return !isDefined(badInput);
}

async function run(argv: string[]): Promise<number> {
  const opts = {
    string: ["originChainId", "txnHash", "relayer", "delay"],
    alias: {
      transactionHash: "txnHash",
    },
    unknown: usage,
  };
  const args = minimist(argv, opts);

  if (!args.originChainId || !args.txnHash) {
    return usage("Missing required arguments") ? NODE_SUCCESS : NODE_INPUT_ERR;
  }

  config();

  try {
    const result = await simulateFill(args);
    await disconnectRedisClients();
    return result ? NODE_SUCCESS : NODE_APP_ERR;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("\nError:", errorMessage);
    await disconnectRedisClients();
    return NODE_APP_ERR;
  }
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then(async (result) => {
      process.exitCode = result;
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      process.exitCode = NODE_APP_ERR;
    });
}
