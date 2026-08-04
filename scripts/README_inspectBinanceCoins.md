# Binance Coin Inspector

## Overview

`scripts/inspectBinanceCoins.ts` is a read-only operator script that prints the Binance coin and network metadata returned by the authenticated Binance account.

Typical uses:

- Inspect the exact Binance network labels returned by `accountCoins().networkList`.
- Check whether deposits and withdrawals are enabled for a coin on a specific network.
- Review withdrawal fees, minimums, maximums, and contract addresses before updating other Binance scripts.

## Usage

```bash
yarn ts-node ./scripts/inspectBinanceCoins.ts \
  --coin ETH,USDC,USDT,TRX,POL \
  --json
```

Provide Binance credentials through the standard repo auth inputs for your environment.
If your Binance secret is GCKMS-backed, run the script under `with-gcp-auth`.

Options:

- `--coin`, `-c`: Repeatable or comma-separated Binance coin symbols to inspect. Defaults to `ETH,USDC,USDT,TRX,POL`.
- `--allCoins`, `-a`: Print details for every Binance coin returned by the API.
- `--json`, `-j`: Print JSON instead of the human-readable summary.
- `--help`, `-h`: Show the help text.

## Output

The script prints:

- the generation timestamp,
- total number of Binance coins returned by the API,
- the distinct set of Binance network labels,
- the selected coin entries including:
  - free balance,
  - network name,
  - deposit enabled flag,
  - withdrawal enabled flag,
  - withdrawal fee,
  - withdrawal minimum,
  - withdrawal maximum,
  - contract address.

## Notes

- This script is read-only.
- It loads the repo `.env` automatically.
- It uses the shared `getAccountCoins()` parser so the output matches the metadata consumed by the other Binance scripts in this repo.
