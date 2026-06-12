# Inventory Virtual Balance Model

## When to read this

Read this when a change depends on "inventory" values in the relayer. Most repayment, rebalance, and shortfall decisions use virtual balances, not raw token balances.

Related overviews:

- `src/clients/README.md`
- `src/rebalancer/README.md`

Primary file:

- `src/clients/InventoryClient.ts`

Supporting files:

- `src/clients/TokenClient.ts`
- `src/clients/bridges/CrossChainTransferClient.ts`
- `src/rebalancer/clients/`
- `src/rebalancer/utils/`

## Mental model

InventoryClient tracks a token position across chains as:

- actual on-chain balances
- plus pending inbound transfer credits
- plus pending rebalance credits
- plus pending L2->L1 withdrawal credits (for hub chain)
- minus shortfall obligations (in some calculations)

This gives a "virtual" balance intended to better reflect near-future executable liquidity.

## Core primitives

### `getBalanceOnChain(chainId, l1Token, l2Token?, ignorePending?)`

This is the base virtual-balance primitive. It:

- normalizes values to L1 token decimals
- includes pending L2->L1 withdrawals for hub chain
- includes pending rebalance credits from `ReadOnlyRebalancerClient`
- includes outstanding L1->L2 transfer amounts via CrossChainTransferClient
- returns either per-token (`l2Token`) or aggregate-per-chain balance

### `getCumulativeBalance(l1Token)`

Sums virtual balances over all enabled chains. Used as denominator for allocation percentages.

### `getCurrentAllocationPct(...)`

Computes chain allocation percentage:

- `(chain virtual balance - shortfall?) / cumulative virtual balance`

Shortfall subtraction is configurable by callsite and often used for rebalance decisions.

## Decimal normalization discipline

Inventory comparisons are made in L1-token decimals, even when source data comes from chain-local token decimals. This prevents target/allocation distortions when tokens differ by decimal precision across chains.

## Shortfall as first-class liability

Shortfall comes from `TokenClient.getShortfallTotalRequirement(chainId, l2Token)`.

It is consumed in:

- repayment-chain evaluation (`determineRefundChainId`)
- allocation percentage calculations (`getCurrentAllocationPct`)
- shortfall-first rebalance construction (`_getPossibleShortfallRebalances`)

In practice, shortfall rebalances are prioritized before ordinary inventory rebalances.

## How virtual balances feed repayment-chain choice

`determineRefundChainId()` models post-relay allocation using:

- chain virtual balance
- minus chain shortfall
- plus relay refund effect
- plus upcoming refunds
- cumulative post-refund denominator

Then it compares expected post-relay allocation against configured target buffers.

This means repayment-chain selection is driven by projected post-relay state, not current spot balances.

## How virtual balances feed same-token rebalancing

`getPossibleRebalances()`:

1. computes shortfall rebalances first
2. computes inventory rebalances for chains below threshold
3. filters by available L1 balance at execution time
4. tracks selected transfers in `CrossChainTransferClient`

The tracking step mutates local virtual state (`trackCrossChainTransfer`) before the chain tx confirms, preventing duplicate over-send behavior in the same run.

## Triggering vs sizing: virtual for trigger, liquid-minus-target for transfer

For L1→L2 rebalancing (`rebalanceInventoryIfNeeded`) the trigger and the sizing both use virtual balance — but the `unallocatedBalance` check (`tokenClient.getBalance(hubChain, l1Token)`) ensures we never *issue* more than the relayer has on hub at execution time.

For L2→L1 excess withdrawal (`withdrawExcessBalances`), the same split must be respected at the L2 chain:

- *Trigger* uses virtual balance: `currentAllocPct = getCurrentAllocationPct(l1Token, chainId, l2Token, true, false)`. We want the trigger to be virtual-aware because, in the near future, pending inbound rebalance credits will settle on this chain and we don't want to keep withdrawing every cycle until they do.
- *Sizing* is bounded by what's actually free to leave the chain: `min(desiredWithdrawalAmount, max(0, tokenClient.getBalance(chainId, l2Token) - targetAmount))`. The bridge call (CCTP `depositForBurn`, OFT `send`, op-stack `withdraw`, etc.) ultimately pulls tokens from the relayer EOA at `msg.sender`, so the desired (virtual-derived) amount can exceed what's settled on-chain and revert at simulation with `ERC20: transfer amount exceeds balance`. Clamping straight to liquid balance would solve that, but would drain the chain to zero — the operator wants to rebalance *down to* the target reserve, not below it. Sizing off `liquid - target` does both: the transfer never exceeds settled liquidity, and the chain retains at least its target allocation in liquid form.
- Additionally, `withdrawExcessBalances` skips the entire withdrawal when the chain has any outstanding shortfall (`tokenClient.getShortfallTotalRequirement(chainId, l2Token) > 0`). Pulling liquid back to L1 concurrently with promised fills either starves those fills or undoes a rebalancer that's already moving funds in to cover the shortfall — better to wait for the next cycle once the shortfall is consumed.

If liquid balance is at or below target, the withdrawal is skipped for this cycle; the next cycle will pick it up once pending credits actually settle on-chain and push liquid above the target reserve.

## Interaction with ReadOnlyRebalancerClient

InventoryClient imports pending cross-asset rebalance state (`pendingRebalances`) through the shared rebalancer interface layer in `src/rebalancer/utils/`, commonly provided by `ReadOnlyRebalancerClient`, and treats it as virtual balance adjustments.

This is a key cross-module coupling:

- Mode-specific rebalancer clients drive cross-asset state transitions.
- InventoryClient consumes pending status to avoid double-counting deficits/excesses while swaps are in-flight.
- Read-only mode can initialize with an empty route set and still report pending state because pending aggregation is adapter-backed, not route-dependent.

## Common pitfalls

- confusing actual balance with virtual balance during debugging
- forgetting decimal normalization when comparing values from different chains
- changing shortfall handling in one path but not others
- introducing new pending-state sources without integrating into `getBalanceOnChain()`

## Debugging tips

- use `constructConsideringRebalanceDebugLog()` output to inspect:
  - actual vs virtual per-token balance
  - outstanding transfer credits
  - shortfall values
  - pro-rata distribution share

This log is often the fastest way to diagnose unexpected repayment or rebalance choices.

## Contributor recommendations

- Treat `getBalanceOnChain()` as the single source of truth for virtual balances.
- Prefer adding new virtual-balance adjustments there rather than ad hoc callsite math.
- Keep shortfall treatment explicit per callsite and document whether it is included/excluded.
- Add regression tests when changing pending-transfer or pending-rebalance accounting semantics.
