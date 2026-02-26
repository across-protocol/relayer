# Inventory vs Rebalancer Responsibilities

## When to read this

Read this before adding any new inventory movement logic. The boundary between same-token transfers and cross-asset swaps is easy to blur.

Related overviews:

- `src/clients/README.md`
- `src/rebalancer/README.md`
- `src/relayer/README.md`

Primary files:

- `src/clients/InventoryClient.ts`
- `src/rebalancer/README.md`
- `src/rebalancer/rebalancer.ts`

## Responsibility split (current state)

### InventoryClient owns

- repayment-chain heuristics for relayer fills
- virtual balance accounting across chains
- shortfall detection for destination fillability
- same-token cross-chain inventory transfers via bridge adapters (`sendTokenCrossChain`)
- local management tasks (native wraps/unwraps, approvals)

In short: move the same economic token across chains and track cross-chain execution state.

### RebalancerClient owns

- cross-asset, cross-chain inventory rebalances (swap source token into destination token)
- route/adapters for exchanges and venues
- pending swap lifecycle and status progression
- deficit/excess pairing logic for target inventories, including cumulative per-token targets

In short: transform token composition, not just token location.

## Why both exist

Relayer operations need two dimensions of inventory control:

1. chain location management (InventoryClient)
2. asset composition management (RebalancerClient)

For equivalent-token fills, location dominates.
For in-protocol swap support, composition dominates and requires RebalancerClient.

## Cross-coupling points

- InventoryClient imports `pendingRebalances` from RebalancerClient and includes them in virtual balance calculations.
- RebalancerClient consumes InventoryClient-derived balances in two forms:
  - chain-local balances (`currentBalances`) used to choose source chains and route amounts,
  - cumulative balances (`cumulativeBalances`) used to detect per-token aggregate deficits/excesses.
- Both modules influence relayer fillability indirectly through available destination liquidity.

This coupling means changes in one module can affect behavior that appears to belong to the other.

## Decision guide for new logic

If your change is mostly:

- moving USDC on chain A to USDC on chain B -> InventoryClient
- turning USDC on chain A into ETH on chain B -> RebalancerClient
- choosing where relayer takes repayment -> InventoryClient
- choosing which asset mix to hold long-term (including cumulative token targets) -> RebalancerClient

If both are involved, split logic by concern and keep interfaces narrow.

## Current legacy overlap and direction

The repository docs already note that some token-transfer behavior in InventoryClient is older and expected to migrate over time toward cleaner separation. Today, InventoryClient still executes same-token bridge transfers while RebalancerClient handles cross-asset routes.

Treat this as "stable but transitional": do not introduce new overlap unless required.

Current default runtime behavior in `src/rebalancer/index.ts` executes cumulative rebalancing (`rebalanceCumulativeInventory`) and keeps chain-targeted rebalancing (`rebalanceInventory`) as an alternate/testing path.

## Anti-patterns

- adding cross-asset swap execution code to InventoryClient
- adding repayment-chain policy logic to RebalancerClient
- duplicating pending-state accounting in both modules
- mixing chain-allocation and token-composition objectives in one heuristic without explicit prioritization

## Contributor recommendations

- Keep transfer-vs-swap boundaries explicit in function names and docs.
- If a feature needs both modules, define a clear orchestration layer rather than embedding cross-calls deeply.
- Update both module docs (`src/clients/README.md`, `src/rebalancer/README.md`) when boundaries shift.
- Add tests that capture boundary behavior, not just isolated unit cases.
