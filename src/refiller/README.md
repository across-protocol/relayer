# Refiller

The Refiller client allows the user to configure target balances of tokens and then provides methods to refill balances that have fallen below those targets.

Unlike the `InventoryClient`, the refiller was originally designed to handle refilling balances on the same-chain and not send cross-chain transfers.

The primary use case for the refiller originally was to send native token balances from one bot's EOA to another. When combining this logic with the InventoryClient's wrapping and unwrapping of native token functions, we can ensure that bot native tokens never get too low.

## Refilling native gas tokens via Across Swap

When a configured native-token balance (e.g. HYPE on HyperEVM, AVAX on Avalanche) falls below its trigger and the signer cannot transfer enough on-chain, the refiller submits an async cross-chain swap via the Across Swap API using the hardcoded route in `SWAP_ROUTES` (`src/common/Constants.ts`). Routes currently source Arbitrum USDC for Avalanche and HyperEVM (and WETH or USDT for other chains). The swap lands as native gas on the destination; a later run can then transfer to the target account if needed.

## Refilling native TRX on Tron

Tron native refills use the same `REFILL_BALANCES` / `REFILL_BALANCES_2` shape as any other chain: omit `token` so it resolves to the chain's native token, and give `account` as either Base58 or 0x-hex (`toAddressType` normalizes both). `target` and `trigger` are whole-TRX amounts — TRX has 6 decimals, not 18.

The refiller emits the same value-only raw transaction it uses on EVM chains (no calldata), and `TransactionClient` routes it to `arch.tvm.submitTransaction`. Tron models a native TRX transfer as a `TransferContract`, distinct from the `TriggerSmartContract` used for contract calls, so the SDK dispatches on calldata being absent; `triggerSmartContract` requires a deployed contract at the target and can never fund an EOA. That dispatch landed in `@across-protocol/sdk` 4.4.18 — on earlier versions the same transaction throws. The fee limit the client computes is ignored here, because transfers pay bandwidth rather than energy, so `TVM_GAS_LIMIT` has no effect on TRX refills.

Two constraints are specific to Tron:

- **No swap fallback.** Tron has no `SWAP_ROUTES` entry, so the refiller can only move TRX the base signer already holds. A signer short on TRX logs `Cannot refill balance to target` rather than sourcing it cross-chain; keep that signer funded out of band.
- **Local-key signer required.** `getTronWebFromEvmSigner` reads the signer's private key, so the signer must be `Wallet`-backed. `mnemonic`, `privateKey`, `secret` and `gckms` all qualify (GCKMS resolves to an `ethers.Wallet`); a `void` read-only signer does not.
- **One RPC entry, two endpoints.** `RPC_PROVIDERS_728126428` must point at the eth-JSON-RPC path (`…/jsonrpc`), which is what the ethers provider and the balance/simulation reads need. TronWeb speaks Tron's native HTTP API instead, so `getTronWebFromEvmSigner` strips that suffix to recover the native base. Configuring the bare native URL instead would break the `eth_*` reads.

Transfers are deliberately not retried in-process. TVM has no nonce, so a retry would rebuild the transfer under a new txID rather than replace the old one, and a broadcast that landed but lost its response is indistinguishable from one that never landed — retrying would send the TRX twice. `_runTransactionTvm` therefore rethrows on the transfer path instead of retrying, and the refill is picked up on the refiller's next iteration, which re-derives the deficit from the on-chain balance. Tron contract calls still retry as before.

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
