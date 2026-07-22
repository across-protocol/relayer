# Helper clients

## Event fetching clients

The SpokePoolClient and HubPoolClient are responsible for fetching events and state from the SpokePool and HubPool contracts.

These clients use cache management modules like the RedisClient in order to reduce event RPC request load and avoid rate-limits.

### Indexed SpokePoolClient event listeners (`src/libexec`)

In indexed mode the SpokePoolClient spawns a per-chain-family child listener that streams SpokePool events to it over IPC: `RelayerSpokePoolListener` (EVM), `RelayerSpokePoolListenerSVM` (Solana), `RelayerSpokePoolListenerTVM` (TRON). Common CLI args: `--chainid`, `--spokepool`, `--lookback` (seconds-from-head or `@<block>`), `--blockrange` (max `eth_getLogs` page, default 10,000), and `--quorum` (default `NODE_QUORUM_<chainId>` / `NODE_QUORUM`, else 1).

EVM and SVM subscribe over websockets and apply quorum in the application layer: `EventManager` tallies each event across `quorum` providers before posting it. TRON's RPCs don't support websockets reliably and expire `eth_newFilter` ids, so the TVM listener instead polls `eth_getLogs` over a single quorum `RetryProvider` — which imposes node quorum on every query (`--quorum` is threaded into `getProvider` as an override) — and reconciles a trailing re-org window:

- After a one-time historical backfill of the look-back-only events (`RequestedSpeedUpDeposit`, `RelayedRootBundle`, `ExecutedRelayerRefundRoot`) up to the startup head, it loops every ~2s (just under TRON's ~3s block time). On each new head it issues one `--blockrange`-paginated `eth_getLogs` for the live events (`FundsDeposited`, `FilledRelay`) over the last `REORG_WINDOW` (64) blocks and diffs the result against what it has posted: events that vanished (re-orged out) are removed, new or re-org-replacement events are added. A re-org is reflected within one poll once quorum converges; a failed query skips the pass and retries on the next poll.
- On TRON the RPC URL must target QuikNode's eth-JSON-RPC path (`…/jsonrpc`); the bare token URL is the TronGrid API and 404s for `eth_*` calls.

## Inventory Client

The InventoryClient has several important functions that all use its `InventoryConfig` as input

### Inventory Config

The full inventory config is defined in /src/interfaces/ and its read from the user's environment in the `src/relayer/RelayerConfig`. It essentially defines target balance allocation %'s across chains.

### Setting and Getting Virtual Balances

The InventoryClient is designed to track inventory across chains, which are actual on-chain token balances plus any virtual balance modifications stemming from incomplete transfers from the `CrossChainTransferClient` and incomplete rebalances from rebalancer clients. The InventoryClient can also add in virtual modifications for upcoming relayer refunds from the `BundleDataApproxClient`.

The InventoryClient exposes functions that let other bots like the `Relayer` and rebalancer clients know its latest calculation of virtual chain balances for a particular token. For pending rebalance adjustments specifically, it depends on the read-only `ReadOnlyRebalancerClient` interface so it does not need to choose a rebalancing mode.

In addition to chain-level virtual balances, InventoryClient exposes cumulative token-level balance context via `getCumulativeBalanceWithApproximateUpcomingRefunds()`. The Rebalancer uses this to evaluate cumulative deficits and excesses when running cumulative inventory rebalancing.

### Determining Refund Chain for Deposit

Another important function of the InventoryClient is to choose where a relayer should get repaid for filling a particular deposit, which is purely a function of the user's configured "ideal" inventory across chains (i.e. defined in the `InventoryConfig`) and how the inventory state would look like post-filling the deposit.

Deep dives:

- `docs/repayment-eligibility.md`
- `docs/repayment-selection.md`
- `docs/inventory-virtual-balance-model.md`
- `docs/slow-fill-lifecycle.md`
- `docs/inventory-vs-rebalancer-responsibilities.md`

### Wrapping and Unwrapping Native Tokens

The InventoryConfig also lets the user set minimum native token balances to hold on all chains in order to avoid running out of gas for submitting on-chain transactions. Because the relayer is filling so many user deposits, it has a big demand for spending native token balance.

For now, the native token target balances are defined in the InventoryConfig and therefore the InventoryClient is in charge of determining when to and executing native token wraps and unwraps.

Ideally, this wrapping and unwrapping would occur in a separate, focused NativeTokenClient.

### Transferring Tokens Across Chains

The InventoryClient also provides functions that are used to transfer tokens across chains via adapters like CCTP, OFT, or canonical bridges. These adapters are defined in /src/adapter/bridges and /src/adapter/l2Bridges which send tokens from L1 to L2 and vice versa, respectively.

For OFT L2 → L1 excess withdrawals (`OFTL2Bridge`), the requested amount is quoted via `quoteOFT` before the transaction is built. Stargate-style OFT paths cap the quoted send amount at the path's available credit, so when quoted capacity is below the requested amount the withdrawal is sized down to the quoted amount and the transaction markdown notes the size-down. When quoted capacity is zero or below the path's minimum send amount, or the quoted fee-adjusted output (`amountReceivedLD`) already violates the withdrawal's max-slippage floor, no transaction is enqueued for that run; the skip is logged at warn level by `BaseChainAdapter.withdrawTokenFromL2` and the excess stays on the L2 to be re-evaluated on a later run once capacity recovers. Pending-withdrawal volume accounting is unaffected because it is derived from on-chain `OFTSent` events, which reflect the actually-sent amounts.

### Plan for Deprecation of Token Transfer Logic

Note that the InventoryClient is an older module and its token transfer functions are slated to be migrated over to rebalancer clients eventually. For now, the separation of concerns between the two is that the InventoryClient is in charge of sending **same** tokens across chains while rebalancer clients swap different tokens across chains.

## Profit Client

Computes the relayer's expected profit from filling a deposit by converting the `inputAmount` of `inputTokens` and the `outputAmount` of `outputTokens` into a USD value.

The Profit Client estimates what the gas cost would be to fill the deposit (i.e. submit the fill function's call data) on the destination chain and factors this into its profitability calculation.

Importantly, the Profit Client exposes certain configuration objects that the user can use to set profitability thresholds.

### Per-token-pair policy overrides

The Profit Client supports a registry of named "policies" that can short-circuit the standard `MIN_RELAYER_FEE_PCT_*` and `RELAYER_GAS_MULTIPLIER_*` lookups. The policies in `RELAYER_POLICIES` (comma-separated) are decoded once at construct time and evaluated in order; the first whose predicate matches the deposit wins. Env mutations after construction are ignored — operators should set policy env vars before the relayer starts.

A policy named `<NAME>` (uppercased in env var keys) matches when:

1. The destination chain ID is in `RELAYER_POLICY_<NAME>_DESTINATIONS_<srcSymbol>_<dstSymbol>` (comma-separated chain IDs).
2. Either `RELAYER_POLICY_<NAME>_ORIGINS_<srcSymbol>_<dstSymbol>` is set and the origin chain ID is in that comma-separated list, **or** that env var is unset and the origin chain supports unmetered fast rebalance for the input token (hub chain, CCTP-eligible USDC, or OFT-eligible routes — see `isUnmeteredFastRebalance` in `src/utils/FillUtils.ts`). An explicit origin allowlist overrides the fast-rebalance default.

`srcSymbol` and `dstSymbol` are the raw token symbols of the deposit's input and output tokens — they bypass the pegged-token symbol remap used by other profitability env vars.

When a deposit matches policy `<NAME>`:

- If `RELAYER_POLICY_<NAME>_MIN_FEE_PCT` is set, `minRelayerFeePct` returns it (may be negative to accept fills below break-even). If unset, the standard per-route/token/chain lookup and default apply.
- If `RELAYER_POLICY_<NAME>_GAS_MULTIPLIER` is set, `resolveGasMultiplier` returns it (must satisfy `0 <= multiplier <= 4`; out-of-range values throw). If unset, the standard per-route/token/chain lookup and default apply.

Example: accept zero-fee USDC->WETH fills into Arbitrum and Optimism with no gas-cost contribution, via a policy named `example`:

```
RELAYER_POLICIES=example
RELAYER_POLICY_EXAMPLE_DESTINATIONS_USDC_WETH=42161,10
RELAYER_POLICY_EXAMPLE_MIN_FEE_PCT=0
RELAYER_POLICY_EXAMPLE_GAS_MULTIPLIER=0
```

## Transaction Client

This client is responsible for submitting transactions on-chain and therefore for setting the transaction's gas price values, nonce, and implements important retry and error decoding logic. It is designed to be shared across all code modules that submit on-chain transactions.
