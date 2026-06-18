# `src/deposit-address` — Deposit Address Handler

The deposit-address handler polls the across-indexer for ERC-20 transfers that have landed on counterfactual deposit addresses and either executes them as deposits or refunds them back to the user.

## Runtime entrypoint

`runDepositAddressHandler` in [`index.ts`](./index.ts) wires up:

1. `DepositAddressHandlerConfig` from env.
2. Dispatcher keys for transaction signing.
3. `DepositAddressHandler` instance, then `initialize()`.
4. Background polling loop (`pollAndExecute`) on the configured interval.
5. Handover via Redis (`InstanceCoordinator`) — exits cleanly when another instance takes over.

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
| `3` | Upgradeable-counterfactual scheme — `correct_transfer` goes to the v3 execute path (below); `mis_route` goes to the v3 refund-withdraw path (below) when `ENABLE_V3_WITHDRAWALS=true`; `intent_refund` and other classifications are dropped (not yet supported on v3). |
| anything else (e.g. `2`) | Dropped (debug-logged) before normalization, since unsupported payloads may not carry a shape the normalizer can dereference. |

## v3 execute flow (thin submitter)

For `version: 3` messages the bot is a **thin submitter** of API-built calldata. The quote-api
execute endpoint (`POST /deposit-addresses/execute`, bearer-authed with the same `SWAP_API_KEY`)
re-derives the deposit address and all counterfactual merkle materials server-side from the
identity (`destination.token`, `destination.recipient`, `userAddress`); the bot relays funding
context only — origin chain, amount, destination route, refund identity — plus its own
`executionFeeRecipient` and the `integratorId` the address was derived with. `executionFee` is
currently omitted (the API defaults it to 0); bot-side fee pricing is a follow-up task.

The `integratorId` (2-byte hex) is sourced from the indexer message's `integrator` projection (a
property of the deposit address, not the bot's auth key) and is **required** by the execute
endpoint — it folds into the CREATE2 salt + on-chain integrator tag, so the address is derived
per-integrator. The bot relays it verbatim.

The flow (`initiateDepositV3`):

1. Filter on `relayerOriginChains` and dedup against the same Redis/in-memory sets as v1 (the dedup
   scheme is keyed on `erc20Transfer.transactionHash` / `depositKey`, shared across versions).
2. Skip non-`evm` `depositAddressNamespace` / `refundAddress.namespace` (the execute identity must
   be an EVM address).
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

The v3 message's `counterfactualMaterials`/`initialRoot`/`salt` are relayed by the indexer but not
read by the execute path — the API re-derives them, so they are carried for diagnostics only.

## v3 refund-withdraw flow

For `version: 3` `mis_route` messages, when `ENABLE_V3_WITHDRAWALS=true`, the bot refunds the
stranded funds back to the committed refund address. `intent_refund` is **not** handled on v3 yet
(dropped). The flow (`initiateWithdrawV3`) mirrors v1 `initiateWithdraw` with v3-specific guards:

1. Gate on `enableV3Withdrawals`, filter on `relayerOriginChains` (refund chain = `erc20Transfer.chainId`),
   and dedup against the shared withdraw sets (`executedWithdrawKeys`, in-flight `observedExecutedWithdraws`,
   and the v3 terminal-skip set below).
2. Skip non-`evm` `depositAddressNamespace` / `refundAddress.namespace` (the withdraw user must be EVM).
3. Locate the withdraw leaf in `counterfactualMaterials` (`kind === "withdraw"`); skip if its
   `merkleProof` / `implementationAddress` are missing.
4. Defensive on-chain balance check, as on the other paths.
5. Fetch `{ signedWithdrawTx: { to, data, value, chainId }, deadline, requestedAmount, appliedGasFee, netAmount, bundledDeploy }`
   from `POST /deposit-addresses/sign-withdraw`. Unlike v1, **gas is deducted from the refund**
   (`deductGasFromRefund: true`) so refunds are not operated at a loss. The endpoint **verifies** the
   supplied CDA materials (never re-derives the address) and bundles the v3 BeaconProxy
   `deploy(salt, initialRoot)` + `signedWithdrawToUser` into one Multicall3 call when the proxy is
   not yet on-chain.
6. Validate the response: `signedWithdrawTx.chainId` must match the refund chain and the embedded
   signature's `deadline` must have ≥60s headroom (perishable; re-requested fresh on the next poll).
7. Submit via `TransactionClient`, persist the depositKey, and publish `withdraw_executed` (same gate
   + topic + payload as v1; the payload reads `refundAddress.address` for v3).

**Terminal 422 handling.** The endpoint rejects with 422 when gas can't be deducted —
`GAS_EXCEEDS_REFUND` (fee ≥ refund, typically dust) or `UNPRICEABLE_REFUND_TOKEN` (no market price).
A 422 is treated as **terminal**: the bot does not submit and **does not retry on later polls**. The
depositKey is persisted to a dedicated skip set (below) so the decision survives handover. Every
other failure (network, timeout, 5xx, transient 400 incl. `GAS_FEE_TEMPORARILY_UNAVAILABLE`) is
retried, then skipped for the current poll and re-attempted on the next. Surfacing the 422 status
requires the non-swallowing `_postOrThrow` base-client method (`_post` collapses errors to
`undefined`); the bot classifies on the `HttpError.status`.

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

## Redis persistence

Three sets persist across runs so handover does not double-spend, double-refund, or re-attempt a terminally-skipped refund:

- `deposit-address:executed:<botIdentifier>` — set of `erc20Transfer.transactionHash` for successfully executed deposits.
- `deposit-address:withdrawn-deposit-keys:<botIdentifier>` — set of `depositKey` (`depositAddress:transactionHash`) for successfully executed refund withdraws.
- `deposit-address:skipped-withdraw-keys:<botIdentifier>` — set of `depositKey` for v3 refund withdraws the quote-api rejected with a terminal 422 (`GAS_EXCEEDS_REFUND` / `UNPRICEABLE_REFUND_TOKEN`); never re-attempted.

On each poll, entries whose source messages are no longer returned by the indexer are pruned — the indexer has its own TTL and stops returning expired messages.

## Refund-withdraw flow (high level)

1. Filter on `relayerOriginChains`; skip if the refund chain is not configured.
2. Skip if the depositKey is already in the executed-withdraws set (Redis or in-memory in-flight).
3. Read on-chain balance of `depositAddress`; skip if below the transfer amount (defends against reorged indexer messages and concurrent withdraws via other paths).
4. Fetch a signed-withdraw quote from the swap API. The response bundles deploy + signed-withdraw into a single Multicall3 call when the deposit clone is not yet on-chain.
5. Submit the tx via `TransactionClient`; wait for confirmation.
6. Persist the depositKey to Redis.
7. Publish a `withdraw_executed` lifecycle event to GCP Pub/Sub (if the publisher gate is on).

## Withdraw lifecycle Pub/Sub publish

When `ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER=true`, every confirmed refund withdraw produces one message on the configured GCP Pub/Sub topic. The consumer lives at `indexer/packages/indexer/src/pubsub/DepositAddressWithdrawConsumer.ts` (sibling repo) and transitions the corresponding `deposit_address_transfer_withdraw` row from `auto_pending` to `executed`.

### Env

| Name | Required | Description |
| --- | --- | --- |
| `ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER` | No (default `false`) | Master gate. When false, no Pub/Sub client is constructed. |
| `PUBSUB_GCP_PROJECT_ID` | When gate is on | GCP project that **hosts the topic** (may differ from the bot's runtime project — cross-project publish is supported when the runtime SA holds `roles/pubsub.publisher` on the topic in the host project). |
| `PUBSUB_DEPOSIT_ADDRESS_WITHDRAW_TOPIC` | When gate is on | Short topic name (e.g. `topic-deposit-address-execution` in prod, `…-sandbox` in non-prod). |

Auth uses Application Default Credentials. In Cloud Run / GKE the workload SA provides them; locally set `GOOGLE_APPLICATION_CREDENTIALS`.

### Payload (locked by the consumer)

Every Pub/Sub message uses an envelope: `{ "type": "<message_type>", "data": <type-specific body> }`. The envelope shape is shared by all current and future message types so the consumer can dispatch on `type` and validate `data` against the matching schema. Today only one type is emitted:

```jsonc
{
  "type": "withdraw_executed",
  "data": {
    "chainId":     <withdraw tx chain>,
    "blockNumber": <withdraw tx block number>,
    "txHash":      "<withdraw tx hash>",
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

All integer fields are `number`; tx hashes are lowercase hex strings. The `erc20Transfer` block identifies the original user transfer (the indexer keys rows on it); the sibling fields identify the withdraw transaction the bot just sent. The `logIndex` of the withdraw is the index of the ERC-20 `Transfer(address,address,uint256)` event whose `address` matches `erc20Transfer.contractAddress`, whose `from` is the deposit address, and whose `to` is the user's `routeParams.refundAddress`. Matching on `to` is necessary to disambiguate fee-on-transfer / tax / burn tokens that emit several Transfer events from the deposit address in one tx (one to the user, one to a fee recipient). If multiple Transfer logs still satisfy all three filters (e.g. a Multicall3-bundled withdraw with intermediate hops to the same refund address), the **last** match is used.

### Failure semantics

Publish is best-effort. The withdraw is already on-chain and persisted in Redis before we publish; if the GCP client throws (after its own internal retries), we log at error level with `notificationPath: "across-bot-error"` and return — we do **not** roll back state, retry, or raise.

The intentional trade-off: a dropped publish leaves the indexer row in `auto_pending` until ops reconciles. We do **not** replay executed-but-unpublished withdraws on startup (Redis does not persist per-key publish state). Both are accepted for v1; revisit if dropouts become an ops pain point.

Failure events (`withdraw_failed`) are **not** emitted today. The bot retries internally on quote-API and tx-submit failures, so there is no clean "terminal failure" signal to publish. The consumer schema accepts them; producing them is deferred.

## Related modules

- [`../messaging/gcp`](../messaging/gcp/) — thin `GcpPubSubPublisher` wrapper used here.
- [`../messaging/redis`](../messaging/redis/) — Redis pub/sub used for instance handover (`InstanceCoordinator`).
- [`../clients/AcrossSwapApiClient.ts`](../clients/AcrossSwapApiClient.ts) — swap-API quotes (deposit-execute + signed-withdraw).
- [`../clients/AcrossIndexerApiClient.ts`](../clients/AcrossIndexerApiClient.ts) — indexer message polling.
