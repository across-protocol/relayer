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
