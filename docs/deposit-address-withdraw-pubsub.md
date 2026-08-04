# Deposit-address withdraw lifecycle — Pub/Sub contract

This document describes the cross-repo Pub/Sub contract between the relayer-v2 `DepositAddressHandler` (publisher, this repo) and the across-indexer's `DepositAddressWithdrawConsumer` (consumer, sibling `indexer` repo).

## Current behavior

### Why the message exists

The across-indexer inserts one `deposit_address_transfer_withdraw` row at classification time with `status = auto_pending` for every bot-eligible refund-bound transfer (mis_route / intent_refund). Without an out-of-band signal, those rows stay `auto_pending` forever — the indexer cannot watch the bot's chain activity, and the bot is the only system that knows when a refund withdraw has confirmed on-chain.

The Pub/Sub topic carries lifecycle events from the bot to the indexer so the row transitions to `executed`.

### Topology

- **Topic host project:** `data-hub-pubsub-3360` (a dedicated GCP project used as the pub/sub hub).
- **Topics:**
  - `topic-deposit-address-execution` — production.
  - `topic-deposit-address-execution-sandbox` — non-production.
  - The "execution" naming is intentionally broader than "withdraw" — the same topic is the future home for any deposit-address execution lifecycle event (e.g. `deposit_executed` for the correct-transfer path), even though only `withdraw_executed` is emitted today.
- **Subscriptions** (consumer side, not the bot's concern):
  - `subscription-deposit-address-execution-indexer` → indexer pulls in prod.
  - `subscription-deposit-address-execution-sandbox-indexer` → indexer pulls in sandbox.
- **Publisher service account:** `cloudrun-bots-across-spoke-sa@bots-across-3839.iam.gserviceaccount.com` — the SA both prod and `-test` bot handlers run as, granted `roles/pubsub.publisher` on both topics. The bot's runtime project (`bots-across-3839`) is therefore **different** from the topic host project; cross-project publish is supported because the IAM grant lives on the topic.
- **No message ordering, no DLT, no Avro schema** — the consumer validates payload shape at the app layer and is poison-pill safe (ack on malformed, nack only on transient DB error).

### Payload

Every Pub/Sub message uses a shared envelope: `{ type, data }`. `type` is the message-type discriminator; `data` carries a body whose shape depends on `type`. New message types are added by introducing new `type` values; existing types are versioned by changing the `data` shape and rolling producer + consumer in lockstep.

The consumer's validator (`isDepositAddressWithdrawPayload` in `indexer/packages/indexer/src/pubsub/DepositAddressWithdrawConsumer.ts`) accepts two shapes:

```ts
type WithdrawExecutedPayload = {
  type: "withdraw_executed";
  data: {
    chainId: number;       // withdraw tx chain
    blockNumber: number;   // withdraw tx block
    txHash: string;        // withdraw tx hash, lowercase hex
    logIndex: number;      // logIndex of the ERC20 Transfer leaving the deposit address (native refunds: the Withdraw event)
    erc20Transfer: {
      chainId: number;
      blockNumber: number;
      txHash: string;
      logIndex: number;
    };
  };
};

type WithdrawFailedPayload = {
  type: "withdraw_failed";
  data: {
    erc20Transfer: { chainId: number; blockNumber: number; txHash: string; logIndex: number };
    reason: string;
  };
};

type DepositExecutedPayload = {
  type: "deposit_executed";
  data: {
    chainId: number;       // execute tx chain (= origin chain)
    blockNumber: number;   // execute tx block
    txHash: string;        // execute tx hash, lowercase hex
    logIndex: number;      // logIndex of the input-token Transfer leaving the deposit address
    erc20Transfer: {       // inbound funding transfer (lookup key) — same block as withdraw_executed
      chainId: number;
      blockNumber: number;
      txHash: string;
      logIndex: number;
    };
  };
};
```

The bot emits **`withdraw_executed`** (refund-withdraw paths) and **`deposit_executed`** (successful v3 correct-transfer executions). `deposit_executed` shares the exact `data` shape of `withdraw_executed`; only the `type` discriminator differs. `withdraw_failed` is reserved by the contract but not produced — the bot retries internally on most failure paths and does not track a "retries exhausted" terminal state.

The `data.erc20Transfer` block is the lookup key the consumer uses to find the row (`(chainId, blockNumber, transactionHash, logIndex)` on the `deposit_address_transfer` table); the sibling fields under `data` populate the withdraw-tx columns on the row being transitioned.

The publisher serializes the envelope as a UTF-8 JSON string and sends it as the GCP Pub/Sub message `data` (the transport-level Pub/Sub field — not to be confused with the application-level `data` inside our envelope). No message attributes are used; the consumer ignores them.

### Producer mechanics (this repo)

`DepositAddressHandler._publishWithdrawExecuted` in `src/deposit-address/DepositAddressHandler.ts` (shared by the v1 `initiateWithdraw` and v3 `initiateWithdrawV3` paths — the payload is version-agnostic, only the refund-address field location differs):

1. Runs only after a refund withdraw has been confirmed on-chain **and** the depositKey has been persisted to Redis. Ordering matters: we never publish without first committing to "this depositKey is done", which prevents handover from racing the publish into a duplicate withdraw.
2. Filters `receipt.logs` for ERC-20 `Transfer(address,address,uint256)` events whose `address` matches the token contract, whose `from` topic matches the deposit address, AND whose `to` topic matches the refund address (`routeParams.refundAddress` for v1, `refundAddress.address` for v3). The `to` match disambiguates fee-on-transfer / tax / burn tokens that emit several Transfer events from the deposit address in one tx. Picks the **last** match as a final tiebreaker (handles Multicall3-bundled withdraws where intermediate transfers to the same refund address may also appear). Zero matches → warn + skip the publish (do not raise). **Native-token refunds** (`erc20Transfer.contractAddress` is the native sentinel `0xEeee…EEeE`; v3 scheme only — the v1 path skips native up front) emit no `Transfer` log; the builder instead filters for the `Withdraw(address indexed token, address indexed to, uint256 amount)` event emitted **by the deposit address** (the `WithdrawImplementation` runs via delegatecall) with `token = sentinel` and `to = refundAddress`, same last-match rule.
3. Builds the payload above and calls `GcpPubSubPublisher.publishJson`.
4. Wraps the call in try/catch; on failure, logs at `error` level with `notificationPath: "across-bot-error"` and continues. The withdraw is on-chain and Redis-persisted — there is no rollback and no in-process retry.

`DepositAddressHandler._publishDepositExecuted` (called from `initiateDepositV3` only — v1 and the failure paths are out of scope) mirrors the above:

0. Returns early (no publish) when `ENABLE_EXECUTE_ERC20_TRANSFER_METADATA=true`. In metadata mode the API emits the sweep ↔ funding-transfer link on-chain (a version-2 provenance blob via `AcrossEventEmitter`), so the indexer ingests the execution from chain events and the `deposit_executed` Pub/Sub event would be a redundant second signal. This override takes precedence over `ENABLE_DEPOSIT_ADDRESS_DEPOSIT_PUBLISHER`; the `withdraw_executed` path is unaffected.
1. Runs only after a v3 deposit execute has confirmed on-chain **and** the refTxHash has been persisted to Redis.
2. Filters `receipt.logs` for the input-token (`erc20Transfer.contractAddress`) ERC-20 `Transfer` whose `from` topic matches the deposit address. Unlike the withdraw path there is **no `to` filter** — the input token leaves the deposit address into the SpokePool / CCTP, with no fixed recipient — so any outgoing transfer of the input token qualifies. Picks the **last** match. Zero matches → warn + skip the publish.
3. Builds the `deposit_executed` payload and publishes to the **same topic** as `withdraw_executed`.
4. Same best-effort posture: on failure, log at `error` level and continue; no rollback, no retry.

A single `GcpPubSubPublisher` client serves both event types (same project + topic); it is constructed when **either** gate (`ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER` / `ENABLE_DEPOSIT_ADDRESS_DEPOSIT_PUBLISHER`) is on, and each publish path checks its own flag so the two events toggle independently.

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
| Receipt missing any Transfer log out of the deposit address (or, for native refunds, any `Withdraw` event from it) | Warn + skip publish. | Indexer row stays `auto_pending`. Withdraw is still on-chain and reflected via the bot's existing log. |
| Indexer message missing `blockNumber` / `logIndex` | Type-system / runtime error. | We treat the fields as required; the indexer API always populates them. A drift would fail loudly rather than silently skip. |

## Contributor recommendations

- **Don't add `withdraw_failed` emission without first defining a terminal-failure model in the bot.** The consumer rejects late `failed`-after-`executed` via the conditional UPDATE, so spurious failed events do not corrupt state — but they do generate noise and false WARN logs on the indexer. If you need failure observability, prefer extending the bot's logging first and only graduate to a Pub/Sub message when there's a clear `executed-or-failed-forever` decision point.
- **Don't rely on ordering.** The consumer handles out-of-order arrivals via last-write-wins + executed-sticky. If you find yourself wanting ordering keys, prefer adding a `decidedAt` timestamp in the payload and resolving precedence on the consumer side.
- **Keep the schema additive.** New fields should be optional on the consumer until the producer rolls out; the producer should default new fields when emitting until both sides ship.
- **Avoid persistent at-least-once delivery on the producer side** unless an ops case forces it. The cost is a new Redis state shape and drainage logic; the benefit is recovering from rare, narrow windows of bot crash. Today's "best-effort + ops reconciliation" is intentionally chosen.
