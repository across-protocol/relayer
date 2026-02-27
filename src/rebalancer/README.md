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

### Rebalancer Adapter

Adapters in `src/rebalancer/adapters/` initiate and progress multi-stage swap workflows. The interface currently is:

```ts
export interface RebalancerAdapter {
  initialize(availableRoutes: RebalanceRoute[]): Promise<void>;
  initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<void>;
  updateRebalanceStatuses(): Promise<void>;
  sweepIntermediateBalances(): Promise<void>;
  getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
  getPendingOrders(): Promise<string[]>;
  getEstimatedCost(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber, debugLog: boolean): Promise<BigNumber>;
}
```

Implemented production swap adapters:

- Binance
- Hyperliquid

`BaseAdapter` persists pending state in Redis so in-flight multi-stage swaps can be resumed and tracked deterministically across runs.

## Mode vs Adapter Architecture

The rebalancer has two independent layers:

- **Mode layer** (`src/rebalancer/clients/`) decides **what** inventory imbalance should be corrected and in what order.
- **Adapter layer** (`RebalancerAdapter` implementations in `src/rebalancer/adapters/`) decides **how** to execute a selected route on a venue.

This separation is intentional:

- Mode logic should stay focused on deficit/excess detection, prioritization, route evaluation, and guardrails.
- Adapter logic should stay focused on venue-specific API calls, order lifecycle handling, and pending-state reporting.
- The contract between both layers is the `RebalancerAdapter` interface plus `RebalanceRoute`.

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
2. Sort cumulative deficits by token `priorityTier` (higher first), then larger deficits first.
3. Sort cumulative excesses by token `priorityTier` (lower first), then larger excesses first.
4. For each excess token used to fill a deficit token, sort source chains from `cumulativeTargetBalances[excessToken].chains` by:
   - chain `priorityTier` ascending,
   - then current chain balance descending.
5. For each candidate source chain, evaluate all destination chains configured for the deficit token that have valid routes, then choose the route with the lowest `getEstimatedCost`.
6. Cap transfer amount by remaining deficit, remaining excess, chain balance, and configured `maxAmountsToTransfer`.
7. Enforce max fee pct and adapter pending-order caps before calling `initializeRebalance`.

Design tradeoff:

- Destination-chain selection evaluates all eligible routes to minimize expected cost. This improves route quality at the expense of additional runtime cost when many routes are configured.

### Read-only mode: `ReadOnlyRebalancerClient`

`ReadOnlyRebalancerClient` is used by consumers that only need pending-state visibility (for example, inventory accounting) and should not initiate new rebalances.

The read-only mode still initializes adapters (with an empty route set) so `getPendingRebalances()` and `getPendingOrders()` remain available without coupling callers to a specific operational rebalancing mode.

### Future mode extensibility

`src/rebalancer/clients/` is intentionally mode-oriented. Today the production mode is cumulative and there is a read-only consumer mode, but additional `RebalancerClient` implementations can be added later without changing adapter contracts.

## Creating Rebalancer Instances

Use the rebalancer construction layer to instantiate mode-specific clients:

- `constructCumulativeBalanceRebalancerClient()` for operational runs.
- `constructReadOnlyRebalancerClient()` for pending-state consumers.

Lifecycle note:

- Constructors wire logger/config/adapters/signer.
- `initialize(rebalanceRoutes)` sets route set and initializes adapters.
- Read-only mode intentionally calls `initialize([])` and still supports `getPendingRebalances()` because pending-state reads do not depend on route selection.

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

## Venue-specific operational note

Hyperliquid spot metadata is currently configured with `pxDecimals=4` for USDT/USDC and prices are truncated to `pxDecimals` when submitting orders. This is a pragmatic setting to avoid tick-size divisibility rejections observed with more granular precision.
