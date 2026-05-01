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

The built-in production route set is generated in `src/rebalancer/buildRebalanceRoutes.ts`. It covers:

- stablecoin swap routes between `USDC` and `USDT` on Binance and Hyperliquid,
- same-asset routes for `USDC` via CCTP and on direct Binance-supported USDC networks via Binance, and for `USDT` via OFT and on direct Binance-supported USDT networks via Binance,
- Binance-only `WETH <-> USDC` and `WETH <-> USDT` routes sourced or settled through mainnet. `WETH <-> WETH` route handling exists in the adapter, but no cross-chain `WETH <-> WETH` routes are generated while WETH Binance support is limited to mainnet.

Route construction keeps two token-keyed chain maps:

- `BINANCE_NETWORKS_BY_SYMBOL`: direct Binance deposit/withdraw networks known for each token.
- `REBALANCE_CHAINS_BY_SYMBOL`: the narrower set of chains this repo currently enables for rebalancing that token.

Operational note:

- Same-asset `USDC <-> USDC` and `USDT <-> USDT` Binance routes are included deliberately so they can compete on estimated cost against CCTP/OFT paths, but they are only generated when both chains are direct Binance networks for that asset.
- Updating Binance venue support for a token does not automatically widen rebalancer support. New chains should usually be added to both maps intentionally after inventory/config/runtime review.
- Current route construction limits Binance `WETH` support to mainnet because the rebalancer's native-ETH deposit path relies on the mainnet Atomic Depositor and transfer proxy wiring.
- If additional direct Binance ETH networks are enabled later, same-coin `WETH <-> WETH` routes skip the spot swap leg and treat on-chain `WETH` as Binance `ETH`.
- Intermediate on-chain bridge legs into or out of Binance remain restricted to `USDC` and `USDT`; current `WETH` routes therefore source or settle through mainnet rather than bridging WETH into another Binance ETH network.

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

If an order does not finalize before the TTL expires, order details and associated pending-order status tracking are
eventually pruned from Redis cache state. At that point, operators should rely on adapter lifecycle reconciliation
(including `sweepIntermediateBalances`) to recover stranded intermediate capital instead of assuming pending-order cache
entries remain indefinitely.

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

The active config shape is cumulative-target based:

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
- `cumulativeTargetBalances[token].chains[chainId]` is a chain priority tier used when selecting where to source excess inventory from (lower tier is preferred for sourcing).
- `chainIds` are derived from the union of chains found in `cumulativeTargetBalances`.

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
5. For each candidate source chain, evaluate all destination chains configured for the deficit token that have valid routes, then choose the route with the lowest `getEstimatedCost`.
6. Cap transfer amount by remaining deficit, remaining excess, chain balance, and configured `maxAmountsToTransfer`. For mixed-asset routes such as `WETH <-> stablecoin`, the client converts between source and destination token amounts through hub-chain USD prices before capping and decrementing the remaining deficit.
7. Enforce max fee pct and adapter pending-order caps before calling `initializeRebalance`.

Design tradeoff:

- Destination-chain selection evaluates all eligible routes to minimize expected cost. This improves route quality at the expense of additional runtime cost when many routes are configured.

### Read-only mode: `ReadOnlyRebalancerClient`

`ReadOnlyRebalancerClient` is used by consumers that only need pending-state visibility (for example, inventory
accounting) and should not initiate new rebalances.

The read-only mode still initializes adapters (with an empty route set) so `getPendingRebalances(account)` and
`getPendingOrders()` remain available without coupling callers to a specific operational rebalancing mode.

The OFT and CCTP adapters also expose their pending bridge-pre-deposit Redis schema through `src/rebalancer/clients/CctpOftReadOnlyClient.ts`. Adapter-side bridge accounting uses that readonly reader to ignore rebalancer-owned OFT/CCTP transfers instead of instantiating rebalancer adapters inside `AdapterManager`.

### Future mode extensibility

`src/rebalancer/clients/` is intentionally mode-oriented. Today the production mode is cumulative and there is a read-only consumer mode, but additional `RebalancerClient` implementations can be added later without changing adapter contracts.

## Creating Rebalancer Instances

Use the rebalancer construction layer to instantiate mode-specific clients:

- `constructCumulativeBalanceRebalancerClient()` for operational runs.
- `constructReadOnlyRebalancerClient()` for pending-state consumers.

Lifecycle note:

- Constructors wire logger/config/adapters/signer.
- `initialize(rebalanceRoutes)` sets route set and initializes adapters.
- Read-only mode intentionally calls `initialize([])` and still supports `getPendingRebalances(account)` because
  pending-state reads do not depend on route selection.
- Consumers pass the relayer/account they want to inspect into `getPendingRebalances(account)`; the client aggregates
  only the pending state owned by that EVM address.

Runtime entrypoints in `src/rebalancer/`:

- `runCumulativeBalanceRebalancer` (supported operational path).
- The runtime updates adapter status/sweeps first, then applies adapter-reported pending rebalance adjustments before evaluating new rebalances.

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

The Binance finalizer sweeps exchange balances as a fallback path. The Binance adapter marks expected swap lifecycle transfers, and stale balances are eventually swept if swaps do not complete.

When Binance reports `RW00441`, the account has recently credited deposit value that is not withdrawal-unlocked yet.
The Binance adapter treats this as a retryable wait state and leaves the order pending. The Binance finalizer reads the
adapter's pending-order Redis state and subtracts active Binance rebalance reservations from orphan sweep candidates so
post-swap output balances are not swept while an order is waiting for Binance's deposit unlock confirmations.
Because pending-order Redis sets are keyed by signer account and finalizer withdrawal recipients can be configured
separately, the finalizer checks both configured EVM withdrawal recipients and the running signer account before applying
this shared Binance-account reservation. If Redis cannot be read, the finalizer logs a warning and falls back to the
previous orphan-sweep behavior for that run. If a Redis status set still contains a cloid but the order details have
expired, the finalizer cannot compute a reservation amount and leaves normal orphan sweep accounting unchanged.

## Venue-specific operational note

Hyperliquid spot metadata is currently configured with `pxDecimals=4` for USDT/USDC and prices are truncated to `pxDecimals` when submitting orders. This is a pragmatic setting to avoid tick-size divisibility rejections observed with more granular precision.
