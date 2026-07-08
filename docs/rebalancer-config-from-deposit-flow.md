# Rebalancer Config From Deposit Flow

This guide describes how to tune cumulative rebalancer config when a swap rebalance is primarily intended to replenish
inventory consumed by expected Across deposit fills. Use it when changing `REBALANCER_CONFIG` or generated configurama
outputs for a production relayer.

## Current Behavior

The cumulative rebalancer works from aggregate token balances:

1. A token is in deficit when its cumulative balance is below `thresholdBalance`.
2. The refill amount is `targetBalance - currentBalance`.
3. A token is excess when its cumulative balance is above `targetBalance`.
4. The client pairs deficit and excess tokens, then searches configured routes for a transfer that satisfies the deficit.
5. The chosen transfer is capped by the remaining deficit, remaining excess, source-chain balance, and
   `maxAmountsToTransfer`.

`cumulativeTargetBalances[token].chains` is both an allowlist and a chain-priority map:

- A chain must be present for that token to be eligible as a source or destination.
- Lower numeric priority tiers are preferred when the token is being used as the source of excess inventory.
- Higher numeric priority tiers are preferred when the token is the destination deficit inventory. The client evaluates
  all configured destination chains with valid routes, picks the highest-priority route under `maxFeePct`, and uses the
  cheapest route among ties.

Config can only select from routes generated in `src/rebalancer/buildRebalanceRoutes.ts`. If historical flow lands on a
chain that is absent from `REBALANCE_CHAINS_BY_SYMBOL` for the relevant token, adding that chain to JSON config alone is
not enough.

## Measuring Expected Flow

For a swap rebalance, start with the deposit flow it is meant to replenish. For example, if a `USDT -> USDC` rebalance is
mainly intended to refill USDC used on deposits with input token `USDT` and output token `USDC`, measure that exact fill
class.

Recommended workflow:

1. Pick a lookback window long enough to smooth daily noise, usually 7 to 30 days.
2. Query relayer fill logs for successful fills by the production bot identity.
3. Filter to fills whose input token is the source token and output token is the replenished token.
4. Dedupe retries and repeated log lines by `(originChainId, depositId, destinationChainId)`.
5. Summarize output-token volume by `destinationChainId`; this estimates where the replenished token is consumed.
6. Summarize input-token repayments or realized inventory receipts by repayment chain; this estimates where source
   inventory accumulates.
7. Compare both summaries with `REBALANCE_CHAINS_BY_SYMBOL` and `BINANCE_NETWORKS_BY_SYMBOL` route support.
8. Use Slack rebalancer and relayer reporter messages as a sanity check for incidents, large outlier days, and pending
   rebalance behavior; use GCP fill logs as the primary volume source.

Example GCP starting point:

```bash
gcloud logging read '
jsonPayload.bot-identifier="zion-across-relayer-primary"
jsonPayload.at="Relayer::fillRelay"
timestamp >= "YYYY-MM-DDT00:00:00Z"
timestamp < "YYYY-MM-DDT00:00:00Z"
' --project=bots-across-3839 --format=json
```

The exact token filters depend on the log payload fields available in the relevant deployment. Prefer address filters
when symbols are not normalized across chains.

## Choosing Chains

Choose destination chains from where the output token is historically consumed, plus any intentionally flexible staging
chain.

For example, if most `USDT -> USDC` fills consume USDC on Base and a smaller amount on HyperEVM, then Base and HyperEVM
are natural USDC destinations. Mainnet can also be a deliberate USDC destination even when it is not the dominant final
consumption chain, because Mainnet USDC is highly portable and can be rebalanced onward through many routes.

Avoid broad destination allowlists unless that is intentional. A high destination priority can attract replenishment to a
chain even when a lower-priority route is cheaper.

Choose source chains from where the input token historically accumulates and is supported by route construction. Put the
highest-volume supported repayment chains in lower numeric priority tiers. Low-volume chains can either be omitted or
left in a lower-priority tier if the operator intentionally wants to drain incidental inventory from them.

## Sizing Thresholds and Targets

`thresholdBalance` controls how often a token starts a refill; `targetBalance` controls how much inventory the bot tries
to restore once the threshold is crossed.

For rarer, larger rebalances:

- Lower the threshold relative to the target.
- Keep a target high enough to cover the expected volume between rebalance opportunities.
- Keep `maxPendingOrders` low if venue concurrency costs or operational complexity matter.
- Keep `maxAmountsToTransfer` high enough that it does not split one desired refill into many small orders.

For smoother inventory with more frequent rebalances:

- Raise the threshold closer to the target.
- Use smaller per-order caps if limiting single-route exposure matters.
- Allow more pending orders only if adapters and downstream operators can monitor the added concurrency.

A practical sizing check is:

```text
refill_band = targetBalance - thresholdBalance
expected_days_covered = refill_band / expected_daily_output_token_volume
```

Use average daily volume for normal operations, but also inspect high-volume days. A threshold that looks reasonable on
average can still trigger emergency rebalances if one destination chain regularly has large outlier fills.

## Review Checklist

Before merging a production config change:

1. State the deposit flow being replenished, including input token, output token, relayer identity, and lookback window.
2. Record destination-chain output volume shares.
3. Record source-chain repayment or inventory receipt volume shares.
4. Mark which high-volume chains are unsupported by current route construction and require code changes rather than
   config-only changes.
5. Explain any intentionally flexible staging destinations such as Mainnet USDC.
6. Confirm the target/threshold band matches the desired rebalance frequency.
7. Confirm `maxAmountsToTransfer` and `maxPendingOrders` do not force unnecessary order splitting.
8. After rollout, compare actual rebalances against the forecast and adjust only after enough new fill volume has
   accumulated to avoid chasing one-day noise.
