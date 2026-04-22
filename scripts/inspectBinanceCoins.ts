/*
Usage example:

yarn ts-node ./scripts/inspectBinanceCoins.ts \
  --coin ETH,USDC,USDT,TRX,POL \
  --json

Provide Binance credentials through the standard repo auth inputs for your environment.
If your Binance secret is GCKMS-backed, run the script under with-gcp-auth.
*/

import minimist from "minimist";
import { getBinanceApiClient, getAccountCoins } from "../src/utils/BinanceUtils";

type ParsedArgs = minimist.ParsedArgs;

type Coin = {
  symbol: string;
  balance: string;
  networkList: Array<{
    name: string;
    coin: string;
    withdrawMin: string;
    withdrawMax: string;
    contractAddress: string;
    withdrawFee: string;
    depositEnable?: boolean;
    withdrawEnable?: boolean;
    withdrawTag?: boolean;
  }>;
};

type InspectOutput = {
  generatedAt: string;
  totalCoins: number;
  distinctNetworkLabels: string[];
  selectedCoins: Array<{
    coin: string;
    balance: string;
    networks: Array<{
      name: string;
      depositEnable?: boolean;
      withdrawEnable?: boolean;
      contractAddress?: string;
      withdrawFee?: string;
      withdrawMin?: string;
      withdrawMax?: string;
    }>;
  }>;
};

const DEFAULT_COINS = ["ETH", "USDC", "USDT", "TRX", "POL"];

async function run(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    return;
  }

  const api = await getBinanceApiClient(process.env["BINANCE_API_BASE"]);
  const parsedCoins = await getAccountCoins(api);

  const selectedSymbols = args.allCoins ? undefined : new Set(resolveFlagValues(args.coin, DEFAULT_COINS));
  const selectedCoins = parsedCoins
    .filter((coin) => selectedSymbols === undefined || selectedSymbols.has(coin.symbol.toUpperCase()))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const distinctNetworkLabels = Array.from(
    new Set(parsedCoins.flatMap((coin) => coin.networkList.map((network) => network.name)))
  )
    .filter((label) => label.length > 0)
    .sort();

  if (selectedSymbols !== undefined && selectedCoins.length === 0) {
    const knownSymbols = parsedCoins
      .map((coin) => coin.symbol)
      .sort()
      .join(", ");
    throw new Error(`No Binance coins matched the requested filter. Available coin symbols include: ${knownSymbols}`);
  }

  const output: InspectOutput = {
    generatedAt: new Date().toISOString(),
    totalCoins: parsedCoins.length,
    distinctNetworkLabels,
    selectedCoins: selectedCoins.map((coin) => {
      return {
        coin: coin.symbol,
        balance: coin.balance,
        networks: coin.networkList
          .map((network) => ({
            name: network.name,
            depositEnable: network.depositEnable,
            withdrawEnable: network.withdrawEnable,
            contractAddress: network.contractAddress,
            withdrawFee: network.withdrawFee,
            withdrawMin: network.withdrawMin,
            withdrawMax: network.withdrawMax,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    }),
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  printHumanReadable(output, parsedCoins);
}

function parseArgs(): ParsedArgs & {
  help?: boolean;
  coin?: string | string[];
  allCoins?: boolean;
  json?: boolean;
} {
  return minimist(process.argv.slice(2), {
    boolean: ["help", "allCoins", "json"],
    string: ["coin"],
    alias: {
      help: "h",
      coin: "c",
      allCoins: "a",
      json: "j",
    },
  });
}

function resolveFlagValues(input: string | string[] | undefined, fallback: string[]): string[] {
  const values = input === undefined ? fallback : Array.isArray(input) ? input : [input];
  return Array.from(
    new Set(
      values
        .flatMap((value) => value.split(","))
        .map((value) => value.trim().toUpperCase())
        .filter((value) => value.length > 0)
    )
  ).sort();
}

function printHumanReadable(output: InspectOutput, parsedCoins: Coin[]): void {
  console.log("== Binance Coin Inspector ==");
  console.log(`Generated at: ${output.generatedAt}`);
  console.log(`Total coins returned by Binance: ${output.totalCoins}`);
  console.log(`Distinct Binance network labels: ${output.distinctNetworkLabels.length}`);
  for (const label of output.distinctNetworkLabels) {
    console.log(`- ${label}`);
  }

  console.log("");
  console.log("== Selected Coins ==");
  for (const coin of output.selectedCoins) {
    console.log(`${coin.coin} (free balance: ${coin.balance})`);
    if (coin.networks.length === 0) {
      console.log("  - no networks returned");
      continue;
    }
    for (const network of coin.networks) {
      console.log(
        `  - network=${network.name} deposit=${boolToWord(network.depositEnable)} withdraw=${boolToWord(
          network.withdrawEnable
        )} withdrawFee=${network.withdrawFee ?? ""} withdrawMin=${network.withdrawMin ?? ""} withdrawMax=${
          network.withdrawMax ?? ""
        } contractAddress=${network.contractAddress ?? ""}`
      );
    }
  }

  console.log("");
  console.log("== Known Binance Coin Symbols ==");
  console.log(
    parsedCoins
      .map((coin) => coin.symbol)
      .sort()
      .join(", ")
  );
}

function boolToWord(value: boolean | undefined): string {
  if (value === true) {
    return "enabled";
  }
  if (value === false) {
    return "disabled";
  }
  return "unknown";
}

function printHelp(): void {
  console.log(`Usage:
  yarn ts-node ./scripts/inspectBinanceCoins.ts [options]

Options:
  --coin, -c       Repeatable or comma-separated Binance coin symbols to inspect.
                   Defaults to: ${DEFAULT_COINS.join(", ")}
  --allCoins, -a   Print details for every Binance coin returned by the API.
  --json, -j       Print JSON instead of the human-readable summary.
  --help, -h       Show this help text.

Notes:
  - This script loads the repo .env automatically.
  - Provide Binance credentials through the standard repo auth inputs for your environment.
  - If your Binance secret is GCKMS-backed, run it under with-gcp-auth.
  - Example:
      yarn ts-node ./scripts/inspectBinanceCoins.ts --coin ETH,USDC,USDT,TRX,POL --json`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
