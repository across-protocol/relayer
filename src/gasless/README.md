# Gasless relayer

Independent bot that polls the Across gasless API, submits origin-chain deposits from EIP-3009 / Permit2 / ERC-2612 signatures, and (by default) fills them on the destination chain.

Entry point: `index.ts --gaslessRelayer` → `src/gasless/index.ts`.

Full env parsing lives in `GaslessRelayerConfig.ts`. Runtime state machine is in `GaslessRelayer.ts`.

## Core runtime flow

1. **Initialize** — query `API_GASLESS_ENDPOINT`, index recent on-chain deposits/fills, mark already-complete API messages with a terminal state (`FILLED` or `DONE`).
2. **Poll** — on `API_POLLING_INTERVAL`, call `_queryGaslessApi`, filter messages, run the per-deposit state machine in `evaluateApiSignatures`.
3. **Per message** — `INITIAL` → validate → `DEPOSIT_SUBMIT` → `DEPOSIT_CONFIRM` → (`FILL_PENDING` →) `FILLED` or `DONE`.

CCTP deposits (and swap-and-bridge that uses a non-default `spokePool`) end in `DONE`. Standard bridge deposits submit a fill and end in `FILLED`, unless fills are disabled (see below).

Integrator and address filtering run inside `_queryGaslessApi` immediately after API responses are restructured — discarded messages never enter the state machine.

### Deposit log token resolution (`resolveTokenInfoForLog`)

Before submitting the origin deposit in `GaslessRelayer#initiateDeposit`, the bot formats a Slack-facing log line with the user amount token’s symbol and decimals. For `swapAndBridge`, that token is the signed `swapToken` (often a long-tail asset missing from the static `TOKEN_SYMBOLS_MAP`). Resolution is **log-only** and must never throw: a failure here used to reject `initiateDeposit` and silently drop the deposit before submission (ACB-552).

Lookup order in `GaslessUtils#resolveTokenInfoForLog`:

1. **Static map** — `getTokenInfo` when the token is known.
2. **Redis cache** — key `gasless:tokenInfo:{chainId}:{address}`, TTL 30 days (metadata is immutable). Cache read/write is best-effort; errors fall through to the next step. Entries are accepted only when `decimals` is a finite integer in the ERC-20 `uint8` range (0–255); malformed values (negative, fractional, oversized) trigger a re-probe so they cannot crash `createFormatFunction`.
3. **On-chain ERC-20 probe** — `symbol()` / `decimals()` via the chain provider. Successful, range-valid results are written to Redis.
4. **Placeholder** — if the probe fails, emit a warn (`GaslessUtils#resolveTokenInfoForLog`: “Failed to resolve token info on-chain; using placeholder for log line only”) and use `{ symbol: "UNKNOWN", decimals: 18 }`.

The deposit transaction itself is built from the API message and is unaffected by probe/cache/placeholder outcomes. Production passes the shared Gasless Redis client into the resolver; tests inject a mock cache and/or `probeOnChain`.

### Unsubmittable deposits (`findGaslessSubmitBlocker`)

`DEPOSIT_CONFIRM` returns a deposit it cannot locate on-chain to `DEPOSIT_SUBMIT`, so a deposit the API keeps serving but that can never land is re-attempted every `API_POLLING_INTERVAL` until its authorization expires — potentially for the authorization's full lifetime. `sendAndConfirmTransaction` swallows the simulation revert, so those attempts used to log a bare "Failed to submit gasless deposit" with no reason, indistinguishable from a transient RPC failure.

`GaslessRelayer#_logSubmitFailure` now attaches the revert reason (via `sendAndConfirmTransaction`'s `onError`) and runs `GaslessUtils#findGaslessSubmitBlocker` to name the cause. The reason comes from `describeTransactionFailure`, **not** from the thrown error's message: `submitTransaction` composes that message from `args.join(", ")`, and an integrator-tagged deposit is a raw transaction whose single argument is the entire ABI-encoded calldata, so logging it verbatim would publish the depositor's signed authorization on every poll. Checks run cheapest-first and stop at the first hit:

1. **Signed validity window** — free, no RPC. EIP-3009 `validAfter`/`validBefore` and Permit2 `deadline`, both of which bound the authorization itself. Yields `authorization-expired` (permanent) or `authorization-not-yet-valid`. `getGaslessAuthorizationWindow` normalizes each flow to inclusive bounds first, because the contracts disagree on their boundaries: EIP-3009 requires `validAfter < now < validBefore` (both exclusive), while Permit2 and EIP-2612 reject only `now > deadline` (inclusive). Comparing against the raw signed value would call a Permit2 deposit on its deadline second permanently expired.
2. **Nonce consumption** — `authorizationState` (EIP-3009), `nonceBitmap` (Permit2), `permitNonces` (ERC-2612). A consumed nonce with no located deposit means the authorization was redeemed elsewhere: `authorization-consumed` (permanent).
3. **Depositor balance** — `balanceOf(authorizer)` against `getGaslessRequiredBalance`, which is the witnessed transfer amount plus `submissionFees.amount`: exactly what every periphery entrypoint pulls, and what neither the witness amount alone (omits the fee) nor a Permit2 `permitted.amount` (an upper bound, not the requested transfer) reports. Yields `insufficient-balance` with `balance` / `required` / `shortfall`.
4. **Standing allowance** — ERC-2612 only, and only past `permitApprovalDeadline`. `swapAndBridgeWithPermit` try/catches its `permit` call and pulls with `transferFrom` regardless, so an expired approval blocks the deposit only when no allowance is already in place. Yields `insufficient-allowance`; the deadline alone is deliberately *not* treated as an expiry. Known gap: a permit redeemed externally and then revoked leaves the allowance short while the deadline is still future, and that case goes undiagnosed — a short allowance is the normal pre-permit state, so checking earlier would report a false blocker on every unrelated failure. Closing it needs the signed approval nonce, which the API does not currently send.

`permanent` distinguishes "can never succeed" (spent or expired authorization) from "blocked now, could clear" (an underfunded depositor who tops up in time). Diagnosis is purely observational — it does not change the state machine, so a recoverable deposit still lands if the blocker clears.

Diagnosis runs only when the submission failed *before* broadcast, which `sendAndConfirmTransaction` signals by passing a `TransactionSimulationError` to `onError`. Past that point the reads stop being evidence: a deposit that lands but whose receipt lookup times out also arrives here with no receipt, and the consumed nonce the checks would find is the one our own transaction spent. Those failures warn plainly and leave the verdict to `DEPOSIT_CONFIRM`, which looks for the deposit itself.

Log volume is bounded without losing the signal: a blocker warns on first sighting and whenever the diagnosis changes, and drops to debug while unchanged; a `permanent` blocker also suppresses re-diagnosis, since it cannot clear. Failures with no conclusive blocker keep warning every attempt. The checks are read-only and never throw — an RPC failure returns no blocker rather than masking the underlying error.

## Configuration

### Required

| Variable | Description |
|----------|-------------|
| `API_GASLESS_ENDPOINT` | Gasless API base URL (deposits listing). |
| `RELAYER_TOKEN_SYMBOLS` | JSON array of L1 token symbols this instance handles. |
| `RELAYER_ORIGIN_CHAINS` | JSON array of origin chain IDs. |
| `RELAYER_DESTINATION_CHAINS` | JSON array of destination chain IDs. |

### Common optional

| Variable | Default | Description |
|----------|---------|-------------|
| `API_POLLING_INTERVAL` | `1` | Poll interval in seconds. |
| `MAX_RELAYER_DEPOSIT_LOOKBACK` | `3600` | On-chain event lookback when indexing deposits/fills. |
| `INITIALIZATION_RETRY_ATTEMPTS` | `3` | Retries for the first API query on startup. |
| `GASLESS_ALLOWED_PEGGED_PAIRS` | `{}` | Allowed input→output token symbol pairs (same shape as `PEGGED_TOKEN_PRICES`). |
| `NO_PERMIT2_CONTRACT_CHAINS` | `[]` | Origin chains without canonical Permit2 (skip nonce-bitmap reads). |
| `SPOKE_POOL_PERIPHERY_OVERRIDES` | `{}` | Per-chain SpokePool periphery address overrides. An override must support the `*WithAuthorizationBytes` methods (contracts ≥5.0.26 deployments) — older peripheries revert smart-wallet (>65-byte) authorizations. |
| `RELAYER_GASLESS_DEPOSIT_USD_PAGE_THRESHOLD` | `1000` | Page-worthy deposit size threshold (stablecoin input); `0` disables. |
| `RELAYER_GASLESS_REFUND_FLOW_TEST_ENABLED` | `false` | Test mode: allow refund-shaped deposits; submit deposit but skip fill. |
| `RELAYER_GASLESS_FILLS_ENABLED` | `true` | When `false`, submit origin deposits only (no destination fills). |

### `RELAYER_GASLESS_FILLS_ENABLED` (deposits-only mode)

Default is `true` (fills enabled). Set `RELAYER_GASLESS_FILLS_ENABLED=false` for a deposits-only instance (e.g. GA landing deposits while another bot fills).

When `RELAYER_GASLESS_FILLS_ENABLED=false`:

- Submit the origin deposit transaction and confirm it on-chain.
- Mark the API message `DONE` after deposit confirmation (origin deposit only; no destination fill).
- **Do not** submit destination fills (`initiateFill` is never called).
- Disable the immediate-fill path (`fillImmediate` returns `false`).
- Skip token-pair and input/output amount validation in `validateDeposit` (fill-side checks do not apply).
- On startup, an observed origin deposit is enough to mark `DONE` (destination fill not required).

State path: `INITIAL → DEPOSIT_SUBMIT → DEPOSIT_CONFIRM → DONE`.

`FILLED` is the terminal state when this bot completes a destination fill (standard bridge flow). `DONE` means the relayer finished without filling: CCTP/swapAndBridge (non-default `spokePool`), or `RELAYER_GASLESS_FILLS_ENABLED=false`.

Use this when another relayer or process is responsible for filling, and this bot should only land deposits on the origin chain.

### Integrator ID filters (mutually exclusive)

Filter API messages by `integratorId` (2-byte hex tag on the deposit, e.g. `0xabcd`). IDs are normalized to lowercase `0x` + 4 hex chars before matching; optional `0x` prefix and letter casing are ignored (same rules as `tagIntegratorId` in `GaslessUtils.ts`).

**Only one** of these may be set; setting both causes config construction to throw.

| Variable | Behavior |
|----------|----------|
| `RELAYER_GASLESS_ALLOWED_INTEGRATOR_IDS` | JSON string array. **Only** process deposits whose `integratorId` is in the list. Deposits with a missing `integratorId` are discarded. |
| `RELAYER_GASLESS_BLOCKED_INTEGRATOR_IDS` | JSON string array. **Discard** deposits whose `integratorId` is in the list. Deposits with no `integratorId` are still processed. |

Neither set → no integrator filtering (all API messages proceed to the state machine).

Example allow-list:

```bash
RELAYER_GASLESS_ALLOWED_INTEGRATOR_IDS='["0xabcd","0x1234"]'
```

Example block-list:

```bash
RELAYER_GASLESS_BLOCKED_INTEGRATOR_IDS='["0xdead"]'
```

Filtered-out deposits log at debug: `GaslessRelayer#_queryGaslessApi`.

### Address filters (mutually exclusive)

Filter API messages by authorizer / depositor / recipient. Addresses are normalized to lowercase (`ethers.getAddress` after lowercasing, so mixed-case paste is fine).

**Only one** of these may be set; setting both causes config construction to throw.

| Variable | Behavior |
|----------|----------|
| `RELAYER_GASLESS_ALLOWED_ADDRESSES` | JSON string array. **Only** process deposits whose authorizer or depositor is in the list. |
| `RELAYER_GASLESS_BLOCKED_ADDRESSES` | JSON string array. **Discard** deposits whose authorizer, depositor, or recipient is in the list. |

Neither set → no address filtering.

Example allow-list:

```bash
RELAYER_GASLESS_ALLOWED_ADDRESSES='["0x1111111111111111111111111111111111111111"]'
```

Example block-list:

```bash
RELAYER_GASLESS_BLOCKED_ADDRESSES='["0x2222222222222222222222222222222222222222"]'
```

Invalid addresses cause config construction to throw. Filtered-out deposits log at debug: `GaslessRelayer#_queryGaslessApi`.

## Related code

- Message parsing / deposit tx construction: `src/utils/GaslessUtils.ts`
- API types: `src/interfaces/Gasless.ts`
- Tests: `test/GaslessRelayer.ts`, `test/GaslessRelayerConfig.ts`, `test/GaslessUtils.ts`
