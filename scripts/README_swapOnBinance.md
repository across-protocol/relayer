# Binance Swap CLI

## Overview

`scripts/swapOnBinance.ts` is an interactive operator script that routes a swap through the shared Binance account:

1. Validate source token/chain, destination token/chain, and recipient format against repo metadata plus live Binance network metadata.
2. Quote the Binance spot leg, withdrawal fee, source-chain deposit gas, current source-chain balances, and current destination recipient balances.
3. Submit the source-chain deposit into Binance and tag it as `SWAP`.
4. Wait for Binance to report the deposit and for the Binance source balance to be sufficient to trade.
5. Place a Binance spot market order and wait for the post-trade free balance to unlock.
6. Submit the Binance withdrawal, tag it as `SWAP`, and wait for Binance to report completion.

The script is intentionally interactive and avoids global timeouts so an operator or agent can keep it running through long Binance settlement windows.

## Usage

```bash
yarn ts-node ./scripts/swapOnBinance.ts \
  --srcToken USDC \
  --srcChain 137 \
  --dstToken TRX \
  --dstChain 728126428 \
  --amount 10 \
  --recipient <DESTINATION_ADDRESS> \
  --priorityFeeScaler 1.2 \
  --maxFeePerGasScaler 3 \
  --wallet <WALLET_MODE>
```

Use `ts-node` for this script. `tsx` currently triggers a repo import-cycle issue during startup.
Provide Binance credentials through the standard repo auth inputs for your environment.
If your signer or Binance secret is GCKMS-backed, run the script under `with-gcp-auth`.

Required flags:

- `--srcToken`: Source token symbol, for example `USDC`, `USDT`, `ETH`.
- `--srcChain`: Source chain id.
- `--dstToken`: Destination token symbol.
- `--dstChain`: Destination chain id.
- `--amount`: Human-readable source token amount.
- `--recipient`: Destination-chain-native recipient format.
- `--wallet`: Required explicitly. The script will fail fast if it is omitted.

Optional flags:

- `--priorityFeeScaler`: Multiplier passed to `getGasPrice()` for the deposit priority fee. Defaults to `1.2`.
- `--maxFeePerGasScaler`: Multiplier passed to `getGasPrice()` for the deposit max fee. Defaults to `3`.

The script also relies on the normal signer and Binance credential inputs already used elsewhere in the repo, plus the standard RPC provider env vars for the source chain.

## Preflight behavior

Before any transaction is sent, the script:

- constructs the Binance client and fails immediately if credentials are missing,
- requires an explicit `--wallet`,
- resolves the source and destination assets against live Binance `accountCoins().networkList`,
- matches supported repo chains to the exact Binance network labels currently returned by the API for those chains: `ETH`, `ARBITRUM`, `BASE`, `BSC`, `OPTIMISM`, `MATIC`, `TRX`, and `ZKSYNCERA`,
- rejects routes where the source and destination resolve to the same Binance coin,
- rejects Binance networks that require memo/tag style withdrawal fields,
- verifies ERC20 Binance network `contractAddress` values against the repo token address on the specified chain,
- only accepts the canonical native token symbol returned by `getNativeTokenInfoForChain(chainId)` for native-asset routes,
- only allows native-asset source deposits on chains where an `AtomicWethDepositor` plus transfer proxy deployment exists,
- validates destination recipients with chain-aware formatting checks, including native TVM base58 enforcement on Tron,
- checks source token balance and source-chain native gas balance,
- prints the current source token balance and native gas balance in the quote summary,
- prints the current destination recipient token balance and, when applicable, destination native gas balance in the quote summary,
- prints other Binance-eligible known token balances on the source chain when the requested source balance is insufficient,
- checks Binance daily withdrawal quota,
- estimates:
  - configured gas price scalers,
  - source-chain gas limit, gas price, and gas cost,
  - spot price and slippage,
  - trade fee,
  - withdrawal fee,
  - estimated withdrawal request amount,
  - expected recipient amount after Binance trade and withdrawal fees.

## Execution notes

- Deposits are tagged with `setBinanceDepositType(..., BinanceTransactionType.SWAP)` so finalizer/rebalancer workflows do not treat them as bridge inventory.
- Withdrawals are tagged with `setBinanceWithdrawalType(..., BinanceTransactionType.SWAP)`.
- Native source deposits are executed via the `AtomicWethDepositor`. The script submits an approval first when the depositor needs fresh allowance, then calls the depositor to forward the deposit into Binance.
- Deposit polling waits for both Binance deposit-history visibility and sufficient free balance before placing the market order.
- Withdrawal polling and trade polling run perpetually until they observe a terminal Binance state or the process is stopped.
- On success the script prints:
  - the recipient explorer URL,
  - the withdrawal transaction explorer URL when Binance exposes `txId`,
  - the withdrawal request amount,
  - the expected recipient amount,
  - the local timestamp when the script first observed Binance withdrawal status `COMPLETED`.

## Current limitations

- Interactive only. There is no `--yes` or headless mode.
- Destination networks that require memo/tag or extra withdrawal fields are rejected.
- Native source deposits are only supported on chains where the repo has an `AtomicWethDepositor` deployment with a transfer proxy.
- The script does not persist resumable crash state. It is designed to keep polling without timing out while the process remains alive.
- “Withdrawal completed at” is the first local observation time for Binance status `COMPLETED`, not a Binance-native completion timestamp.

## Contributor notes

- Adapter-derived shared helpers live in `src/utils/BinanceSwapUtils.ts`.
- Script-specific validation, quote, and polling logic lives directly in `scripts/swapOnBinance.ts`.
- The CLI intentionally supports a wider live-Binance universe than the production rebalancer route maps in `src/rebalancer/`.
- If you widen rebalancer support for a Binance route, update both the route construction layer and its documentation; script support alone is not enough.
