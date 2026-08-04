# Refiller

The Refiller client allows the user to configure target balances of tokens and then provides methods to refill balances that have fallen below those targets.

Unlike the `InventoryClient`, the refiller was originally designed to handle refilling balances on the same-chain and not send cross-chain transfers.

The primary use case for the refiller originally was to send native token balances from one bot's EOA to another. When combining this logic with the InventoryClient's wrapping and unwrapping of native token functions, we can ensure that bot native tokens never get too low.

## Refilling native gas tokens via Across Swap

When a configured native-token balance (e.g. HYPE on HyperEVM, AVAX on Avalanche) falls below its trigger and the signer cannot transfer enough on-chain, the refiller submits an async cross-chain swap via the Across Swap API using the hardcoded route in `SWAP_ROUTES` (`src/common/Constants.ts`). Routes currently source Arbitrum USDC for Avalanche and HyperEVM (and WETH or USDT for other chains). The swap lands as native gas on the destination; a later run can then transfer to the target account if needed.

## Refilling USDH on HyperEVM

The Refiller also has a function that lets it transfer USDC from Arbitrum and mint USDH on HyperEVM via the NativeMarkets API.

The reason why this function was originally located in this Refiller client is because initiating this USDH "refill" starts with an ERC20 transfer, much like some of the other refill functions in the Refiller. So, there is some code-reuse here.

However, ideally this logic for refilling USDH is moved into a separate client. Perhaps it should be located in the rebalancer module since its function is to shift cross-chain token inventory like other rebalancer adapters.

## Sweeping mainnet USDG to Robinhood

Robinhood inventory holds USDG on chain 4663; mainnet USDG (`USDG-MAINNET`, `0xe343167631d89B6Ffc58B88d6b7fB0228795491D`) should not accumulate. When a `REFILL_BALANCES` entry targets that token on mainnet (`chainId: 1`, `token: 0xe343167631d89B6Ffc58B88d6b7fB0228795491D`), the refiller routes to a bespoke handler that sweeps the base signer's full mainnet USDG balance to Robinhood USDG via the Paxos Transit API when the balance exceeds `MIN_USDG_SWEEP_AMOUNT` (default 10 USDG). Paxos Transit enforces a separate $5 minimum per order.

Required environment variables:

- `PAXOS_API_KEY`

Optional overrides (defaults are in `ContractAddresses.ts`):

- `PAXOS_TRANSIT_STATION_1`
- `PAXOS_TRANSIT_STATION_4663`

The refiller constructs `PaxosTransitBridge` directly for this path; it is **not** registered in `CUSTOM_BRIDGE`, so the rebalancer will not plan mainnet USDG → Robinhood transfers.

Normal RH inventory refills still use mainnet USDC via `CUSTOM_BRIDGE` and inventory/rebalancer config; this path is only for cleaning up stray mainnet USDG.
