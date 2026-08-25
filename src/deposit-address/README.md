# `src/deposit-address` — Deposit Address Handler

The deposit-address handler polls the across-indexer for ERC-20 transfers that have landed on counterfactual deposit addresses and either executes them as deposits or refunds them back to the user.

## Runtime entrypoint

`runDepositAddressHandler` in [`index.ts`](./index.ts) wires up:

1. `DepositAddressHandlerConfig` from env.
2. Dispatcher keys for transaction signing.
3. `DepositAddressHandler` instance, then `initialize()`.
4. Background polling loop (`pollAndExecute`) on the configured interval. This also starts a
   watchdog heartbeat (`kickWatchdog`) on its own interval (`WATCHDOG_INTERVAL`, default 15s),
   scheduled via `scheduleTask` against the handler's abort signal — the same pattern the relayer
   uses for its periodic address-filter refresh. Each tick GETs `DEPOSIT_BOT_HEARTBEAT_URL`
   (unset = disabled) as a dead-man's switch: with a Checkly period of 30s + grace of 30s, a dead
   bot trips the alert within ~60s. Pings are best-effort (failures never disrupt the bot, 5s cap
   per request), but every 10th consecutive failure — including non-2xx responses — emits a
   warning log to aid diagnosis when the alert fires. Pings stop on handover/shutdown with the
   rest of the handler.
5. Handover via Redis (`InstanceCoordinator`) — exits cleanly when another instance takes over.

Poll-loop failures are never silent: `pollAndExecute` passes an error handler to `scheduleTask`, so
a rejected `evaluateDepositAddresses` tick (which skips that whole batch) is logged at error level
instead of being swallowed by the scheduler.

Cleanup in the `finally` block closes the Pub/Sub publisher and Redis clients.

## Indexer message classification

The indexer tags each ERC-20 transfer with a `transferClassification`:

| Classification | Path |
| --- | --- |
| `correct_transfer` | Deposit path — execute the funded deposit on the origin chain. |
| `mis_route` | Refund-withdraw path — return funds to the user via the signed-withdraw flow. |
| `intent_refund` | Refund-withdraw path — same flow as `mis_route`. |
| anything else | Dropped (forward-compat). |

The deposit path is always active. The v1 refund-withdraw path is gated by `WITHDRAW_ENABLED`; the v3 refund-withdraw path is gated independently by `ENABLE_V3_WITHDRAWALS` (must be exactly `"true"`).

Each message also carries a top-level `version` that selects the execution scheme:

| Version | Path |
| --- | --- |
| absent / `1` | Legacy v1 scheme — normalized via `normalizeDepositAddressMessage`, then dispatched on classification as above. |
| `3` | Upgradeable-counterfactual scheme — `correct_transfer` goes to the v3 execute path (below), except when the execute endpoint has already rejected it as below the minimum deposit, in which case it is routed to the v3 refund-withdraw path instead; `mis_route` and `intent_refund` go to the v3 refund-withdraw path (below) when `ENABLE_V3_WITHDRAWALS=true`; other classifications are dropped. |
| anything else (e.g. `2`) | Dropped (debug-logged) before normalization, since unsupported payloads may not carry a shape the normalizer can dereference. |

**Native-token transfers.** The indexer detects native transfers to deposit addresses via traces
and synthesizes them into the same message shape: `erc20Transfer.contractAddress` carries the
native sentinel `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` (`NATIVE_ASSET` in the counterfactual
contracts) and `logIndex` is synthetic. Native never matches a route's input token, so these
messages always classify `mis_route` / `intent_refund` and enter the refund-withdraw paths, never
the deposit-execute paths. Native withdraws are supported **only on the v3 scheme**: v3's
`WithdrawImplementation` sends native via `call` when `token == NATIVE_ASSET`, so the v3 withdraw
path relays the sentinel verbatim to the sign-withdraw endpoint. The v1 withdraw contract path
cannot move native funds, so the v1 path skips sentinel messages up front (debug log, no API call).
The bot handles the sentinel in two further places: on-chain balance checks go through
`getDepositAddressBalance`, which reads `provider.getBalance(depositAddress)` for the sentinel
(there is no contract at that address — `balanceOf` reverts) and ERC-20 `balanceOf` otherwise; and
the Pub/Sub payload builder matches a different settlement log (see below).

Normalization itself is guarded per message: a supported-version payload that still fails
`normalizeDepositAddressMessage` (malformed shape) is dropped with a warn — never allowed to sink
the rest of the batch. `counterfactualMaterials` may legitimately be absent on v1 messages (deposit
addresses predating the indexer's V2-materials backfill are served with `undefined` materials);
normalization passes the absence through and the withdraw path guards on the leaf downstream.

## v3 execute flow (thin submitter)

For `version: 3` messages the bot is a **thin submitter** of API-built calldata. The quote-api
execute endpoint (`POST /deposit-addresses/execute`, bearer-authed with the same `SWAP_API_KEY`)
re-derives the deposit address and all counterfactual merkle materials server-side from the
identity (`destination.token`, `destination.recipient`, `userAddress`); the bot relays funding
context only — origin chain, swept `depositAddress`, funding `inputToken`, amount, destination
route, refund identity — plus its own `executionFeeRecipient` and the `integratorId` the address
was derived with. `executionFee` is currently omitted (the API defaults it to 0); bot-side fee
pricing is a follow-up task.

The `integratorId` (2-byte hex) is sourced from the indexer message's `integrator` projection (a
property of the deposit address, not the bot's auth key) and is **required** by the execute
endpoint — it folds into the CREATE2 salt + on-chain integrator tag, so the address is derived
per-integrator. The bot relays it verbatim.

Two origin-side fields are always sent, both relayed verbatim from the indexer message:

- `depositAddress` — the funded address being swept (`depositAddress` on the v3 item). The API
  resolves which contract generation the address belongs to from this, instead of assuming the
  latest.
- `inputToken` — the funding token as `{ chainId, address }` (`erc20Transfer.contractAddress`).
  Without it the API falls back to origin-native USDC, which mis-routes non-USDC sweeps.

Neither is gated: every API deployment accepts them (older contract generations parse and ignore
them), so one bot build is safe against every environment.

One optional field remains behind an env flag, because an API that predates its schema change
rejects an unknown param with `400 INVALID_PARAM`:

- `ENABLE_EXECUTE_ERC20_TRANSFER_METADATA=true` → relays an `erc20Transfer` provenance reference
  (`{ chainId, blockNumber, transactionHash, logIndex }` of the inbound funding transfer, taken
  verbatim from the indexer message; `chainId` coerced to an integer). When accepted, the API wraps
  `executeTx` in a Multicall3 bundle that additionally emits a version-2 provenance blob via
  `AcrossEventEmitter`, giving the indexer an on-chain sweep ↔ funding-transfer link in the execute
  receipt.

Defaults off; enable it only against an API that accepts the field (e.g. the test bot ahead of
the production rollout).

The flow (`initiateDepositV3`):

1. Filter on `relayerOriginChains` and dedup against the same Redis/in-memory sets as v1 (the dedup
   scheme is keyed on `erc20Transfer.transactionHash` / `depositKey`, shared across versions).
2. Skip when `depositAddressNamespace` / `refundAddress.namespace` don't match the origin chain's
   family (`evm` ⇒ EVM chains, `tron` ⇒ Tron; other families, and cross-family anomalies like a
   `tron` namespace on an EVM chainId, are skipped with a warn).
3. Skip when the `integrator.integratorId` is absent or not 2-byte hex (warned, no API call) —
   mirrors the namespace guard. No funded v3 addresses exist pre-integrator, so a missing/malformed
   id is a data anomaly; sending it would only derive a different, unfunded address.
4. Defensive on-chain balance check, as on the other paths.
5. Fetch `{ executeTx: { to, data, value }, ... }` from the execute endpoint. The calldata wraps
   `factory.deployIfNeededAndExecute`, so there is **no bot-side deploy step** and the bot needn't
   know deploy state.
6. Validate the response before submitting: the API-derived `depositAddress` must match the funded
   address from the indexer (mismatch would execute at a different address), `executeTx.chainId`
   must match the origin chain, `isPlaceholder` must be false, and `signatureDeadline` must have
   ≥60s of headroom. The calldata embeds a deadline-bounded signature — it is perishable, and on
   any failure the next poll **re-requests fresh calldata; stale payloads are never patched**.
7. Sign and submit via `TransactionClient` (gas, nonce, rebroadcast), then persist the tx hash to
   Redis exactly like v1.
8. Publish a `deposit_executed` lifecycle event to GCP Pub/Sub (if `ENABLE_DEPOSIT_ADDRESS_DEPOSIT_PUBLISHER=true`).

**Terminally-rejected executes are refunded, not retried.** Two execute error codes are terminal
(`TERMINAL_EXECUTE_ERROR_CODES`): `AMOUNT_BELOW_MINIMUM` (422 — amount under the minimum deposit) and
`AMOUNT_TEMPORARILY_UNSWEEPABLE` (400 — the live CCTP fee exceeds the on-chain fee cap at this
amount, or the execution fee eats the whole amount). The amount is whatever landed on the deposit
address, so no retry can change the outcome: `_getExecuteTx` stops retrying, records the `depositKey`
in the refund-only set (below), and `initiateDepositV3` hands the transfer to `initiateWithdrawV3` in
the same tick — the funds go back to the committed refund address instead of sitting on the deposit
address. Later polls route straight to the withdraw path from the persisted marker, so the execute
endpoint is never asked again. Three consequences worth knowing:

- Treating the unsweepable **400** as terminal deliberately deviates from the quote-api's documented
  "400 = retry" contract: the fee would have to drop far below the cap to ever clear, and unbounded
  retry parks user funds (a real 1 USDC mainnet deposit retried for 5+ minutes until manual refund).
  The accepted cost is that a brief fee spike converts a sweepable deposit into a gas-deducted refund.
- The refund obeys `ENABLE_V3_WITHDRAWALS`. With the gate off the marker still lands (so the API is
  no longer hammered) but nothing is refunded until the gate is on.
- A terminally-rejected amount is small, and the v3 withdraw deducts gas from the refund, so the
  sign-withdraw call can itself return a terminal `GAS_EXCEEDS_REFUND` 422. That converges correctly:
  both markers are persisted, the bot stops making API calls for the transfer, a `withdraw_failed`
  event flips the indexer row to `failed` (user sees `refund-failed`), and the funds stay put for
  manual handling.

The bot classifies on the error **code**, not the status, so the guard survives a status change on
the API side. Seeing the code at all requires `_postOrThrowWithErrorCode` in
[`AcrossApiBaseClient`](../clients/AcrossApiBaseClient.ts): the SDK's fetch helper only reads an
`error` key, which Across API error bodies never set, so a 422 otherwise arrives as
`HTTP 422: Unprocessable Entity` with the code discarded.

The resulting `withdraw_executed` event is published as usual, but the indexer's consumer currently
drops it for a `correct_transfer` row — no `DepositAddressTransferWithdraw` row exists, since
classification is its only insert path. Funds reach the user on-chain; the row keeps no
`depositRefundTxnRef` until the indexer counterpart ships.

The v3 message's `counterfactualMaterials`/`initialRoot`/`salt` are relayed by the indexer but not
read by the execute path — the API re-derives them, so they are carried for diagnostics only.

**Tron origins.** The v3 execute path also supports Tron-funded deposit addresses
(`depositAddressNamespace: "tron"`). No dedicated gate: Tron activates by adding its chainId
(728126428) to `RELAYER_ORIGIN_CHAINS`, which also provisions the provider and dedup sets. v3
messages stay un-normalized, so Tron fields flow **base58 end-to-end to the quote-api**
(`userAddress`, `depositAddress`, `inputToken.address`; the bot re-encodes its own
`executionFeeRecipient` to base58 via `toAddressType`). The API responds with
`executeTx.ecosystem: "tvm"`, a **0x-hex `to`** (the
RPC-facing format), and the `depositAddress` echoed in base58; the bot validates the ecosystem
against the chain family and compares deposit addresses canonically (base58 → hex) since base58 is
case-sensitive. On-chain reads (`getDepositAddressBalance`) and receipt-log matching
(`buildDepositExecutedPayload`) convert base58 → 0x-hex via `getEthersCompatibleAddress` because
Tron providers speak eth-JSON-RPC. Submission reuses the existing TVM path in `TransactionClient`
(`_runTransactionTvm`, raw calldata, TRX `feeLimit`); the bot signer's key doubles as its Tron
account, which must hold TRX for fees. Tron refund-withdraws remain unsupported (the v3 withdraw
path is still EVM-only).

## v3 refund-withdraw flow

For `version: 3` `mis_route` and `intent_refund` messages, when `ENABLE_V3_WITHDRAWALS=true`, the
bot refunds the stranded funds back to the committed refund address. (An expired intent is refunded
on-chain to the deposit address itself — the SpokePool depositor — so it needs the same second hop
out to the refund address as a mis_route.) The flow (`initiateWithdrawV3`) mirrors v1
`initiateWithdraw` with v3-specific guards:

1. Gate on `enableV3Withdrawals`, filter on `relayerOriginChains` (refund chain = `erc20Transfer.chainId`),
   and dedup against the shared withdraw sets (`executedWithdrawKeys`, in-flight `observedExecutedWithdraws`,
   and the v3 terminal-skip set below).
2. Skip non-`evm` `depositAddressNamespace` / `refundAddress.namespace` (the withdraw user must be EVM).
3. Locate the withdraw leaf in `counterfactualMaterials` (`kind === "withdraw"`); skip if its
   `merkleProof` / `implementationAddress` are missing.
4. Defensive on-chain balance check, as on the other paths.
5. Fetch `{ signedWithdrawTx: { to, data, value, chainId }, deadline, requestedAmount, appliedGasFee, netAmount, bundledDeploy }`
   from `POST /deposit-addresses/sign-withdraw`. Unlike v1, **gas is deducted from the refund**
   (`deductGasFromRefund: true`) so refunds are not operated at a loss — except for `intent_refund`,
   which sends `false`: nobody filled the intent, so the user is refunded in full at our expense.
   The endpoint **verifies** the supplied CDA materials (never re-derives the address) and bundles
   the v3 BeaconProxy `deploy(salt, initialRoot)` + `signedWithdrawToUser` into one Multicall3 call
   when the proxy is not yet on-chain.
6. Validate the response: `signedWithdrawTx.chainId` must match the refund chain and the embedded
   signature's `deadline` must have ≥60s headroom (perishable; re-requested fresh on the next poll).
7. Submit via `TransactionClient`, persist the depositKey, and publish `withdraw_executed` (same gate
   + topic + payload as v1; the payload reads `refundAddress.address` for v3).

**Terminal 422 handling.** The endpoint rejects with 422 when gas can't be deducted —
`GAS_EXCEEDS_REFUND` (fee ≥ refund, typically dust) or `UNPRICEABLE_REFUND_TOKEN` (no market price).
A 422 is treated as **terminal**: the bot does not submit and **does not retry on later polls**. A
`withdraw_failed` event carrying the API's error code as `reason` is published first (so the indexer
row flips to `failed` instead of stranding at `auto_pending`), then the depositKey is persisted to a
dedicated skip set (below) so the decision survives handover. Every other failure (network, timeout,
5xx, transient 400 incl. `GAS_FEE_TEMPORARILY_UNAVAILABLE`) is retried, then skipped for the current
poll and re-attempted on the next. Surfacing the 422 requires the non-swallowing
`_postOrThrowWithErrorCode` base-client method (`_post` collapses errors to `undefined`); the bot
classifies on the `HttpError.status` and forwards the body's `code` as the published reason.

## Execution fee (deposit-execute path)

The swap API prices a worst-case `executionFee` at deposit-address creation time and commits it
**per merkle leaf** into the address's immutable merkle root. The indexer surfaces it on each bridge
leaf as `counterfactualMaterials.{cctpLeaf,spokePoolLeaf}.params.executionFee` (decimal string,
input-token base units; absent on pre-fee addresses, `"0"` on sponsored routes). Only the
route-relevant leaf is nonzero.

On the deposit-execute path, `_getSwapApiQuote` reads those committed fees and echoes them back to
the swap API as `cctpExecutionFee` / `spokePoolExecutionFee` — **verbatim**, since the API rebuilds
the same leaf/root to verify the merkle proof; a mismatched or missing value for a nonzero-fee
address fails the rebuild. Each param is sent **only when its leaf carries `params.executionFee`**, so
legacy (pre-fee) addresses produce exactly the previous request. The bot never alters the value or
the `amount` (the transferred balance is already the gross `bridgeInput + executionFee`; the clone
subtracts the fee before bridging). `executionFeeRecipient` is the bot signer, so the bot collects
the committed fee. The forwarded values are logged on the execute success and swap-quote failure
lines for diagnosability. The withdraw path is unaffected — `withdrawLeaf` carries no fee.

`_getSwapApiQuote` also forwards the indexer message's `integrator.integratorId` (when present) as an
`integratorId` query param — **verbatim**, for integrator attribution — and omits it when the message
carries no integrator (or a null id), preserving the legacy request shape. Unlike the v3 execute path
(which validates the id and skips on mismatch because it folds into the CREATE2 salt), the v1 path
neither validates nor skips: the deposit address is already deployed from explicit salt/paramsHash.

## Redis persistence

Four sets persist across runs so handover does not double-spend, double-refund, re-attempt a terminally-skipped refund, or re-execute a transfer already known to be unexecutable:

- `deposit-address:executed:<botIdentifier>` — set of `erc20Transfer.transactionHash` for successfully executed deposits.
- `deposit-address:withdrawn-deposit-keys:<botIdentifier>` — set of `depositKey` (`depositAddress:transactionHash`) for successfully executed refund withdraws.
- `deposit-address:skipped-withdraw-keys:<botIdentifier>` — set of `depositKey` for v3 refund withdraws that failed terminally: a quote-api 422 (`GAS_EXCEEDS_REFUND` / `UNPRICEABLE_REFUND_TOKEN`), or a balance read that reverted because the token is not a conforming ERC-20; never re-attempted.
- `deposit-address:refund-only-deposit-keys:<botIdentifier>` — set of `depositKey` for v3 correct-transfers the execute endpoint rejected terminally (`AMOUNT_BELOW_MINIMUM` / `AMOUNT_TEMPORARILY_UNSWEEPABLE`); never executed again, routed to the refund-withdraw path instead.

On each poll, entries whose source messages are no longer returned by the indexer are pruned — the indexer has its own TTL and stops returning expired messages.

## Refund-withdraw flow (high level)

1. Filter on `relayerOriginChains`; skip if the refund chain is not configured.
2. Skip if the depositKey is already in the executed-withdraws set (Redis or in-memory in-flight).
3. Read on-chain balance of `depositAddress`; skip if below the transfer amount (defends against reorged indexer messages and concurrent withdraws via other paths). A read that reverts (`CALL_EXCEPTION`) means the token is not a conforming ERC-20 — v3 publishes a terminal `withdraw_failed` and persists the skip; any other read error is transient and retried on the next poll.
4. Fetch a signed-withdraw quote from the swap API. The response bundles deploy + signed-withdraw into a single Multicall3 call when the deposit clone is not yet on-chain.
5. Submit the tx via `TransactionClient`; wait for confirmation.
6. Persist the depositKey to Redis.
7. Publish a `withdraw_executed` lifecycle event to GCP Pub/Sub (if the publisher gate is on).

## Execution lifecycle Pub/Sub publish

The bot publishes two lifecycle events to one shared GCP Pub/Sub topic so the consumer can transition indexer rows out of `auto_pending`:

- `withdraw_executed` — when `ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER=true`, every confirmed refund withdraw (v1 + v3).
- `deposit_executed` — when `ENABLE_DEPOSIT_ADDRESS_DEPOSIT_PUBLISHER=true`, every successful **v3** correct-transfer execution (`initiateDepositV3`). v1 deposits are out of scope.
- `withdraw_failed` — same gate as `withdraw_executed`; only from the **v3** refund-withdraw path, and only for a terminal failure (see below).

**`ENABLE_EXECUTE_ERC20_TRANSFER_METADATA` overrides the `deposit_executed` publish.** When metadata
mode is on, the API emits the sweep ↔ funding-transfer link on-chain (a version-2 provenance blob via
`AcrossEventEmitter`), so the indexer learns of the execution from chain events and the bot **skips**
the `deposit_executed` Pub/Sub publish entirely — regardless of `ENABLE_DEPOSIT_ADDRESS_DEPOSIT_PUBLISHER`.
The `withdraw_executed` publish is unaffected. Operators enabling metadata mode should therefore expect
row transitions for v3 executes to come from the indexer's on-chain ingestion, not Pub/Sub.

The consumer lives at `indexer/packages/indexer/src/pubsub/DepositAddressExecutionConsumer.ts` (sibling repo). A single Pub/Sub client serves every event (same project + topic); it is constructed when **either** gate is on, and each publish path checks its own flag so the deposit and withdraw events toggle independently.

### Env

| Name | Required | Description |
| --- | --- | --- |
| `ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER` | No (default `false`) | Gate for `withdraw_executed` **and** `withdraw_failed`. |
| `ENABLE_DEPOSIT_ADDRESS_DEPOSIT_PUBLISHER` | No (default `false`) | Gate for `deposit_executed` (v3 executions). Independent of the withdraw gate. Ignored when `ENABLE_EXECUTE_ERC20_TRANSFER_METADATA=true` (the publish is skipped in favor of on-chain provenance). |
| `PUBSUB_GCP_PROJECT_ID` | When either gate is on | GCP project that **hosts the topic** (may differ from the bot's runtime project — cross-project publish is supported when the runtime SA holds `roles/pubsub.publisher` on the topic in the host project). |
| `PUBSUB_DEPOSIT_ADDRESS_WITHDRAW_TOPIC` | When either gate is on | Short topic name (e.g. `topic-deposit-address-execution` in prod, `…-sandbox` in non-prod). Shared by both events. |

Auth uses Application Default Credentials. In Cloud Run / GKE the workload SA provides them; locally set `GOOGLE_APPLICATION_CREDENTIALS`.

### Payload (locked by the consumer)

Every Pub/Sub message uses an envelope: `{ "type": "<message_type>", "data": <type-specific body> }`. The envelope shape is shared by all message types so the consumer can dispatch on `type` and validate `data` against the matching schema. `withdraw_executed` and `deposit_executed` share the exact `data` shape; only `type` differs:

```jsonc
{
  "type": "withdraw_executed", // or "deposit_executed"
  "data": {
    "chainId":     <execution tx chain>,
    "blockNumber": <execution tx block number>,
    "txHash":      "<execution tx hash>",
    "logIndex":    <logIndex of the ERC20 Transfer leaving the deposit address>,
    "erc20Transfer": {
      "chainId":     <inbound transfer chain>,
      "blockNumber": <inbound transfer block number>,
      "txHash":      "<inbound transfer tx hash>",
      "logIndex":    <inbound transfer logIndex>
    }
  }
}
```

All integer fields are `number`; tx hashes are lowercase hex strings. The `erc20Transfer` block identifies the original user transfer (the indexer keys rows on it); the sibling fields identify the execution transaction the bot just sent. The `logIndex` is the index of the ERC-20 `Transfer(address,address,uint256)` event whose `address` matches `erc20Transfer.contractAddress` and whose `from` is the deposit address; the **last** such log is used. For native-token withdraws (`contractAddress` = the native sentinel, v3 only) there is no ERC-20 Transfer — the `logIndex` is instead that of the `Withdraw(address,address,uint256)` event emitted by the deposit address itself (delegatecalled `WithdrawImplementation`), with the sentinel in the `token` topic; the same `to`-filter and last-match rules apply.

- **`withdraw_executed`** additionally requires `to` to equal the user's `routeParams.refundAddress`. Matching on `to` disambiguates fee-on-transfer / tax / burn tokens that emit several Transfer events from the deposit address in one tx (one to the user, one to a fee recipient), and the last match handles Multicall3-bundled withdraws with intermediate hops to the same refund address.
- **`deposit_executed`** omits the `to` filter — the input token leaves the deposit address into the SpokePool / CCTP with no fixed recipient — so any outgoing transfer of the input token qualifies.

Zero matches → warn + skip the publish.

### Failure semantics

Publish is best-effort. The withdraw or deposit execute is already on-chain and persisted in Redis before we publish; if the GCP client throws (after its own internal retries), we log at error level with `notificationPath: "across-bot-error"` and return — we do **not** roll back state, retry, or raise.

The intentional trade-off: a dropped publish leaves the indexer row in `auto_pending` until ops reconciles. We do **not** replay executed-but-unpublished withdraws on startup (Redis does not persist per-key publish state). Both are accepted for v1; revisit if dropouts become an ops pain point.

### Terminal failures (`withdraw_failed`)

Most withdraw failures are retried and must **not** be published: a `failed` row shows the user `refund-failed`, and the indexer serves each transfer once (plus a ~15-minute replay window), so there is no walking it back. Two v3 signals are published today:

- A balance read failing with ethers `CALL_EXCEPTION` — the token does not implement `balanceOf`, so no retry and no manual op can withdraw it. `isTerminalBalanceReadError` gates on the `code`, never the message; `TIMEOUT` / `SERVER_ERROR` / `NETWORK_ERROR` and non-ethers throws are our infrastructure and keep today's warn-and-return. Reason: `BALANCE_CHECK_FAILED`.
- The sign-withdraw terminal `422` — the refund cannot be executed at all (gas ≥ refund / unpriceable token / no refund address committed). Reason: the API's error code (`GAS_EXCEEDS_REFUND` / `UNPRICEABLE_REFUND_TOKEN` / `REFUND_ADDRESS_UNSET`), falling back to `SIGN_WITHDRAW_REJECTED` when the body carried none.

`_publishWithdrawFailed` carries the inbound `erc20Transfer` lookup key plus a stable `reason` code, which lands in `metadata.failureReason` for ops to group on (add codes, never reword them). It publishes **before** persisting the skip to `terminallySkippedWithdrawKeys`, so a Redis failure cannot swallow the event, and the skip caps it at one publish per transfer.

Still deliberately unpublished: every v1 (`initiateWithdraw`) failure path — those still strand rows at `auto_pending`.

## Related modules

- [`../messaging/gcp`](../messaging/gcp/) — thin `GcpPubSubPublisher` wrapper used here.
- [`../messaging/redis`](../messaging/redis/) — Redis pub/sub used for instance handover (`InstanceCoordinator`).
- [`../clients/AcrossSwapApiClient.ts`](../clients/AcrossSwapApiClient.ts) — swap-API quotes (deposit-execute + signed-withdraw).
- [`../clients/AcrossIndexerApiClient.ts`](../clients/AcrossIndexerApiClient.ts) — indexer message polling.
