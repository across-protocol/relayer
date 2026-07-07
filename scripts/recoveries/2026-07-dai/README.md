# DAI wind-down — residual SpokePool balance recovery (July 2026)

Recovers ~248K DAI left on L2 SpokePools as organic DAI activity wound down
chain-by-chain (June–July 2026) **without** final `netSendAmount` sweeps.

Nothing was removed: the `PoolRebalanceRoutes` are live, DAI is still enabled
for LP on the HubPool (`pooledTokens.isEnabled == true`, ~271K DAI
`utilizedReserves`), and the running balances are intact. Pool-rebalance
leaves only carry (chain, token) pairs with activity in the bundle window
(`addLastRunningBalance` seeds from bundle events), so once DAI flow on a
chain stopped, its dormant running balance simply stopped appearing in leaves.
It is carried back in — correctly, on SDK ≥ 4.4.0 — by the next bundle with
DAI activity on that chain, which is exactly what this script's deposits and
slow-fill requests create.

## Residual balances (on-chain, verified 2026-07-07)

| Chain | SpokePool DAI | Last DAI leaf | Tracked running balance |
| --- | --- | --- | --- |
| Base (8453) | 89,018 | 2026-07-07 06:16 UTC | −88,914 |
| zkSync (324) | 70,903 | 2026-06-11 | −898 ⚠️ (see below) |
| Linea (59144) | 42,462 | 2026-06-12 | −42,462 |
| Optimism (10) | 27,191 | 2026-07-01 | −27,191 |
| Arbitrum (42161) | 14,878 | 2026-06-27 | −14,878 |
| Polygon (137) | 3,565 | 2026-07-07 09:31 UTC | −3,565 |

Blast (81457, USDB) is intentionally excluded — still actively tracked and
swept. Boba (288) is already clean.

## Mechanism

Per tranche, `recoverDai.ts`:

1. **Deposits DAI on Ethereum** (`SpokePool.deposit`) with
   `destinationChainId` = the target spoke, `outputToken` = the chain's
   canonical DAI, `outputAmount == inputAmount` (zero relayer fee, so fast
   fills are unprofitable), empty message, no exclusivity, and the maximum
   `fillDeadline` (`quoteTimestamp + fillDeadlineBuffer`, 6h).
2. **Requests a slow fill on the destination** (`SpokePool.requestSlowFill`)
   with relayData rebuilt from the emitted `FundsDeposited` event.

The dataworker then includes the slow fill in the next bundle; the payout
(`inputAmount − DAI LP fee`, LP fee ≈ 0 at current utilization) is paid to the
recipient **from the spoke's stranded DAI**, and the mainnet deposit is swept
to the HubPool via the mainnet pool-rebalance leaf. Net effect per tranche:
the LP pool is made whole on L1; the operator swaps mainnet DAI for L2 DAI.
Bridge the recovered L2 DAI back separately (e.g.
`scripts/withdrawTokenFromL2.ts`) and recycle it.

Precedent: mainnet→Arbitrum tranches of 1,511–2,546 DAI on 2026-06-20/26
(depositor `0x36364Acc…9511`) — 2 slow fills paid, 3 expired and were
refunded on mainnet (no loss; see timing note below).

## Prerequisites — read before running

No config changes are needed: DAI routes and LP status are untouched, and the
recovery's own deposits/slow-fill requests re-seed the (chain, DAI) pairs into
the next bundle's leaves with running balances carried correctly.

1. **zkSync is hard-capped at ~898 DAI.** Its running balance was implicitly
   reset from −70,005.07 to 0 between the bundles executed 2026-03-12
   (`0x56c621c4…52de5c`) and 2026-04-20 (`0x29fd983a…62ea5b`) with no
   `TokensBridged` sweep (pre-SDK-4.4.0 running-balance lookback bug — same
   class as `../2026-06-accounting`; the reset is baked into executed-leaf
   history, so the fixed SDK carries the −898 baseline forward). Slow-filling
   beyond the tracked balance flips the running balance positive and makes
   the Hub send DAI *back* to zkSync. The written-off 70,005.07 DAI needs a
   relayer-refund-root admin recovery (à la `../2026-06-accounting`) instead;
   the `UNTRACKED` constant in the script enforces the cap.
2. The wallet needs mainnet DAI inventory (recycled per tranche) and gas on
   the destination chain for `requestSlowFill`.

## Timing

`fillDeadline` is capped at 6h (`fillDeadlineBuffer`). Within that window the
request must land in a proposed bundle, survive liveness (~1–2h), have roots
relayed to the L2, and be executed by the executor. That usually fits but not
always — 3 of the 5 June tranches expired. If a tranche expires the deposit is
refunded to the depositor on Ethereum in a subsequent bundle: nothing is lost,
re-run the tranche. Best odds: submit shortly before the next proposal is due,
and keep tranches modest (default 2,000 DAI) so a single expiry doesn't tie up
inventory.

## Usage

```sh
# Dry run (no key needed): prints the plan + deposit calldata.
yarn tsx scripts/recoveries/2026-07-dai/recoverDai.ts --to 137 --amount 2000 --dryRun

# Live: deposit on Ethereum, then request the slow fill on the destination.
yarn tsx scripts/recoveries/2026-07-dai/recoverDai.ts --to 137 --amount 2000 --wallet secret

# Final sweep of a chain (amount = spoke balance − untracked portion).
yarn tsx scripts/recoveries/2026-07-dai/recoverDai.ts --to 137 --amount max --wallet secret
```

## Monitoring

- Deposit / fill status: `https://app.across.to/transactions` for the
  depositor, or the indexer DB
  (`relay_hash_info.status`: `slowFillRequested` → `slowFilled`; `refunded`
  means the tranche expired — re-run).
- Spoke drain progress: DAI `balanceOf(SpokePool)` on the target chain, and
  the chain's running balance in subsequent `RootBundleExecuted` leaves
  trending to 0.
