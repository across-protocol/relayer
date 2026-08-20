# `src/deposit-address-service` — Deposit Address Service

Standalone Express service that receives across-indexer transfer items as **GCP Pub/Sub push** messages
and executes them, replacing the polling bot in [`../deposit-address`](../deposit-address/) — which is
left untouched until cutover. Why a service rather than a poller:
[#3663](https://github.com/across-protocol/relayer/issues/3663).

> **Shell only.** The Redis lock, durable state and execution land in later PRs.
> With no handler configured, or `EXECUTION_ENABLED` unset, the service **NACKs every delivery** and
> `/ready` stays `503`, so nothing is discarded if a subscription is attached early.

## Contracts

`decodePushDelivery` validates the Pub/Sub transport contract once and yields a `PushDelivery` — decoded
`payload`, required `messageId`, always-present `attributes` — so nothing downstream optional-chains
transport fields.

`parseTransfer` in [`message.ts`](./message.ts) then validates the **payload** and returns its
`transferId` and route. Pure, no I/O. Not yet wired into a handler — there is nothing to do with the
result until the execution paths land, and a handler that ACKed without executing would discard work.

Handlers take one `RequestContext` (`delivery`, `startedAtMs`, `deadlineAtMs`, `signal`) and are
**constructed once** with logger, config and shared clients closed over. Deliberate: the nonce cache
lives on `TransactionClient`, so a per-request client would turn the accepted nonce race into a certainty.

## Runtime

[`index.ts`](./index.ts) runs directly, not via the repo's bot dispatcher — `scripts/runCommand.sh`
executes `$COMMAND`, so no Dockerfile change:

```
COMMAND="exec node ./dist/src/deposit-address-service/index.js"
```

**The `exec` is required.** `runCommand.sh` runs `$COMMAND` without it, leaving the shell as PID 1 with
Node as its child — and Cloud Run signals PID 1 only. Without `exec`, **Node never gets `SIGTERM` and
the drain below silently does not happen**; the container serves until SIGKILL at +10s.

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
application deadline 480s  <  Cloud Run timeout 540s  <  Pub/Sub ackDeadlineSeconds 600s = lock TTL 600s
```

A Cloud Run 504 does **not** stop handler code, so the guarantee has to come from the application — which
is what makes an un-renewed 600s lock safe.

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
| `APPLICATION_DEADLINE_MS` | `480000` | See above. Must be < 540s. |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | `8000` | Must be < 10s: Cloud Run SIGKILLs that long after SIGTERM. |

Absent values take the default; **present-but-invalid values fail startup** rather than silently
becoming something else.

## Development

```bash
PORT=8081 tsx src/deposit-address-service/index.ts
RELAYER_TEST=true yarn hardhat test "test/DepositAddressService*.ts"
```

`DepositAddressService.app.ts` exercises the real Express boundary over real HTTP — binding to port 0 and
using global `fetch`, so no `supertest` dependency.

Related: [`../cctp-finalizer`](../cctp-finalizer/) (push-service precedent), [`../messaging/gcp`](../messaging/gcp/).
