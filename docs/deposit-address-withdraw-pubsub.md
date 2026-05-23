# Deposit-address withdraw lifecycle — Pub/Sub contract

This document describes the cross-repo Pub/Sub contract between the relayer-v2 `DepositAddressHandler` (publisher, this repo) and the across-indexer's `DepositAddressWithdrawConsumer` (consumer, sibling `indexer` repo).

## Current behavior

### Why the message exists

The across-indexer inserts one `deposit_address_transfer_withdraw` row at classification time with `status = auto_pending` for every bot-eligible refund-bound transfer (mis_route / intent_refund). Without an out-of-band signal, those rows stay `auto_pending` forever — the indexer cannot watch the bot's chain activity, and the bot is the only system that knows when a refund withdraw has confirmed on-chain.

The Pub/Sub topic carries lifecycle events from the bot to the indexer so the row transitions to `executed`.

### Topology

- **Topic host project:** `data-hub-pubsub-3360` (a dedicated GCP project used as the pub/sub hub).
- **Topics:**
  - `topic-deposit-address-withdraw` — production.
  - `topic-deposit-address-withdraw-sandbox` — non-production.
- **Subscriptions** (consumer side, not the bot's concern):
  - `subscription-deposit-address-withdraw-indexer` → indexer pulls in prod.
  - `subscription-deposit-address-withdraw-sandbox-indexer` → indexer pulls in sandbox.
- **Publisher service account:** `cloudrun-bots-across-spoke-sa@bots-across-3839.iam.gserviceaccount.com` — the SA both prod and `-test` bot handlers run as, granted `roles/pubsub.publisher` on both topics. The bot's runtime project (`bots-across-3839`) is therefore **different** from the topic host project; cross-project publish is supported because the IAM grant lives on the topic.
- **No message ordering, no DLT, no Avro schema** — the consumer validates payload shape at the app layer and is poison-pill safe (ack on malformed, nack only on transient DB error).

### Payload

The consumer's validator (`isDepositAddressWithdrawPayload` in `indexer/packages/indexer/src/pubsub/DepositAddressWithdrawConsumer.ts`) accepts two shapes:

```ts
type WithdrawExecutedPayload = {
  type: "withdraw_executed";
  chainId: number;       // withdraw tx chain
  blockNumber: number;   // withdraw tx block
  txHash: string;        // withdraw tx hash, lowercase hex
  logIndex: number;      // logIndex of the ERC20 Transfer leaving the deposit address
  erc20Transfer: {
    chainId: number;
    blockNumber: number;
    txHash: string;
    logIndex: number;
  };
};

type WithdrawFailedPayload = {
  type: "withdraw_failed";
  erc20Transfer: { chainId: number; blockNumber: number; txHash: string; logIndex: number };
  reason: string;
};
```

The bot currently emits **only `withdraw_executed`**. `withdraw_failed` is reserved by the contract but not produced — the bot retries internally on most failure paths and does not track a "retries exhausted" terminal state.

The `erc20Transfer` block is the lookup key the consumer uses to find the row (`(chainId, blockNumber, transactionHash, logIndex)` on the `deposit_address_transfer` table); the top-level fields populate the withdraw-tx columns on the row being transitioned.

The publisher sends the payload as the `data` field of the Pub/Sub message (UTF-8 JSON). No message attributes are used; the consumer ignores them.

### Producer mechanics (this repo)

`DepositAddressHandler._publishWithdrawExecuted` in `src/deposit-address/DepositAddressHandler.ts`:

1. Runs only after a refund withdraw has been confirmed on-chain **and** the depositKey has been persisted to Redis. Ordering matters: we never publish without first committing to "this depositKey is done", which prevents handover from racing the publish into a duplicate withdraw.
2. Filters `receipt.logs` for ERC-20 `Transfer(address,address,uint256)` events whose `address` matches the token contract, whose `from` topic matches the deposit address, AND whose `to` topic matches `routeParams.refundAddress`. The `to` match disambiguates fee-on-transfer / tax / burn tokens that emit several Transfer events from the deposit address in one tx. Picks the **last** match as a final tiebreaker (handles Multicall3-bundled withdraws where intermediate transfers to the same refund address may also appear). Zero matches → warn + skip the publish (do not raise).
3. Builds the payload above and calls `GcpPubSubPublisher.publishJson`.
4. Wraps the call in try/catch; on failure, logs at `error` level with `notificationPath: "across-bot-error"` and continues. The withdraw is on-chain and Redis-persisted — there is no rollback and no in-process retry.

### Consumer mechanics (sibling `indexer` repo)

`DepositAddressWithdrawConsumer.handleMessage`:

- Locates the `DepositAddressTransfer` row by the inbound `erc20Transfer` identifiers; ack + skip if missing.
- Locates the joined `DepositAddressTransferWithdraw` row; ack + skip if missing (classification is the only insert path).
- `withdraw_executed` → sets status `executed`, fills the withdraw-tx columns, clears `metadata.failureReason`.
- `withdraw_failed` → sets status `failed`, sets `metadata.failureReason`, nulls the withdraw-tx columns. **`executed` is sticky in the failed direction** — a `withdraw_failed` against an already-`executed` row is rejected race-safely via a conditional UPDATE.
- Idempotency: replays converge to the same row state. Out-of-order arrival is tolerated because `executed` cannot regress to `failed`.

### Failure modes and trade-offs

| Failure | Bot behavior | Consequence |
| --- | --- | --- |
| GCP publish raises after internal retries | Log + continue. | Indexer row stays `auto_pending`. Ops reconciles manually. |
| Bot crashes between Redis persist and publish | No replay on next start. | Same as above; one dropped event per crash. |
| Receipt missing any Transfer log out of the deposit address | Warn + skip publish. | Indexer row stays `auto_pending`. Withdraw is still on-chain and reflected via the bot's existing log. |
| Indexer message missing `blockNumber` / `logIndex` | Type-system / runtime error. | We treat the fields as required; the indexer API always populates them. A drift would fail loudly rather than silently skip. |

## Contributor recommendations

- **Don't add `withdraw_failed` emission without first defining a terminal-failure model in the bot.** The consumer rejects late `failed`-after-`executed` via the conditional UPDATE, so spurious failed events do not corrupt state — but they do generate noise and false WARN logs on the indexer. If you need failure observability, prefer extending the bot's logging first and only graduate to a Pub/Sub message when there's a clear `executed-or-failed-forever` decision point.
- **Don't rely on ordering.** The consumer handles out-of-order arrivals via last-write-wins + executed-sticky. If you find yourself wanting ordering keys, prefer adding a `decidedAt` timestamp in the payload and resolving precedence on the consumer side.
- **Keep the schema additive.** New fields should be optional on the consumer until the producer rolls out; the producer should default new fields when emitting until both sides ship.
- **Avoid persistent at-least-once delivery on the producer side** unless an ops case forces it. The cost is a new Redis state shape and drainage logic; the benefit is recovering from rare, narrow windows of bot crash. Today's "best-effort + ops reconciliation" is intentionally chosen.
