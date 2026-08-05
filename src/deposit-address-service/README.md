# `src/deposit-address-service` — Deposit Address Service

Standalone Express service that receives across-indexer transfer items as **GCP Pub/Sub push**
messages and executes them. Replaces the polling bot in [`../deposit-address`](../deposit-address/),
which is left untouched until cutover.

Why a service rather than a poller: [#3663](https://github.com/across-protocol/relayer/issues/3663) —
one message, one stateless request removes the duplicate-sweep class the poller cannot close.

> **Shell only.** Validation, routing, the Redis lock and durable state, and execution land in later
> PRs. With no handler configured, or `EXECUTION_ENABLED` unset, the service **NACKs every delivery**
> rather than acknowledging it, and `/ready` stays `503` — so nothing is discarded if a subscription is
> attached early.

## Runtime

[`index.ts`](./index.ts) runs directly, not via the repo's bot dispatcher. `scripts/runCommand.sh`
executes `$COMMAND`, so no Dockerfile change:

```
COMMAND="exec node ./dist/src/deposit-address-service/index.js"
```

**The `exec` is required.** `runCommand.sh` runs `$COMMAND` without it, leaving the shell as PID 1 with
Node as its child — and Cloud Run signals PID 1 only. Without `exec`, **Node never gets `SIGTERM` and
the drain below silently does not happen**; the container serves until SIGKILL at +10s.

| Route | Purpose |
| --- | --- |
| `POST /` | Pub/Sub push endpoint. |
| `GET /health` | Liveness. Stays true while draining, so an instance isn't restarted mid-request. |
| `GET /ready` | Readiness. `503` once shutdown begins. |

## ACK / NACK

Pub/Sub reads one thing from the response: **2xx acknowledges, anything else redelivers.** There is no
"permanent failure" status for push, and this service has **no dead-letter topic** — so a non-2xx
retries for as long as the message is retained, with nothing to eject it. That drives every mapping:

| Condition | Status | Why |
| --- | --- | --- |
| Handler succeeded | `204` | Done. |
| Handler threw a `retriable` error | `500` | May clear; let the subscription back off. |
| Handler threw a terminal error | `204` | Redelivery can't help; a non-2xx would retry forever. |
| Undecodable or non-string `data` | `204` | Same reasoning. |
| Unparseable JSON, or body over the 1mb cap | `204` | Caught by error middleware, not Express's bare 4xx. |
| Execution disabled, or no handler configured | `500` | Preserves the message; never discards silently. |
| Not a Pub/Sub push request | `400` | No subscription behind it, so a 4xx can't loop. |
| Draining | `503` | Redelivered to a live instance. |

The decision lives on the error, not the call site: every error in [`errors.ts`](./errors.ts) carries
`retriable`, and an unrecognised throw defaults to retriable. `POST /` has an error boundary because
Express 4 does not handle rejected async route promises — without it an unexpected throw becomes an
unhandled rejection and exits the process, losing everything else in flight.

## Logging

**One line per message**, via `logOutcome` in [`app.ts`](./app.ts) — the only place a message outcome is
logged. Level follows the error's `alert` flag: `alert` ⇒ `error`, which **pages** (PagerDuty is
registered at that level), everything else ⇒ `debug`. Retriable failures are `debug` on purpose, since
Pub/Sub's backoff handles them; the only other lines above it are `uncaughtException` /
`unhandledRejection`. **No typed error sets `alert` today**, so the one path left to a page is an
unrecognised throw.

Two non-obvious constraints, both with regression tests. **The failure block is `failure`, never
`error`** — a key `@risk-labs/logger` collapses to a string. And **`deliveryAttempt` is absent**, since
Pub/Sub only populates it with a dead-letter policy, which is why `messageId` is on every outcome. Uses
the shared `Logger`, not `src/cctp-finalizer`'s console-only instance where `notificationPath` is inert.

## The application deadline

`APPLICATION_DEADLINE_MS` (default **480s**) reaches the handler on its `config` argument, and **the
handler must bound its own work by it** and refuse to broadcast once it has passed:

```
application deadline 480s  <  Cloud Run timeout 540s  <  Pub/Sub ackDeadlineSeconds 600s = lock TTL 600s
```

A Cloud Run 504 at 540s returns to Pub/Sub but **does not stop handler code**, so the guarantee has to
come from the application — which is what makes an un-renewed 600s lock safe. Config rejects a deadline
at or past 540s rather than letting it fail silently.

**`ackDeadlineSeconds` must be set to 600 on the subscription.** For push it doubles as the endpoint
request timeout and **defaults to 10s** — below the application deadline, so leaving it unset means
anything slower than 10s is redelivered while the original still runs. The per-transfer lock stops that
double-executing (the redelivery loses `SET NX`), but it yields a storm of losing attempts and late
ACKs. Subscription config, so nothing here can enforce it.

## Env

| Name | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port. |
| `EXECUTION_ENABLED` | `false` | Master switch for fund-moving work. Must be exactly `"true"`. |
| `APPLICATION_DEADLINE_MS` | `480000` | See above. Rejected at startup if ≥ 540s. |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | `8000` | Rejected if > 10s: Cloud Run SIGKILLs that long after SIGTERM. |

## Development

```bash
PORT=8081 tsx src/deposit-address-service/index.ts
RELAYER_TEST=true yarn hardhat test "test/DepositAddressService*.ts"
```

`DepositAddressService.app.ts` exercises the real Express boundary over real HTTP — binding to port 0 and
using global `fetch`, so no `supertest` dependency. Collaborators go in via `createApp(...)`.

Related: [`../cctp-finalizer`](../cctp-finalizer/) (push-service precedent), [`../messaging/gcp`](../messaging/gcp/).
