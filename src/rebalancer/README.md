# Rebalancer

The Rebalancer determines when the relayer's inventory should be reshaped across chains and tokens, then executes those cross-asset rebalances through configured venue adapters.

## Rebalancer Clients

The main implementations are defined in `rebalancer.ts`:

- `BaseRebalancerClient` as an abstract mode boundary with shared lifecycle/adapter helpers.
- `ReadOnlyRebalancerClient` for consumers that only need pending rebalance reads.
- `CumulativeBalanceRebalancerClient` for production cumulative balancing.
- `SingleBalanceRebalancerClient` for testing-oriented single-balance behavior.

### Rebalance Routes

Each rebalancer client is instantiated with `RebalanceRoute[]`. A route defines:

- source chain and source token,
- destination chain and destination token,
- adapter name used to execute the swap flow.

Routes are currently hardcoded in `RebalancerClientHelper.ts` and filtered at runtime to routes that are valid for the current config and balances.

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

- **Mode layer** (`CumulativeBalanceRebalancerClient.rebalanceInventory` and `SingleBalanceRebalancerClient.rebalanceInventory`) decides **what** inventory imbalance should be corrected and in what order.
- **Adapter layer** (`RebalancerAdapter` implementations in `src/rebalancer/adapters/`) decides **how** to execute a selected route on a venue.

This separation is intentional:

- Mode logic should stay focused on deficit/excess detection, prioritization, route evaluation, and guardrails.
- Adapter logic should stay focused on venue-specific API calls, order lifecycle handling, and pending-state reporting.
- The contract between both layers is the `RebalancerAdapter` interface plus `RebalanceRoute`.

### Safe extension checklist for new adapters

When adding a new file in `src/rebalancer/adapters/`, contributors should usually avoid touching mode functions in `rebalancer.ts`.

1. Implement the full `RebalancerAdapter` interface in the new adapter file.
2. Register the adapter in `RebalancerClientHelper.ts` (adapter map + route inclusion).
3. Ensure at least one `RebalanceRoute` points to the adapter name.
4. Keep mode logic unchanged unless requirements for deficit/excess selection actually changed.
5. Verify pending-order and pending-rebalance reporting is implemented, since mode guardrails rely on it.

## Rebalancer Config

`RebalancerConfig` is loaded from `REBALANCER_CONFIG` or `REBALANCER_EXTERNAL_CONFIG`.

The config now supports both per-chain targets and cumulative targets:

```json
{
  "targetBalances": {
    "USDT": {
      "1": { "targetBalance": "100", "thresholdBalance": "50", "priorityTier": 1 }
    }
  },
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
- `targetBalances` define chain-specific objectives for `SingleBalanceRebalancerClient.rebalanceInventory()`.
- `cumulativeTargetBalances` define per-token aggregate objectives plus allowed source/destination chain sets for `CumulativeBalanceRebalancerClient.rebalanceInventory()`.
- `cumulativeTargetBalances[token].chains[chainId]` is a chain priority tier used when selecting where to source excess inventory from (lower tier is preferred for sourcing).
- `chainIds` are derived from the union of chains found in `targetBalances` and `cumulativeTargetBalances`.

## Rebalancing Modes

### Chain-specific mode: `SingleBalanceRebalancerClient.rebalanceInventory()`

This is the original path. It is useful for chain-targeted behavior and testing.

High-level flow:

1. Find chain+token excess balances where `current > target`.
2. Find chain+token deficits where `current < threshold`; deficit size is `target - current`.
3. Sort deficits by `priorityTier` (higher first), then larger deficits first.
4. Sort excesses by `priorityTier` (lower first), then larger excesses first.
5. For each deficit, choose the cheapest matching route among eligible excesses, enforce max fee pct, enforce adapter pending-order cap, and initialize rebalance.

### Cumulative mode: `CumulativeBalanceRebalancerClient.rebalanceInventory()`

This is the cumulative-balance path and the default runtime execution via `runCumulativeBalanceRebalancer` in `src/rebalancer/index.ts`.

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

## Creating Rebalancer Instances

Use mode-specific constructors in `RebalancerClientHelper.ts`:

- `constructCumulativeBalanceRebalancerClient()` for operational runs.
- `constructSingleBalanceRebalancerClient()` for testing-oriented runs.

Runtime entrypoints in `src/rebalancer/index.ts`:

- `runCumulativeBalanceRebalancer` (supported operational path).
- `runSingleBalanceRebalancer` (testing-only path).
- Each runner materializes balances from its own config domain:
  - cumulative runner loads from `cumulativeTargetBalances`,
  - single-balance runner loads from `targetBalances`.

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
