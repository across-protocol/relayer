# Rebalancer

The Rebalancer determines when the relayer's inventory should be reshaped across chains and tokens, then executes those cross-asset rebalances through configured venue adapters.

## Rebalancer Clients

Core rebalancer implementation is split by subdirectory responsibility:

- `src/rebalancer/clients/`: mode clients and shared mode lifecycle.
- `src/rebalancer/adapters/`: venue execution implementations.
- `src/rebalancer/utils/`: shared rebalancer contracts and helper utilities.
- `src/rebalancer/`: runtime orchestration for runner setup and execution.

### Rebalance Routes

A `RebalanceRoute` defines:

- source chain and source token,
- destination chain and destination token,
- adapter name used to execute the swap flow.

Routes are assembled by the rebalancer construction layer and passed at client initialization time (`initialize(rebalanceRoutes)`). The mode clients then filter to routes that are valid for current balances/config.

The cumulative-mode production route set is generated in `src/rebalancer/buildRebalanceRoutes.ts`. It covers:

- stablecoin swap routes between `USDC` and `USDT` on Binance and Hyperliquid, excluding Tron from Hyperliquid,
- same-asset routes for `USDC` via CCTP and on direct Binance-supported USDC networks via Binance, and for `USDT` via OFT and on direct Binance-supported USDT networks via Binance,
- Binance-only `WETH <-> USDC` and `WETH <-> USDT` routes sourced or settled through mainnet. `WETH <-> WETH` route handling exists in the adapter, but no cross-chain `WETH <-> WETH` routes are generated while WETH Binance support is limited to mainnet.

Route construction keeps two token-keyed chain maps:

- `BINANCE_NETWORKS_BY_SYMBOL`: direct Binance deposit/withdraw networks known for each token.
- `REBALANCE_CHAINS_BY_SYMBOL`: the narrower set of chains this repo currently enables for rebalancing that token.

Operational note:

- Same-asset `USDC <-> USDC` and `USDT <-> USDT` Binance routes are included deliberately so they can compete on estimated cost against CCTP/OFT paths, but they are only generated when both chains are direct Binance networks for that asset.
- USDT on Tron is treated as a direct Binance `TRX` network for both deposits and withdrawals. Tron USDT Binance routes deposit to and withdraw from Binance directly, rather than bridging through an OFT entrypoint network first.
- Updating Binance venue support for a token does not automatically widen rebalancer support. New chains should usually be added to both maps intentionally after inventory/config/runtime review.
- Current route construction limits Binance `WETH` support to mainnet because the rebalancer's native-ETH deposit path relies on the mainnet Atomic Depositor and transfer proxy wiring.
- If additional direct Binance ETH networks are enabled later, same-coin `WETH <-> WETH` routes skip the spot swap leg and treat on-chain `WETH` as Binance `ETH`.
- Intermediate on-chain bridge legs into or out of Binance remain restricted to `USDC` and `USDT`; current `WETH` routes therefore source or settle through mainnet rather than bridging WETH into another Binance ETH network.
- Hyperliquid routes intentionally exclude Tron even when Tron USDT is configured, and same-asset USDT routes involving Tron use Binance rather than OFT.

The dedicated SameAsset mode has a separate route source in `src/rebalancer/buildSameAssetRebalanceRoutes.ts`. Its read-only `SAME_ASSET_REBALANCE_ROUTE_SUPPORT` catalog is the source of truth for token, destination-chain, and adapter combinations that this mode can execute. `buildSameAssetRebalanceRoutes(rebalancerConfig)` returns only the intersection of that catalog and `sameAssetBalances`; adding configuration alone does not enable an unsupported route. Both `SameAssetRebalancerClient` and Jussi topology preparation consume this builder so runtime support and graph edges stay aligned.

SameAsset routes are directional. They move an unchanged asset from the hub chain to a configured destination chain through the selected swap-rebalancer adapter. Excess destination-chain inventory moving back to the hub chain remains an InventoryClient responsibility and is not emitted as a reverse SameAsset route.

### Rebalancer Adapter

Adapters in `src/rebalancer/adapters/` initiate and progress multi-stage swap workflows. The interface currently is:

```ts
export interface RebalancerAdapter {
  baseSignerAddress: EvmAddress;
  initialize(availableRoutes: RebalanceRoute[]): Promise<void>;
  initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<BigNumber>;
  updateRebalanceStatuses(): Promise<void>;
  sweepIntermediateBalances(): Promise<void>;
  getPendingRebalances(account: EvmAddress): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
  getPendingOrders(): Promise<string[]>;
  getEstimatedCost(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber, debugLog: boolean): Promise<BigNumber>;
}
```

Implemented production swap adapters:

- Binance
- Hyperliquid

`BaseAdapter` persists pending state in Redis so in-flight multi-stage swaps can be resumed and tracked deterministically across runs.
Pending-status Redis sets are keyed by adapter status and signer address, so callers can request pending rebalance
accounting for a specific EVM account while keeping independently operated accounts isolated from one another.

#### Estimated cost: spread vs oracle fair price

`getEstimatedCost` on the Binance and Hyperliquid adapters includes a spread-cost component that compares the worst-fill price an order would cross on the venue's order book against the oracle-derived fair cross-token price `P_base_usd / P_quote_usd`. For dollar-pegged pairs (e.g. `USDC/USDT`) the ratio is ≈ 1 and the formula reduces to the prior par-based form; for non-par markets (e.g. `WETH/USDC`, `WETH/USDT`) the same formula correctly compares the worst-fill price to the true cross-token rate without producing nonsense estimates.

Oracle wiring:

- `BaseAdapter._getTokenPriceUsd(symbol)` resolves a token's USD price via the same hub-chain-address lookup `CumulativeBalanceRebalancerClient` uses, with results cached per adapter instance for the rebalancer cycle.
- Operators can override a token's USD price with the `RELAYER_TOKEN_PRICE_FIXED_<address>` env var (where `<address>` is the hex hub-chain ERC-20 address), matching the existing override the cumulative client honors. Use for incident response when the upstream oracle is degraded.
- `BaseAdapter._getFairCrossPrice(baseToken, quoteToken)` is the helper both adapters call; it returns the quote-per-base ratio so it can be compared directly to the order book's `latestPrice`.

Fallback behavior on oracle failure:

- Binance falls back to depth-only order-book slippage (the prior `slippagePct` measure) — a conservative lower bound that under-estimates real cost when a stablecoin pair trades off par.
- Hyperliquid falls back to the legacy `1 - latestPrice` par-based formula, which preserves current behavior for the stablecoin pairs HL routes today.
- Both adapters emit a `warn` log on oracle failure (`Oracle fair price unresolved for <base>/<quote>; falling back to ...`) so operators can detect degraded estimates.
- Both adapters clamp negative spread to zero, so a favorably-priced book does not surface as a negative cost or fail the downstream `toBNWei` parse.

Binance account assumption:

- `relayer-v2` currently assumes all bots and clients that interact with the Binance rebalancer adapter share the same
  Binance account and API credentials.
- The `account` passed into `getPendingRebalances(account)` selects which EVM address owns the on-chain leg and Redis
  status entries being inspected; it does not select a different Binance exchange account.
- This is why Binance fill/order lookups remain scoped to the adapter's configured Binance API client even when
  Monitor or `ReadOnlyRebalancerClient` asks for pending rebalance accounting for multiple relayer EVM accounts.
- If the system ever needs one deployment to inspect or operate multiple Binance accounts simultaneously, the adapter
  and its documentation should be revisited because the current model intentionally does not support that.

### Pending-order cache lifecycle and recovery

When adapters create new orders, order detail keys are stored with `REBALANCER_PENDING_ORDER_TTL` (default: 1 hour).
If this env var is unset, the rebalancer uses the 1-hour default.

Adapters may also pass a `ttlOverride` to `BaseAdapter._redisCreateOrder` to extend the default for routes whose
expected finality outlives 1 hour. Long-finality OFT pre-deposit bridges (currently USDT0 from HyperEVM, ~12h) use
`getOftPreDepositOrderTtlOverride` from `oftAdapter.ts` so both `OftAdapter` and adapters that delegate their
pre-deposit bridge to OFT (e.g. `BinanceStablecoinSwapAdapter`) keep their pending-order TTL aligned with the
underlying bridge. Note that `_redisUpdateOrderStatus` does not refresh the TTL, so the value set at creation is the
lifetime of the whole order across all status transitions.

If an order does not finalize before the TTL expires, order details and associated pending-order status tracking are
eventually pruned from Redis cache state. `BaseAdapter._redisCleanupPendingOrders` emits a `warn` log (`⏰ Pruning
expired pending order ...`) when this happens so operators can detect abandoned orders that never received a
finalization log. At that point, operators should rely on adapter lifecycle reconciliation (including
`sweepIntermediateBalances`) to recover stranded intermediate capital instead of assuming pending-order cache entries
remain indefinitely.

Contributor guidance:

- Pending rebalance orders are intentionally short lived. In practice, a legacy Redis order-schema change is usually
  low risk because stale payloads age out quickly under the default 1-hour TTL.
- Prefer waiting out the TTL or rotating `REBALANCER_STATUS_TRACKING_NAMESPACE` over writing complex migration logic for
  old pending-order payloads, unless you know there are still recent orders that must continue to reconcile in place.
- Namespace rotation is operationally straightforward because the status-tracking cache is already isolated from the
  rest of the application's Redis usage, and stale intermediate balances can be recovered through the normal adapter
  reconciliation path.

Operational warning:

- Rotating `REBALANCER_STATUS_TRACKING_NAMESPACE` is another way to force-reset pending-order cache state.
- This is risky and should only be performed when there are no recently pending orders that are still expected to finalize.
- If used, recovery should proceed through the normal lifecycle reconciliation path (`sweepIntermediateBalances` and status updates).

## Mode vs Adapter Architecture

The rebalancer has two independent layers:

- **Mode layer** (`src/rebalancer/clients/`) decides **what** inventory imbalance should be corrected and in what order.
- **Adapter layer** (`RebalancerAdapter` implementations in `src/rebalancer/adapters/`) decides **how** to execute a selected route on a venue.

This separation is intentional:

- Mode logic should stay focused on deficit/excess detection, prioritization, route evaluation, and guardrails.
- Adapter logic should stay focused on venue-specific API calls, order lifecycle handling, and pending-state reporting.
- The contract between both layers is the `RebalancerAdapter` interface plus `RebalanceRoute`.

Signer invariant:

- `BaseRebalancerClient.initialize()` asserts that every configured adapter resolved the same `baseSignerAddress` as the
  rebalancer client itself.
- This keeps rebalance initiation, pending-order caps, and pending-rebalance accounting aligned to a single owning
  account for that client instance.

### Safe extension checklist for new adapters

When adding a new file in `src/rebalancer/adapters/`, contributors should usually avoid touching mode logic in `src/rebalancer/clients/`.

1. Implement the full `RebalancerAdapter` interface in the new adapter file.
2. Register the adapter in the rebalancer construction layer (adapter map + route inclusion).
3. Ensure at least one `RebalanceRoute` points to the adapter name.
4. Keep mode logic unchanged unless requirements for deficit/excess selection actually changed.
5. Verify pending-order and pending-rebalance reporting is implemented, since mode guardrails rely on it.

## Rebalancer Config

`RebalancerConfig` is loaded from `REBALANCER_CONFIG` or `REBALANCER_EXTERNAL_CONFIG`.

The active config supports cumulative-target and SameAsset modes:

```json
{
  "cumulativeTargetBalances": {
    "USDT": {
      "targetBalance": "1500000",
      "thresholdBalance": "1000000",
      "priorityTier": 1,
      "chains": { "1": 1, "42161": 0 }
    }
  },
  "sameAssetBalances": {
    "USDT": {
      "chains": { "43114": 1 }
    }
  },
  "maxAmountsToTransfer": {
    "USDT": "1000"
  },
  "maxPendingOrders": {
    "binance": 3,
    "hyperliquid": 3
  }
}
```

Notes:

- `targetBalance` and `thresholdBalance` values are human-readable and converted to token-native decimals.
- `cumulativeTargetBalances` define per-token aggregate objectives plus allowed source/destination chain sets for `CumulativeBalanceRebalancerClient.rebalanceInventory()`.
- `cumulativeTargetBalances[token].chains[chainId]` is a chain priority tier used when selecting where to source excess inventory from and where to land deficit inventory. Lower tiers are preferred for sourcing; higher tiers are preferred for destinations.
- `sameAssetBalances[token].chains` enables destination chains for `SameAssetRebalancerClient`; InventoryConfig supplies the per-chain target and threshold used to decide whether a transfer is needed. Values in this chain map are enablement markers after parsing, not route-ranking inputs.
- A SameAsset entry becomes executable only when the support catalog contains the same token and destination chain. The configured source and destination must also be present for that token in InventoryConfig when the route is included in a Jussi graph.
- `chainIds` are derived from the union of chains found in `cumulativeTargetBalances` and `sameAssetBalances`, with the hub chain included when SameAsset mode is configured.

For an operator playbook on sizing these values from expected deposit fills, see
[`docs/rebalancer-config-from-deposit-flow.md`](../../docs/rebalancer-config-from-deposit-flow.md).

## Rebalancing Modes

### Cumulative mode: `CumulativeBalanceRebalancerClient.rebalanceInventory()`

This is the current operational path and runtime execution via `runCumulativeBalanceRebalancer` in the `src/rebalancer/` runtime layer.

Inputs:

- `cumulativeBalances`: token -> aggregate balance (L1-decimal normalized),
- `currentBalances`: chain -> token -> chain-local balance,
- `maxFeePct`.

High-level flow:

1. Compute cumulative deficits (`current < threshold`, target refill amount `target - current`) and cumulative excesses (`current > target`, excess amount `current - target`).
2. Sort cumulative deficits by token `priorityTier` (higher first), then larger USD-normalized deficits first.
3. Sort cumulative excesses by token `priorityTier` (lower first), then larger USD-normalized excesses first.
4. For each excess token used to fill a deficit token, sort source chains from `cumulativeTargetBalances[excessToken].chains` by:
   - chain `priorityTier` ascending,
   - then current chain balance descending.
5. For each candidate source chain, evaluate all destination chains configured for the deficit token that have valid routes, then choose the highest destination priority tier with an estimated cost within `maxFeePct`. Routes in the same destination priority tier use the lowest `getEstimatedCost`.
6. Cap transfer amount by remaining deficit, remaining excess, chain balance, and configured `maxAmountsToTransfer`. For mixed-asset routes such as `WETH <-> stablecoin`, the client converts between source and destination token amounts through hub-chain USD prices before capping and decrementing the remaining deficit.
7. Enforce max fee pct and adapter pending-order caps before calling `initializeRebalance`. If an affordable ranked route declines during initialization, try the next affordable route.

Design tradeoff:

- Destination-chain selection evaluates all eligible routes and favors configured destination priority before expected cost. This sends replenishment to preferred inventory locations while still falling back to lower-priority routes when higher-priority routes exceed `maxFeePct`.

### SameAsset mode: `SameAssetRebalancerClient.rebalanceInventory()`

This mode handles configured same-token hub-to-destination transfers that InventoryClient cannot reliably execute through its own bridge adapters. It reuses InventoryClient's inventory targets but delegates execution and lifecycle tracking to the swap-rebalancer adapters.

High-level flow:

1. Ask InventoryClient for the currently needed hub-to-destination inventory rebalances without allowing InventoryClient to execute them.
2. Match each candidate against the directional routes produced by `buildSameAssetRebalanceRoutes` and discard candidates with no configured, supported route.
3. Cap the amount using `maxAmountsToTransfer`, reject estimates above `MAX_FEE_PCT`, and initialize the route through its configured adapter when transaction sending is enabled.
4. Track intermediate venue and bridge state in the adapter's Redis lifecycle, preserving the destination-chain context that the InventoryClient bridge-adapter path cannot represent.

The runtime entrypoint is `runSameAssetRebalancer`, exposed as the `sameAssetRebalancer` bot. It is independent of cumulative mode: operators enable destination token/chain pairs under `sameAssetBalances`, while the support catalog controls which of those pairs can become routes.

Cross-mode pending orders: the `swapRebalancer` and `sameAssetRebalancer` bots typically share a base signer and the Redis order store, so each bot's `updateRebalanceStatuses()` pass can encounter pending orders created by the other mode. Adapters only progress orders whose routes are in their own configured `availableRoutes` (`BaseAdapter._canProgressOrder`); unsupported orders are skipped with a debug log and left pending for the properly-configured bot to progress. If no configured instance supports an order's route (e.g. after config drift), the order is eventually TTL-pruned with a warning by `_redisCleanupPendingOrders`.

### Read-only mode: `ReadOnlyRebalancerClient`

`ReadOnlyRebalancerClient` is used by consumers that only need pending-state visibility (for example, inventory
accounting) and should not initiate new rebalances.

The read-only mode still initializes adapters (with an empty route set) so `getPendingRebalances(account)` and
`getPendingOrders()` remain available without coupling callers to a specific operational rebalancing mode.

The OFT and CCTP adapters also expose their pending bridge-pre-deposit Redis schema through `src/rebalancer/clients/CctpOftReadOnlyClient.ts`. Adapter-side bridge accounting uses that readonly reader to ignore rebalancer-owned OFT/CCTP transfers instead of instantiating rebalancer adapters inside `AdapterManager`.

## Creating Rebalancer Instances

Use the rebalancer construction layer to instantiate mode-specific clients:

- `constructCumulativeBalanceRebalancerClient()` for operational runs.
- `constructSameAssetRebalancerClient()` for configured same-token hub-to-destination runs.
- `constructReadOnlyRebalancerClient()` for pending-state consumers.

Lifecycle note:

- Constructors wire logger/config/adapters/signer.
- `initialize(rebalanceRoutes)` sets route set and initializes adapters.
- Read-only mode intentionally calls `initialize([])` and still supports `getPendingRebalances(account)` because
  pending-state reads do not depend on route selection.
- Consumers pass the relayer/account they want to inspect into `getPendingRebalances(account)`; the client aggregates
  only the pending state owned by that EVM address.
- `getPendingRebalances(account)` isolates per-adapter failures: if one adapter's pending-state read throws (e.g. its
  upstream exchange API is down), the client logs a warning and aggregates the remaining adapters instead of throwing.
  Consumers such as the relayer's `InventoryClient` keep running with that adapter's in-flight rebalances temporarily
  uncounted in virtual balances.
- `getAdaptersWithFailedPendingReads()` reports which adapters were dropped from the most recent
  `getPendingRebalances()` aggregation. Read-only consumers can ignore it, but the write-mode runtimes must check it
  before initiating new rebalances: while any adapter's pending state is invisible, an apparent deficit may already be
  covered by an in-flight rebalance, so initiating against it would duplicate that rebalance.

Runtime entrypoints in `src/rebalancer/`:

- `runCumulativeBalanceRebalancer` (supported operational path).
- `runSameAssetRebalancer` (directional SameAsset operational path).
- The runtime updates adapter status/sweeps first, then refreshes `TokenClient` balances before applying adapter-reported pending rebalance adjustments and evaluating new rebalances. The refresh is required because the sweeps and `updateRebalanceStatuses` calls submit OFT/CCTP/Hypercore transactions that leave the initial `TokenClient.update()` snapshot stale; without it, `rebalanceInventory` can size a new bridge against a pre-burn balance and crash on the underlying simulation revert.
- Venue-outage degradation: the status/sweep update loop isolates per-adapter failures (a venue whose API is down is
  logged with a warning and skipped for the run while the remaining adapters progress), both run entrypoints skip
  initiating new rebalances for the run whenever `getAdaptersWithFailedPendingReads()` is non-empty (see the
  duplicate-rebalance rationale above), and a route whose `getEstimatedCost` read fails is excluded from that
  round's route competition instead of aborting the pass.

## Interactions with Other Bots and Clients

### InventoryClient

InventoryClient provides the balance context that the rebalancer consumes:

- chain-level virtual balances,
- cumulative balances (including pending effects and approximate upcoming refunds),
- pending rebalance adjustments from adapters.
- it reads pending rebalance state through `ReadOnlyRebalancerClient` to avoid coupling to a specific rebalancing mode.

### Relayer

Running the Rebalancer allows the relayer to support in-protocol swap flows while maintaining the configured long-run inventory mix.

### Binance Finalizer

The Binance finalizer sweeps exchange balances as a fallback path. Before withdrawing, it constructs a read-only Binance
adapter, reads pending Binance rebalances with `getPendingRebalances(account)`, and subtracts positive destination-token
amounts from the shared exchange-account withdrawal capacity. The Binance adapter marks expected swap lifecycle
transfers, and stale balances are eventually swept if swaps do not complete.

Swap deposits into Binance are tagged `SWAP` in Redis with a TTL of twice the finalizer's default deposit-history
lookback (`FINALIZER_TOKENBRIDGE_LOOKBACK`) so the finalizer excludes them from its deposit ledger for the whole
lookback — including after the swap completes, so a consumed deposit is never re-counted as finalizable ("phantom"
`amountToFinalize`). Handover to the finalizer is driven by order state, not
wall clock: if an order is abandoned while still in `PENDING_DEPOSIT` (its `REBALANCER_PENDING_ORDER_TTL` elapses), the
prune path deletes the deposit's tag via `_onExpiredOrderPruned`, and the finalizer reclaims the funds on its next run.
Orders pruned in later statuses keep the tag, since their deposit was already consumed by the spot order.

When Binance reports `RW00441`, the account has recently credited deposit value that is not withdrawal-unlocked yet.
The Binance adapter treats this as a retryable wait state and leaves the order pending. The Binance finalizer reads
Binance pending rebalance amounts through the Binance adapter so post-swap output balances are not withdrawn while an
order is waiting for Binance's deposit unlock confirmations. Because pending-order Redis sets are keyed by
signer account and finalizer withdrawal recipients can be configured separately, the finalizer checks both configured
EVM withdrawal recipients and the running signer account before applying this shared Binance-account deduction. Pending
rebalance loading errors surface normally so operators can investigate instead of silently sweeping without the
deduction.

## Venue-specific operational note

Hyperliquid spot metadata is currently configured with `pxDecimals=4` for USDT/USDC and prices are truncated to `pxDecimals` when submitting orders. This is a pragmatic setting to avoid tick-size divisibility rejections observed with more granular precision.
