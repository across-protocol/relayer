import minimist from "minimist";
import { readFileSync, writeFileSync } from "fs";
import { Event, providers as ethersProviders, utils as ethersUtils } from "ethers";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import {
  CHAIN_IDs,
  exit,
  getDeploymentBlockNumber,
  getNetworkName,
  getProvider,
  isDefined,
  paginatedEventQuery,
  sortEventsAscendingInPlace,
} from "../src/utils";
import * as utils from "./utils";

const { NODE_SUCCESS, NODE_APP_ERR } = utils;

type BlockTag = ethersProviders.BlockTag;

type DepositRoute = {
  blockNumber: number;
  originToken: string;
  destinationChainId: number;
  enabled: boolean;
  transactionHash: string;
};

type SpokePoolDepositRoutes = {
  address: string;
  toBlock: number;
  depositRoutes: DepositRoute[];
};

type DepositRoutes = { [chainId: number]: SpokePoolDepositRoutes };

async function getEnabledChainIds(hubChainId: number, blockTag: BlockTag): Promise<number[]> {
  const provider = await getProvider(hubChainId);
  const configStore = await utils.getContract(hubChainId, "AcrossConfigStore");
  const CHAIN_ID_INDICES = ethersUtils.formatBytes32String("CHAIN_ID_INDICES");
  const _chainIds = await configStore.connect(provider).globalConfig(CHAIN_ID_INDICES, { blockTag });
  return JSON.parse(_chainIds.replaceAll('"', ""));
}

function stringifyDepositRoutes(depositRoutes: DepositRoutes): { routes: string; hash: string } {
  const routes = JSON.stringify(depositRoutes, null, 2);
  return { routes, hash: ethersUtils.id(routes) };
}

function readDepositRoutes(path: string): DepositRoutes | undefined {
  const depositRoutes = readFileSync(path, { encoding: "utf8" });
  try {
    return JSON.parse(depositRoutes);
  } catch {
    return undefined;
  }
}

function dumpDepositRoutes(depositRoutes: DepositRoutes, fileName: string): boolean {
  const { routes } = stringifyDepositRoutes(depositRoutes);
  writeFileSync(fileName, routes, { flag: "w", mode: 0o644 });
  return true;
}

async function scrapeChainDepositRoutes(chainId: number, toBlock?: number): Promise<SpokePoolDepositRoutes> {
  const provider = await getProvider(chainId);
  const spokePool = (await utils.getSpokePoolContract(chainId)).connect(provider);
  const fromBlock = getDeploymentBlockNumber("SpokePool", chainId);
  toBlock ??= await spokePool.provider.getBlockNumber();

  const filter = spokePool.filters.EnabledDepositRoute();
  const events = await paginatedEventQuery(spokePool, filter, { fromBlock, toBlock, maxBlockLookBack: 10_000 });
  sortEventsAscendingInPlace(events);

  const depositRoutes = events.map((event: Event) => {
    const { transactionHash, blockNumber, data, topics } = event;
    const { args } = spokePool.interface.parseLog({ data, topics });
    const { originToken, destinationChainId, enabled } = args;

    return {
      blockNumber,
      originToken,
      destinationChainId: Number(destinationChainId),
      enabled,
      transactionHash,
    };
  });

  return { address: spokePool.address, toBlock, depositRoutes };
}

async function scrapeDepositRoutes(
  hubChainId: number,
  toBlocks: { [chainId: number]: number } = {}
): Promise<DepositRoutes> {
  const hubProvider = await getProvider(hubChainId);
  toBlocks[hubChainId] ??= await hubProvider.getBlockNumber();

  const chainIds = await getEnabledChainIds(hubChainId, toBlocks[hubChainId]);

  const depositRoutes = Object.fromEntries(
    await sdkUtils.mapAsync(
      chainIds.filter((chainId: number) => chainId !== CHAIN_IDs.BOBA),
      async (spokeChainId: number) => {
        const depositRoutes = await scrapeChainDepositRoutes(spokeChainId, toBlocks[spokeChainId]);
        return [spokeChainId, depositRoutes];
      }
    )
  );

  return depositRoutes;
}

async function verifyDepositRoutes(path: string): Promise<boolean> {
  const depositRoutes = readDepositRoutes(path);
  const { hash: expectedHash } = stringifyDepositRoutes(depositRoutes);
  const chainIds = Object.keys(depositRoutes).map(Number);

  const toBlocks = Object.fromEntries(chainIds.map((chainId) => [chainId, depositRoutes[chainId].toBlock]));
  const hubChainId = utils.resolveHubChainId(chainIds[0]);
  const scrapedDepositRoutes = await scrapeDepositRoutes(hubChainId, toBlocks);

  const { hash } = stringifyDepositRoutes(scrapedDepositRoutes);
  if (hash !== expectedHash) {
    const chain = getNetworkName(hubChainId);
    console.log(`Deposit routes at "${path}" do not match ${chain} state`);
    return false;
  }

  return true;
}

function usage(badInput?: string): boolean {
  let usageStr = badInput ? `\nUnrecognized input: "${badInput}".\n\n` : "";

  usageStr += `
    Usage:
    \tyarn ts-node ./scripts/depositRoutes.ts snapshot [--chainId <hubChainId>] [--file <path-to-file>]
    \tyarn ts-node ./scripts/depositRoutes.ts verify --file <path-to-file>
  `.slice(1); // Skip leading newline
  console.log(usageStr);

  return !isDefined(badInput);
}

async function run(argv: string[]): Promise<number> {
  const cmd = argv[0];

  const opts = {
    string: ["chainId", "file"],
    unknown: usage,
  };
  let { chainId, file } = minimist(argv.slice(1), opts);

  chainId = Number(chainId) || CHAIN_IDs.MAINNET;
  if (!Number.isInteger(chainId)) {
    throw new Error(`Invalid chain ID: ${chainId}`);
  }
  file ??= "./DepositRoutes.json";

  let result: boolean;
  switch (cmd) {
    case "snapshot":
      result = dumpDepositRoutes(await scrapeDepositRoutes(chainId), file);
      break;
    case "verify":
      result = await verifyDepositRoutes(file);
      break;
    default:
      result = false;
      break;
  }

  return result ? NODE_SUCCESS : NODE_APP_ERR;
}

if (require.main === module) {
  process.exitCode = 0;
  run(process.argv.slice(2))
    .then((result) => {
      process.exitCode = result;
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      process.exitCode = NODE_APP_ERR;
    })
    .finally(() => exit(process.exitCode));
}
