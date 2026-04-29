# Binance Sweep CLI

## Overview

`scripts/sweepBinanceBalance.ts` is an interactive operator script that withdraws the current free Binance spot balance of a chosen token to a recipient on a chosen destination chain.

Typical use case:

- Sweep `TRX` from the shared Binance account to a Tron recipient.
- Sweep `USDC` from Binance to an EVM address on a supported Binance withdrawal network.

## Usage

```bash
yarn ts-node ./scripts/sweepBinanceBalance.ts \
  --token TRX \
  --dstChain 728126428 \
  --recipient <DESTINATION_ADDRESS>
```

Provide Binance credentials through the standard repo auth inputs for your environment.
If your Binance secret is GCKMS-backed, run the script under `with-gcp-auth`.

Required flags:

- `--token`: Token symbol to withdraw, for example `TRX`, `USDC`, `ETH`.
- `--dstChain`: Destination chain id.
- `--recipient`: Destination-chain-native recipient address.

The script also relies on the normal Binance credential inputs already used elsewhere in the repo.

## Behavior

Before any withdrawal is sent, the script:

- constructs the Binance client and fails immediately if credentials are missing,
- resolves the destination token and chain against live Binance `accountCoins().networkList`,
- validates the destination recipient with chain-aware address checks, including native TVM base58 enforcement on Tron,
- rejects Binance withdrawal networks that require memo/tag style fields,
- loads the current free Binance balance for the selected coin,
- computes the sweep plan using the Binance network withdrawal limits:
  - if free balance is below `withdrawMin`, the script fails fast,
  - if free balance exceeds `withdrawMax`, the script withdraws `withdrawMax` and leaves the residual balance on Binance,
  - because the script uses `transactionFeeFlag=false`, Binance withdrawal fees are deducted from the requested amount, so the summary shows both the requested withdrawal amount and the expected recipient amount,
- prints the withdrawal quota usage reported by Binance,
- prompts for confirmation before submitting the withdrawal.

After submission, the script polls Binance withdrawal history without a global timeout until the withdrawal reaches a terminal completed or failed state.

## Notes

- This is a Binance-only script. It does not require `--wallet`.
- Native-asset withdrawals are supported when Binance supports the destination network and the recipient format is valid.
- On success, the script prints both the recipient explorer URL and the withdrawal transaction explorer URL when Binance exposes a `txId`.
