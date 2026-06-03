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

The deposit path is always active. The refund-withdraw path is gated by `WITHDRAW_ENABLED`.

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

Two sets persist across runs so handover does not double-spend or double-refund:

- `deposit-address:executed:<botIdentifier>` — set of `erc20Transfer.transactionHash` for successfully executed deposits.
- `deposit-address:withdrawn-deposit-keys:<botIdentifier>` — set of `depositKey` (`depositAddress:transactionHash`) for successfully executed refund withdraws.

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
