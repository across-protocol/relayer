import minimist from "minimist";
import { getBinanceApiClient, getAccountCoins, type BinanceApi } from "../src/utils/BinanceUtils";

type ParsedArgs = minimist.ParsedArgs;

type BinanceApiWithAccountCoins = BinanceApi & {
  accountCoins(): Promise<Record<string, RawCoin>>;
};

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

type RawNetwork = {
  network?: string;
  coin?: string;
  name?: string;
  depositEnable?: boolean;
  withdrawEnable?: boolean;
  contractAddress?: string;
  withdrawFee?: string;
  withdrawMin?: string;
  withdrawMax?: string;
  [key: string]: unknown;
};

type RawCoin = {
  coin: string;
  free?: string;
  networkList?: RawNetwork[];
  [key: string]: unknown;
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
  const rawApi = api as unknown as BinanceApiWithAccountCoins;
  const [rawCoinsByKey, parsedCoins] = await Promise.all([rawApi.accountCoins(), getAccountCoins(api)]);
  const rawCoins = Object.values(rawCoinsByKey);

  const selectedSymbols = args.allCoins ? undefined : new Set(resolveFlagValues(args.coin, DEFAULT_COINS));
  const selectedCoins = rawCoins
    .filter((coin) => selectedSymbols === undefined || selectedSymbols.has(coin.coin.toUpperCase()))
    .sort((a, b) => a.coin.localeCompare(b.coin));

  const distinctNetworkLabels = Array.from(
    new Set(rawCoins.flatMap((coin) => (coin.networkList ?? []).map((network) => String(network.network ?? ""))))
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
    totalCoins: rawCoins.length,
    distinctNetworkLabels,
    selectedCoins: selectedCoins.map((rawCoin) => {
      const parsedCoin = parsedCoins.find((coin) => coin.symbol === rawCoin.coin);
      return {
        coin: rawCoin.coin,
        balance: parsedCoin?.balance ?? rawCoin.free ?? "0",
        networks: (rawCoin.networkList ?? [])
          .map((network) => ({
            name: String(network.network ?? ""),
            depositEnable: network.depositEnable,
            withdrawEnable: network.withdrawEnable,
            contractAddress: stringifyOptional(network.contractAddress),
            withdrawFee: stringifyOptional(network.withdrawFee),
            withdrawMin: stringifyOptional(network.withdrawMin),
            withdrawMax: stringifyOptional(network.withdrawMax),
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
  console.log(parsedCoins.map((coin) => coin.symbol).sort().join(", "));
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

function stringifyOptional(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function printHelp(): void {
  console.log(`Usage:
  yarn tsx ./scripts/inspectBinanceCoins.ts [options] --binanceSecretKey <gckms-key>

Options:
  --coin, -c       Repeatable or comma-separated Binance coin symbols to inspect.
                   Defaults to: ${DEFAULT_COINS.join(", ")}
  --allCoins, -a   Print details for every Binance coin returned by the API.
  --json, -j       Print JSON instead of the human-readable summary.
  --help, -h       Show this help text.

Notes:
  - This script loads /Users/nicholaspai/UMA/relayer-v2/.env automatically.
  - If you use a GCKMS-backed secret such as binance-nick-test, run it under with-gcp-auth.
  - Example:
      GCP_PROJECT_ID='keys-across-3291' with-gcp-auth yarn tsx ./scripts/inspectBinanceCoins.ts --coin ETH,USDC,USDT,TRX,POL --json --binanceSecretKey binance-nick-test`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
