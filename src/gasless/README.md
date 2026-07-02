# Gasless relayer

Independent bot that polls the Across gasless API, submits origin-chain deposits from EIP-3009 / Permit2 / ERC-2612 signatures, and (by default) fills them on the destination chain.

Entry point: `index.ts --gaslessRelayer` → `src/gasless/index.ts`.

Full env parsing lives in `GaslessRelayerConfig.ts`. Runtime state machine is in `GaslessRelayer.ts`.

## Core runtime flow

1. **Initialize** — query `API_GASLESS_ENDPOINT`, index recent on-chain deposits/fills, mark already-complete API messages `FILLED`.
2. **Poll** — on `API_POLLING_INTERVAL`, call `_queryGaslessApi`, filter messages, run the per-deposit state machine in `evaluateApiSignatures`.
3. **Per message** — `INITIAL` → validate → `DEPOSIT_SUBMIT` → `DEPOSIT_CONFIRM` → (`FILL_PENDING` →) `FILLED`.

CCTP and swap-and-bridge flows skip destination fills by design. Standard bridge deposits submit a fill unless deposits-only mode is enabled (see below).

Integrator filtering runs inside `_queryGaslessApi` immediately after API responses are restructured — discarded messages never enter the state machine.

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
| `SPOKE_POOL_PERIPHERY_OVERRIDES` | `{}` | Per-chain SpokePool periphery address overrides. |
| `RELAYER_GASLESS_DEPOSIT_USD_PAGE_THRESHOLD` | `1000` | Page-worthy deposit size threshold (stablecoin input); `0` disables. |
| `RELAYER_GASLESS_REFUND_FLOW_TEST_ENABLED` | `false` | Test mode: allow refund-shaped deposits; submit deposit but skip fill. |

### `ENABLE_DEPOSITS_ONLY` (deposits-only mode)

When unset or not `true`, behavior is unchanged.

When `ENABLE_DEPOSITS_ONLY=true`:

- Submit the origin deposit transaction and confirm it on-chain.
- Mark the API message `FILLED` after deposit confirmation.
- **Do not** submit destination fills (`initiateFill` is never called).
- Disable the immediate-fill path (`fillImmediate` returns `false`).
- Skip token-pair and input/output amount validation in `validateDeposit` (fill-side checks do not apply).
- On startup, an observed origin deposit is enough to mark `FILLED` (destination fill not required).

State path: `INITIAL → DEPOSIT_SUBMIT → DEPOSIT_CONFIRM → FILLED`.

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

## Related code

- Message parsing / deposit tx construction: `src/utils/GaslessUtils.ts`
- API types: `src/interfaces/Gasless.ts`
- Tests: `test/GaslessRelayer.ts`, `test/GaslessRelayerConfig.ts`, `test/GaslessUtils.ts`
