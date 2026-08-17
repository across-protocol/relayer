# `src/deposit-address-service` — Deposit Address Service

Standalone Express service that receives across-indexer transfer items as **GCP Pub/Sub push** messages
and executes them, replacing the polling bot in [`../deposit-address`](../deposit-address/) — which is
left untouched until cutover. Why a service rather than a poller:
[#3663](https://github.com/across-protocol/relayer/issues/3663).

> **v3 deposits and refund withdrawals execute**, and a withdrawal is announced over Pub/Sub. With no
> handler configured, or `EXECUTION_ENABLED` unset, the service NACKs every delivery and `/ready` stays
> `503`, so nothing is discarded if a subscription is attached early. v1 messages stay with the polling
> bot.

## Contracts

`decodePushDelivery` validates the Pub/Sub transport contract once and yields a `PushDelivery` — decoded
`payload`, required `messageId`, always-present `attributes` — so nothing downstream optional-chains
transport fields.

`parseTransfer` in [`message.ts`](./message.ts) then validates the **payload** and returns its `transferId`
and the message as the indexer stated it. Pure, no I/O.

It deliberately returns **no deposit-vs-withdraw decision**. Naming one there would be a rename —
`correct_transfer` ⇒ "deposit", `mis_route` ⇒ "withdraw" folds in no rules the indexer had not already
stated — and it would also be wrong, because the decision is not knowable that early: a `correct_transfer`
the execute endpoint rejects as below the minimum becomes a refund withdraw. The one thing `parseTransfer`
does decide is that `intent_refund` is not actionable on v3 at all. The honest home for the word is
`BroadcastPendingState.operation`, which records what the transaction being broadcast actually does, at the
point it is known.

[`transferState.ts`](./transferState.ts) holds the two Redis keys per transfer — an expiring `lock:` and a
`state:` that must not expire while a transaction could still land — plus `classifyReceipt`, which reports
what a receipt says and leaves the retry policy to the caller.

Handlers take one `RequestContext` (`delivery`, `startedAtMs`, `deadlineAtMs`, `signal`) and are
**constructed once** with logger, config and shared clients closed over. Deliberate: the nonce cache
lives on `TransactionClient`, so a per-request client would turn the accepted nonce race into a certainty.

## The v3 deposit execute path

[`depositHandler.ts`](./depositHandler.ts) is the handler; [`guards.ts`](./guards.ts) holds the pure
checks and [`pendingTransaction.ts`](./pendingTransaction.ts) resolves a recorded broadcast against the chain.

```
read state → acquire lock → RE-READ state → classification → guards → quote
→ deadline + lock-ownership recheck → broadcast → resolve against chain → record terminal → release lock
```

The **second** state read closes the race between the first read and lock acquisition. The first read is
only a short-circuit for terminal states, which need no exclusion. **Durable state and the lock together
provide correctness**: the lock is what stops two live consumers both passing the guards, since
`broadcast_pending` is only written *after* a broadcast; durable `broadcast_pending` is what stops a later
delivery re-executing a transaction already on the wire.

### Guards — parity with `initiateDepositV3`

| Guard | Kind | Disposition on failure |
| --- | --- | --- |
| Origin chain's family has a v3 path | pure | ACK |
| Origin chain in `RELAYER_ORIGIN_CHAINS` | pure | **NACK** — see below |
| `depositAddressNamespace` **and** `refundAddress.namespace` native to the chain family | pure | ACK |
| `integratorId` matches `^0x[0-9a-fA-F]{4}$` | pure | ACK |
| Funding receipt `blockNumber` matches the message | provider | ACK on mismatch, **NACK when absent** |
| Deposit-address balance ≥ amount | provider | ACK + no state |
| API-derived deposit address == funded address, chain, ecosystem, not placeholder, signature not near expiry | pure | NACK |

`expectedNamespaceForChain`, the integrator regex and the deadline buffer are **re-declared** rather than
imported: they are module-private in `DepositAddressHandler.ts`, which this issue does not modify.

**A disabled chain is not an unsupported chain.** An unsupported *family* is a property of the code, so no
redelivery can change it and it ACKs. A chain merely absent from `RELAYER_ORIGIN_CHAINS` is an operator
switch that may be flipped back, and the funds are still sitting on the deposit address — so it **NACKs**,
because ACKing would destroy the only delivery that could ever sweep them. The polling bot skipped and
revisited the row on its next poll, so ACKing would be a parity regression, not a design choice. Family is
checked **first**: a chain that is both unsupported and unconfigured must ACK, or it would retry every 60s
for the whole retention period over something no operator can fix.

**Guard order is load-bearing.** Canonicality runs *before* the balance check, and an absent funding
receipt NACKs. `getTransactionReceipt` has three outcomes: a mismatched `blockNumber` is unambiguously
non-canonical, but `null` cannot be told apart from our RPC lagging the indexer. Re-reading a receipt is
harmless — unlike re-reading a balance, where the pot is shared and a later read may be an unrelated
transfer's money — so `null` is transient. Ordering it first is what lets the balance guard's ACK mean
"the funds genuinely left" rather than "possibly our node is behind".

This guard is **new**, not parity. The polling bot's balance check claims to cover reorgs
(`DepositAddressHandler.ts:1165`) but cannot distinguish "this funding transfer is real" from "there
happens to be money at this address" — the shared-pot failure this service exists to close.

### The v3 refund withdrawal

`executeWithdraw` serves a `mis_route`, and a `correct_transfer` the execute endpoint rejected as
`AMOUNT_BELOW_MINIMUM` — that rejection is terminal at the API, so the fallback runs immediately, **under
the same lock**, as the polling bot holds its in-flight lock across `initiateWithdrawV3`. No `refund_only`
marker is recorded: a redelivery re-calls `/execute`, gets the same rejection, and falls through again.

Not the deposit path with a different verb, ported guard-for-guard from `initiateWithdrawV3`:

| Guard | Disposition on failure |
| --- | --- |
| `ENABLE_V3_WITHDRAWALS` set | NACK — an operator switch, like a disabled chain |
| `depositAddressNamespace` **and** `refundAddress.namespace` exactly `evm` | ACK — **stricter than the deposit path**; there is no TVM withdraw route |
| withdraw leaf present in `counterfactualMaterials` | ACK — the leaves were fixed at address creation |
| funding transfer canonical, then balance ≥ amount | as the deposit path, same order, same reasons |
| signed `chainId` matches the **refund** chain (`erc20Transfer.chainId` — for a `mis_route` not the route's origin) | NACK |
| signature deadline ≥ now + 60s | NACK |
| sign-withdraw answered **422** | persist `withdraw_failed`, ACK |

The 422 is classified on the HTTP status alone, exactly as production's `_getSignedWithdrawV3` does — the
client posts through `_postOrThrow`, which discards the API's error code, so `withdraw_failed.code` is
optional and unset. Every other sign-withdraw failure NACKs. The refund is gas-deducted
(`deductGasFromRefund: true`), deliberately unlike v1's full-amount refund. Broadcast and reconciliation
are the deposit path's, with `operation: "withdraw"` on the pending record — a confirmed withdraw is not
expected to carry the provenance event, so it does not warn about its absence.

### Announcing a settled withdrawal

A withdrawal leaves **no on-chain provenance event**, so unlike a deposit it has to be announced: the
Pub/Sub `withdraw_executed` message is the only way the indexer learns the refund settled.
[`withdrawLifecycle.ts`](./withdrawLifecycle.ts) reuses `buildWithdrawExecutedPayload` from the polling
bot verbatim, and the `{ type, data }` envelope is locked by the consumer.

The announcement is **durable state, not a step of the request that made it** —
`withdrawLifecyclePublishedAt` on the `withdraw_executed` record. That is what makes a dropped one
recoverable, and it is why the terminal short-circuit is pierced in **both** places (the pre-lock read and
the post-lock re-read): a settled-but-unannounced withdrawal takes the lock and publishes instead of
acknowledging. Piercing one alone would ACK before the retry could happen. Recovery keys on the recorded
state, never on the message's classification — a `correct_transfer` refunded below the minimum owes the
same announcement — and it re-fetches the receipt, because the payload's `logIndex` comes from scanning
`receipt.logs` for the settlement log and cannot be rebuilt from the record.

Resolution and announcement are therefore **one function**, `resolveAndAnnounce`, and no caller invokes the
resolver directly. `resolvePendingTransaction` is the only place `withdraw_executed` is written and its
caller ACKs immediately after, so a resolution that did not announce would be the last delivery that could
ever announce — the same permanent loss, reached from a redelivery that resolves a broadcast whose original
request died rather than from one that found the terminal state already written.

**Publish, then stamp.** The reverse order loses the announcement for good on any failure between the two;
this order can at worst announce twice, which at-least-once delivery already implies. A fresh withdrawal
publishes from what `TransferStore` durably holds rather than from what the request believes it just did,
so the happy path runs the same code a redelivery does — the recovery path being the one that cannot be
exercised in production.

| Outcome | Disposition |
| --- | --- |
| Published | stamp the record, ACK |
| Publish threw | preserve `withdraw_executed` **unstamped**, NACK; the redelivery retries the publication only |
| Receipt carries no settlement log | ACK + `warn`, record left unstamped — the funds moved correctly and no redelivery can conjure a log that is not there |

**No path here re-executes the withdrawal.** The polling bot instead catches, logs at `error` and never
throws, so a dropped publish is never replayed; closing that is the point of publishing from state.

### Broadcasting — why not `sendAndConfirmTransaction`

That helper submits **and** confirms in one call and returns `undefined` with no hash on every failure
path, so the earliest a caller sees a hash is *after* the wait `broadcast_pending` exists to survive.
Instead the path uses the broadcast-only helpers underneath it plus two optional
`AugmentedTransaction` fields (see [`../clients/README.md`](../clients/README.md)):

- **`onBroadcast`** writes `broadcast_pending` the moment a hash exists, before the confirmation wait, and
  again on every hash change — so the record always names the live transaction rather than one the client
  replaced at the same nonce. Its rejections are swallowed by the shared client, deliberately: the
  transaction is on the wire, and losing the record must not lose the transaction.

  **The hash is captured before the write, not after** — the single most load-bearing line ordering in this
  file. Because the shared client swallows the hook's rejection, capturing after a successful write would
  mean a Redis blip silently discarded the hash, `resolvePendingTransaction` was never reached, and a
  *confirmed* sweep went unrecorded — the exact failure this service exists to close. After submission the
  write is retried once, where it is no longer swallowed, but **best-effort**: throwing there would skip
  `recordTerminal`, which supersedes `broadcast_pending` anyway and is the stronger record of the two.
  `DepositAddressService.deposit.ts` pins it — both writes fail, the transaction confirms,
  `deposit_executed` is still recorded.
- **`maxTries: 4`** bounds the wait. The client's default of 10 is `M(M+1)/2` = 55 waits — ~22 minutes on
  mainnet — outliving both the deadline and the lock.

`broadcast_pending` records the hash, the chain and when — no signer, no nonce. **Nonce management is
`TransactionClient`'s job.** Its confirmation wait already refuses to resubmit a consumed nonce, and
re-notifies `onBroadcast` when it replaces a transaction, so the record follows the live hash without this
service reasoning about nonces at all.

### Resolving a pending transaction — the outcome comes from the chain

`submit()` catches `_submit`'s throw, deletes its nonce cache and returns an empty array, which
`submitTransaction` turns into a generic `Error` — so revert, exhausted `maxTries` and RPC failure are
indistinguishable. There is nothing to switch on, so `resolvePendingTransaction` reads the chain instead,
and the same function serves a redelivery that finds a pending record. It **returns only when the
transaction confirmed** and throws a typed error for every other outcome, so the retry decision travels
with the error rather than being re-derived by each caller.

| Observation | Action |
| --- | --- |
| Receipt, success | record `deposit_executed`, ACK |
| Receipt, `status === 0` | clear `broadcast_pending`, NACK |
| No receipt | **retain** `broadcast_pending`, NACK |

**A revert is the only case that clears anything**, because a reverted transaction provably moved nothing.
"No receipt" is a statement about our knowledge, not the transaction: it may be unmined, dropped, replaced
at its nonce, already mined behind a lagging RPC node, or reorged out. Those five are treated identically
on purpose — retaining is safe in all of them, clearing is unrecoverable in some, and no observable evidence
separates them cheaply. Trying to split the bucket by reading nonces would duplicate `TransactionClient`'s
own bookkeeping to recover one narrow case (a worker that died mid-confirm during a nonce collision) at the
price of a chain-family gate that clears a *live* record whenever it is wrong.

The residual: that transfer stays blocked until an operator clears the key. See the issue's Scope.

Hashes are stored verbatim and `0x`-prefixed at lookup, since TronWeb reports an un-prefixed `txid`.

### Metadata is mandatory

The `/execute` request **always** carries `erc20Transfer`; the polling bot's
`ENABLE_EXECUTE_ERC20_TRANSFER_METADATA` gate does not exist here. The service **never publishes**
`deposit_executed` — the indexer ingests the on-chain provenance event instead. A confirmed receipt
missing the `MetadataEmitted` topic is a `warn` and **never** a cause of re-execution: the funds have
already moved. There is no pre-submission log scan for that event; see the issue's Scope.

## Runtime

[`index.ts`](./index.ts) runs directly, not via the repo's bot dispatcher — `scripts/runCommand.sh`
executes `$COMMAND`, so no Dockerfile change:

```
COMMAND="exec node ./dist/src/deposit-address-service/index.js --wallet gckms --keys <key-name>"
```

**The `exec` is required.** `runCommand.sh` runs `$COMMAND` without it, leaving the shell as PID 1 with
Node as its child — and Cloud Run signals PID 1 only. Without `exec`, **Node never gets `SIGTERM` and
the drain below silently does not happen**; the container serves until SIGKILL at +10s.

`--wallet` / `--keys` follow the repo's existing convention and feed `getSigner`, with
`getDispatcherKeys()` falling back to `DISPATCHER_KEYS` when no argument is given. Signer, Redis and the
quote-api client are all built **before `listen()`**, so a missing key or an unreachable Redis fails
startup rather than answering `500` to every delivery.

`POST /` is the push endpoint. `GET /health` is liveness and stays true while draining, so an instance
is not restarted mid-request; `GET /ready` goes `503` once shutdown begins or execution is unavailable.

## ACK / NACK

Pub/Sub reads one thing from the response: **2xx acknowledges, anything else redelivers.** There is no
"permanent failure" status for push, and this service has **no dead-letter topic** — so a non-2xx retries
for as long as the message is retained. That drives every mapping:

| Condition | Status | Why |
| --- | --- | --- |
| Handler succeeded | `204` | Done. |
| Handler threw a `retriable` error | `500` | May clear; let the subscription back off. |
| Handler threw a terminal error | `204` | Redelivery can't help; a non-2xx would retry forever. |
| Lock held by another consumer | `500` | It finishes or its lock expires; either way a later delivery proceeds. |
| Sign-withdraw answered 422 | `204` | Terminal per product decision; recorded as `withdraw_failed` first. |
| Withdrawal settled but its announcement failed | `500` | The refund is done; the redelivery retries the publication alone. |
| Fails the transport contract (no decodable `data`, no `messageId`) | `204` | Same reasoning. |
| Unparseable JSON, or body over the 1mb cap | `204` | Body-parser errors only; anything else NACKs. |
| Execution disabled, or no handler configured | `500` | Preserves the message; never discards silently. |
| Not a Pub/Sub push request | `400` | No subscription behind it, so a 4xx can't loop. |
| Draining | `503` | Redelivered to a live instance. |

The decision lives on the error, not the call site: every error in [`errors.ts`](./errors.ts) carries
`retriable`, and an unrecognised throw defaults to retriable. `POST /` has an error boundary because
Express 4 does not handle rejected async route promises — without it an unexpected throw exits the
process, losing everything else in flight.

## Logging

**One line per message**, via `logOutcome` in [`app.ts`](./app.ts) — the only place a message outcome is
logged. Level follows the error's `alert` flag: `alert` ⇒ `error`, which **pages** (PagerDuty is
registered at that level), everything else ⇒ `debug`. Retriable failures are `debug` on purpose, since
Pub/Sub's backoff handles them; the only other lines above it are `uncaughtException` /
`unhandledRejection`. **No typed error sets `alert` today**, so the one path left to a page is an
unrecognised throw.

Three constraints, all with regression tests. **The failure block is `failure`, never `error`** — a key
`@risk-labs/logger` collapses to a string. **`deliveryAttempt` is absent**, since Pub/Sub only populates
it with a dead-letter policy, which is why `messageId` is on every outcome. And **handler fields are
spread first**, so delivery identity and the canonical keys win a collision. Uses the shared `Logger`,
not `src/cctp-finalizer`'s console-only instance where `notificationPath` is inert.

## The application deadline

`APPLICATION_DEADLINE_MS` (default **480s**) becomes an **absolute** `deadlineAtMs` plus an
`AbortSignal` on the request context, created once at the boundary. Call `assertBeforeDeadline(context)`
immediately before broadcasting. The chain the design relies on:

```
application deadline 480s  <  Cloud Run timeout 540s  <  Pub/Sub ackDeadlineSeconds 600s  <  lock TTL 900s
```

A Cloud Run 504 does **not** stop handler code, so the guarantee has to come from the application — which
is what makes an un-renewed lock safe.

**The deadline check alone is not sufficient**, and this is the one place that ordering matters more than
it looks. `assertBeforeDeadline` bounds when a broadcast *begins*; the confirmation wait runs after it, up
to ~240s at `maxTries: 4`. A broadcast starting at t=479s therefore confirms until t≈719s. So the lock TTL
has to cover both, and the relation is asserted between config values at startup rather than left as a
comment:

```
lockTtlMs >= applicationDeadlineMs + confirmBudgetMs      # 900 >= 480 + 300
```

That makes the TTL deliberately **larger** than the 600s ack deadline (Pub/Sub's maximum). A redelivery
arriving as Cloud Run 504s finds the lock still held, NACKs on contention and backs off; by the time it
returns the original has written terminal state, so it ACKs. The cost is that a genuinely dead consumer
blocks a transfer for 900s rather than 600s — which is what the lock TTL is for.

### Required platform configuration

**Every platform default below breaks that chain.** None of them can be validated from inside the
process, so they have to be set deliberately when the service is provisioned:

| Setting | Platform default | Required | If left at the default |
| --- | --- | --- | --- |
| Cloud Run request timeout | **300s** | `540s` | Handlers running 300–480s get a 504 and a redelivery while the original request keeps running. |
| Pub/Sub `ackDeadlineSeconds` | **10s** | `600s` | For push this is also the endpoint request timeout, so anything slower than 10s is redelivered mid-flight. |
| Cloud Run SIGKILL grace | 10s (fixed) | — | Not configurable; `SHUTDOWN_DRAIN_TIMEOUT_MS` is bounded below it instead. |

A mid-flight redelivery does not double-execute — the per-transfer lock means the redelivery loses
`SET NX` and NACKs — but it produces a storm of losing attempts and late ACKs Pub/Sub may reject. Note
`APPLICATION_DEADLINE_MS` is validated against 540s, which **assumes** the request timeout was raised;
the config cannot tell whether it actually was.

## Env

| Name | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port. |
| `EXECUTION_ENABLED` | `false` | Master switch for fund-moving work. Must be exactly `"true"`. |
| `ENABLE_V3_WITHDRAWALS` | `false` | Gates the refund-withdraw path independently. **The same variable the polling bot reads.** Disabled withdraws NACK. |
| `APPLICATION_DEADLINE_MS` | `480000` | See above. Must be < 540s. |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | `8000` | Must be < 10s: Cloud Run SIGKILLs that long after SIGTERM. |
| `CONFIRMATION_TRIES` | `4` | `AugmentedTransaction.maxTries`. Capped at the client's own default of 10, which would be ~22 min. |
| `CONFIRM_BUDGET_MS` | `300000` | Time reserved for the confirmation after the deadline check; only used to assert the lock-TTL relation above. |
| `RELAYER_ORIGIN_CHAINS` | `[]` | Origin chains to execute on. **The same variable the polling bot reads**, so both can run during migration without new config. |
| `ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER` | `false` | Gates announcing settled withdrawals. **The polling bot's variable.** Off leaves records unstamped, so turning it on lets a redelivery announce after the fact. `ENABLE_DEPOSIT_ADDRESS_DEPOSIT_PUBLISHER` is dead config here. |
| `PUBSUB_GCP_PROJECT_ID` | — | Project hosting the topic. Required when the publisher gate is on; startup fails otherwise. |
| `PUBSUB_DEPOSIT_ADDRESS_WITHDRAW_TOPIC` | — | Short topic name. Required when the publisher gate is on. |
| `SWAP_API_KEY` | — | Required; startup fails without it. |
| `API_TIMEOUT_OVERRIDE` | `3000` | quote-api timeout, ms. |

Absent values take the default; **present-but-invalid values fail startup** rather than silently
becoming something else. Redis is required — the lock and durable state are the correctness argument, so a
`getRedisCache` that answers `undefined` fails startup rather than degrading.

## Development

```bash
PORT=8081 tsx src/deposit-address-service/index.ts
RELAYER_TEST=true yarn hardhat test "test/DepositAddressService*.ts"
```

`DepositAddressService.app.ts` and `DepositAddressService.deposit.ts` exercise the real Express boundary
over real HTTP — binding to port 0 and using global `fetch`, so no `supertest` dependency. The deposit
suite fakes only the chain, the quote-api and the submission client, and asserts the **queue disposition
alongside the state left in Redis**, since those two together are what stop a transfer being swept twice.
Its fake client invokes `onBroadcast` exactly where the real one does, so the seam the design depends on is
tested rather than approximated. `DepositAddressService.guards.ts` needs no fakes at all.

Related: [`../cctp-finalizer`](../cctp-finalizer/) (push-service precedent), [`../messaging/gcp`](../messaging/gcp/).
