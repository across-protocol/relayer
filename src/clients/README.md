# Helper clients

## Event fetching clients

The SpokePoolClient and HubPoolClient are responsible for fetching events and state from the SpokePool and HubPool contracts.

These clients use cache management modules like the RedisClient in order to reduce event RPC request load and avoid rate-limits.

### Indexed SpokePoolClient event listeners (`src/libexec`)

In indexed mode the SpokePoolClient spawns a per-chain-family child listener that streams SpokePool events to it over IPC: `RelayerSpokePoolListener` (EVM), `RelayerSpokePoolListenerSVM` (Solana), `RelayerSpokePoolListenerTVM` (TRON). Common CLI args: `--chainid`, `--spokepool`, `--lookback` (seconds-from-head or `@<block>`), `--blockrange` (max `eth_getLogs` page, default 10,000), and `--quorum` (default `NODE_QUORUM_<chainId>` / `NODE_QUORUM`, else 1).

EVM and SVM subscribe over websockets and apply quorum in the application layer: `EventManager` tallies each event across `quorum` providers before posting it. TRON's RPCs don't support websockets reliably and expire `eth_newFilter` ids, so the TVM listener instead polls `eth_getLogs` over a single quorum `RetryProvider` — which imposes node quorum on every query (`--quorum` is threaded into `getProvider` as an override) — and reconciles a trailing re-org window:

- After a one-time historical backfill of the look-back-only events (`RequestedSpeedUpDeposit`, `RelayedRootBundle`, `ExecutedRelayerRefundRoot`) up to the startup head, it loops every ~2s (just under TRON's ~3s block time). On each new head it issues one `--blockrange`-paginated `eth_getLogs` for the live events (`FundsDeposited`, `FilledRelay`) over the last `REORG_WINDOW` (64) blocks and diffs the result against what it has posted: events that vanished (re-orged out) are removed, new or re-org-replacement events are added. A re-org is reflected within one poll once quorum converges; a failed query skips the pass and retries on the next poll.
- On TRON the RPC URL must target QuikNode's eth-JSON-RPC path (`…/jsonrpc`); the bare token URL is the TronGrid API and 404s for `eth_*` calls.

## Inventory Client

The InventoryClient has several important functions that all use its `InventoryConfig` as input

### Inventory Config

The full inventory config is defined in /src/interfaces/ and its read from the user's environment in the `src/relayer/RelayerConfig`. It essentially defines target balance allocation %'s across chains.

When `L1_TOKENS_OVERRIDE` is set, `getL1Tokens()` restricts inventory management to the override tokens, even if the inventory config references more. Tokens outside the override are ignored by inventory updates, rebalances, and excess-balance withdrawals, because the `TokenClient` only tracks balances for the override set. This lets a bot (e.g. a rebalancer narrowed to one token) reuse a broader inventory config without generating rebalance candidates it can neither fund nor account for locally. An empty override leaves the full config in effect.

### Setting and Getting Virtual Balances

The InventoryClient is designed to track inventory across chains, which are actual on-chain token balances plus any virtual balance modifications stemming from incomplete transfers from the `CrossChainTransferClient` and incomplete rebalances from rebalancer clients. The InventoryClient can also add in virtual modifications for upcoming relayer refunds from the `BundleDataApproxClient`.

The InventoryClient exposes functions that let other bots like the `Relayer` and rebalancer clients know its latest calculation of virtual chain balances for a particular token. For pending rebalance adjustments specifically, it depends on the read-only `ReadOnlyRebalancerClient` interface so it does not need to choose a rebalancing mode.

In addition to chain-level virtual balances, InventoryClient exposes cumulative token-level balance context via `getCumulativeBalanceWithApproximateUpcomingRefunds()`. The Rebalancer uses this to evaluate cumulative deficits and excesses when running cumulative inventory rebalancing.

When shortfall rebalances are enabled (`rebalanceShortfalls`), pending same-asset rebalances tracked in Redis (e.g. Binance swap orders reported through `RebalancerClient.getPendingRebalances`) count toward the outstanding cross-chain transfer amount for the canonical L2 token, so an in-flight rebalance already covering a shortfall is not re-initiated every run. Same-route shortfalls are combined into a single bridge transfer rather than one transfer per unfilled deposit, and the combined amount is the greedy fundable subset (scanning entries largest-first, skipping ones that don't fit) of the current L1 balance — a combined amount above the balance would be rejected wholesale downstream, stranding shortfalls that were individually fundable; when no entry fits, the largest is emitted so the downstream balance guard rejects and logs it.

### Determining Refund Chain for Deposit

Another important function of the InventoryClient is to choose where a relayer should get repaid for filling a particular deposit, which is purely a function of the user's configured "ideal" inventory across chains (i.e. defined in the `InventoryConfig`) and how the inventory state would look like post-filling the deposit.

Deep dives:

- `docs/repayment-eligibility.md`
- `docs/repayment-selection.md`
- `docs/inventory-virtual-balance-model.md`
- `docs/slow-fill-lifecycle.md`
- `docs/inventory-vs-rebalancer-responsibilities.md`

### Wrapping and Unwrapping Native Tokens

The InventoryConfig also lets the user set minimum native token balances to hold on all chains in order to avoid running out of gas for submitting on-chain transactions. Because the relayer is filling so many user deposits, it has a big demand for spending native token balance.

For now, the native token target balances are defined in the InventoryConfig and therefore the InventoryClient is in charge of determining when to and executing native token wraps and unwraps.

Ideally, this wrapping and unwrapping would occur in a separate, focused NativeTokenClient.

### Transferring Tokens Across Chains

The InventoryClient also provides functions that are used to transfer tokens across chains via adapters like CCTP, OFT, or canonical bridges. These adapters are defined in /src/adapter/bridges and /src/adapter/l2Bridges which send tokens from L1 to L2 and vice versa, respectively.

For OFT excess withdrawals to the hub chain (`OFTL2Bridge`, which also serves alt L1 spoke chains), the requested amount is quoted via `quoteOFT` before the transaction is built. Stargate-style OFT paths cap the quoted send amount at the path's available credit, so when quoted capacity is below the requested amount the withdrawal is sized down to the quoted amount and the transaction markdown notes the size-down. When quoted capacity is zero or below the path's minimum send amount, the sized-down amount is below `RELAYER_OFT_MIN_WITHDRAWAL_PCT` of the requested amount (env-tunable fraction, default 0.2, validated to [0, 1] at construction — a send far below the requested amount barely dents the excess while still paying full per-message costs such as the roughly fixed LayerZero message fee, so a low-capacity path would otherwise be drained in small sends), or the quoted fee-adjusted output (`amountReceivedLD`) already violates the withdrawal's max-slippage floor, no transaction is enqueued for that run. The skip is logged at warn level by `BaseChainAdapter.withdrawTokenFromL2`; for min-percentage skips `OFTL2Bridge` additionally logs the requested/quoted amounts and the configured floor at debug level (debug rather than warn so a single skip does not emit two warns), the InventoryClient's "Executed excess L2 inventory withdrawal" message reports only the withdrawals that produced transaction receipts on a live run (simulated runs report all planned withdrawals) and states the requested amounts — the executed, possibly capacity-sized amount is reported by the transaction submission message, and the excess stays on the origin chain to be re-evaluated on a later run once capacity recovers. Pending-withdrawal volume accounting is unaffected because it is derived from on-chain `OFTSent` events, which reflect the actually-sent amounts. The one-shot operator script `scripts/withdrawTokenFromL2.ts` goes through the same bridge adapters but has no later-run retry, so it exits with an error instead of a success banner when the bridge constructs no transactions.

ZK Stack chains (zkSync Era, Lens) withdraw to the hub chain through two adapters, because the stack has two distinct exit paths. Ordinary ERC20s go through `ZKStackBridge`, which calls `withdraw(bytes32 assetId, bytes assetData)` on the L2 asset router. That entrypoint is used in preference to the legacy `withdraw(address,address,uint256)` because it works for L2-origin as well as bridged tokens, and because it routes the L2->L1 message through the asset router itself — which is what `useLegacyFinalizeWithdrawal` in the zkSync finalizer keys off to select `finalizeDeposit` (which passes `l2Sender` explicitly) over the legacy `finalizeWithdrawal`. The `assetId` is resolved at runtime from the L2 native token vault; a token the vault does not recognise, or the chain's own wrapped native token (which the vault refuses to burn with `BurningNativeWETHNotSupported`), constructs no transaction and is logged at warn level. That runtime guard is a backstop, not the routing decision: a token with no viable exit must resolve to no bridge at all in `CANONICAL_L2_BRIDGE`/`CUSTOM_L2_BRIDGE`, because `AdapterManager` only skips a token when the lookup itself is undefined — a bridge that resolves but then constructs no transaction is still registered as that token's withdrawal path and silently moves nothing. Lens is therefore wired per-token rather than canonically, since only its WETH can take the asset router route: its USDC arrives over the standalone ZK Stack USDC bridge, which the vault does not know about, and so withdraws through `ZKStackUSDCBridge` — an adapter for that standalone bridge, which pulls the tokens via `transferFrom` (so it needs an allowance, unlike the vault burn path) and reconciles pending withdrawals from the bridge pair's own `WithdrawalInitiated`/`WithdrawalFinalizedSharedBridge` events — only the L2 bridge address is configuration (the Circle-style token cannot name its bridge), while the L1 counterparty is resolved from the L2 bridge's `l1USDCBridge()`; the finalizer routes those withdrawals to the standalone L1 USDC bridge on `(chain, token)` alone. The chain's wrapped native token instead uses `ZKStackNativeBridge`, which unwraps it and withdraws the base token via the L2BaseToken system contract, so the funds arrive on L1 as whatever the chain registered as its base token. On zkSync Era that is native ETH, which the relayer already re-wraps on the hub chain; Lens registered LGHO — the wrapper itself, and the L1 token its inventory is keyed on — so its withdrawals are minted by the L1 native token vault as exactly that ERC20 and need no re-wrap. Because an ETH base token is released on L1 as a plain native transfer with no event to match against, `ZKStackNativeBridge` counts every withdrawal inside its lookback window as still pending rather than reconciling it, which over-counts recently-finalized withdrawals and so errs towards suppressing a duplicate withdrawal rather than causing one.

Withdrawals initiated by the relayer's own address do not emit `TokensBridged`, so the zkSync finalizer additionally discovers them from `BridgeBurn` on the L2 native token vault, `Withdrawal` on the L2BaseToken contract, and `WithdrawalInitiated` on the standalone USDC bridge where the chain has one, filtered by the addresses in `FINALIZER_WITHDRAWAL_TO_ADDRESSES`. Without that address list configured the withdrawals will initiate but never be finalized.

Robinhood WETH withdraws to mainnet over the Arbitrum Orbit canonical bridge (`ArbitrumOrbitBridge`); its USDG stays on `PaxosTransitL2Bridge`. The rollup's challenge period is 45818 L1 blocks (~6.4 days), stored as `confirmPeriodBlocks` in `ARB_ORBIT_NETWORK_CONFIGS`, so withdrawals sit pending for roughly a week while `getL2PendingWithdrawalAmount` holds the in-flight amount in the virtual mainnet balance. Keep `confirmPeriodBlocks` an exact integer: `@arbitrum/sdk` passes it to `BigNumber.from()`, which throws `NUMERIC_FAULT` on a fractional value, and `getMessageOutboxStatusAndProof` swallows that error, so every affected withdrawal would silently go unfinalized.

### Plan for Deprecation of Token Transfer Logic

Note that the InventoryClient is an older module and its token transfer functions are slated to be migrated over to rebalancer clients eventually. For now, the separation of concerns between the two is that the InventoryClient is in charge of sending **same** tokens across chains while rebalancer clients swap different tokens across chains.

## Profit Client

Computes the relayer's expected profit from filling a deposit by converting the `inputAmount` of `inputTokens` and the `outputAmount` of `outputTokens` into a USD value.

The Profit Client estimates what the gas cost would be to fill the deposit (i.e. submit the fill function's call data) on the destination chain and factors this into its profitability calculation.

Importantly, the Profit Client exposes certain configuration objects that the user can use to set profitability thresholds.

### Per-token-pair policy overrides

The Profit Client supports a registry of named "policies" that can short-circuit the standard `MIN_RELAYER_FEE_PCT_*` and `RELAYER_GAS_MULTIPLIER_*` lookups. The policies in `RELAYER_POLICIES` (comma-separated) are decoded once at construct time and evaluated in order; the first whose predicate matches the deposit wins. Env mutations after construction are ignored — operators should set policy env vars before the relayer starts.

A policy named `<NAME>` (uppercased in env var keys) matches when:

1. The destination chain ID is in `RELAYER_POLICY_<NAME>_DESTINATIONS_<srcSymbol>_<dstSymbol>` (comma-separated chain IDs).
2. Either `RELAYER_POLICY_<NAME>_ORIGINS_<srcSymbol>_<dstSymbol>` is set and the origin chain ID is in that comma-separated list, **or** that env var is unset and the origin chain supports unmetered fast rebalance for the input token (hub chain, CCTP-eligible USDC, OFT-eligible USDT, or Paxos Transit routes — see `isUnmeteredFastRebalance` in `src/utils/FillUtils.ts`). An explicit origin allowlist overrides the fast-rebalance default.

`srcSymbol` and `dstSymbol` are the raw token symbols of the deposit's input and output tokens — they bypass the pegged-token symbol remap used by other profitability env vars.

When a deposit matches policy `<NAME>`:

- If `RELAYER_POLICY_<NAME>_MIN_FEE_PCT` is set, `minRelayerFeePct` returns it (may be negative to accept fills below break-even). If unset, the standard per-route/token/chain lookup and default apply.
- If `RELAYER_POLICY_<NAME>_GAS_MULTIPLIER` is set, `resolveGasMultiplier` returns it (must satisfy `0 <= multiplier <= 4`; out-of-range values throw). If unset, the standard per-route/token/chain lookup and default apply.

Example: accept zero-fee USDC->WETH fills into Arbitrum and Optimism with no gas-cost contribution, via a policy named `example`:

```
RELAYER_POLICIES=example
RELAYER_POLICY_EXAMPLE_DESTINATIONS_USDC_WETH=42161,10
RELAYER_POLICY_EXAMPLE_MIN_FEE_PCT=0
RELAYER_POLICY_EXAMPLE_GAS_MULTIPLIER=0
```

## Transaction Client

This client is responsible for submitting transactions on-chain and therefore for setting the transaction's gas price values, nonce, and implements important retry and error decoding logic. It is designed to be shared across all code modules that submit on-chain transactions.

For transactions submitted with `ensureConfirmation: true`, confirmation is awaited with a bounded wait (6 s, or 24 s on mainnet) that retains ethers' replacement detection. The wait bound is only a sampling cadence — replacement decisions are block-driven: a transaction is resubmitted at the same nonce with freshly-priced gas once the chain has produced at least 2 blocks without including it. An externally-replaced transaction (`TRANSACTION_REPLACED`) is resubmitted immediately, except when the mined replacement carries identical calldata ("repriced" — i.e. the original won the race against its own replacement), which is adopted as-is. Reverted transactions propagate as submission failures; exhausted resubmissions emit an error-level log (paging the on-call) and return the unconfirmed response.

`willSucceed()` sizes a transaction with `eth_estimateGas` and the gas limit is used as-is unless the transaction declares a `gasLimitMultiplier`; a transaction that already carries a `gasLimit` is taken to have been simulated in advance and passes straight through.

`Multicall3.tryAggregate(requireSuccess=false, ...)` must not be sized by estimating itself: it catches inner reverts, so a batch whose calls all ran out of gas still succeeds and the estimate prices the failure. Submitted raw it mines a batch that did nothing, with `status: 1` and no events (this discarded a 76,064.59 USDC CCTP v2 mint on 2026-08-05, and stalled two OP-stack withdrawals the same day). Padding doesn't fix it either, since OP-stack `SafeCall.callWithMinGas` gates on `gasleft()` rather than on consumption. `buildFinalizationBatches()` sizes each batch from its calls' own estimates instead, plus `MULTICALL3_BATCH_GAS_OVERHEAD` for the wrapper those estimates don't price. A call that no longer estimates has no size, so it is dropped rather than charged against a limit summed from its neighbours — `tryAggregate` contains a revert, but not gas exhaustion.

Every batch is therefore sized, and none is submitted unsized. Batches also set `ensureConfirmation: true`, so a batch that reverts outright surfaces as a submission failure rather than a hash — `submit()` stops there and returns the hashes it already has, and the chain's messages report unconfirmed instead of being credited to a transaction that carried nothing. It also keeps a chain's batches sequential, so a stuck early nonce is repriced rather than leaving the later ones queued behind it.

`test/Finalizer.BatchBuilding.test.ts` and `test/MultiCallerClient.TryAggregateGas.test.ts` pin these properties against real Multicall3 bytecode.

## Across API Client

The AcrossApiClient polls the Across API `/liquid-reserves` endpoint for the HubPool liquidity available per enabled L1 token; the relayer skips deposits whose input amount exceeds the limit for their token (hub-chain origins are exempt, since funds can be JIT-bridged from mainnet). `update()` reports whether the limits are current instead of throwing, and a failed query retains the last known values rather than zeroing them, so transient API outages don't halt filling. Limits are not enforced until a query has succeeded, so `Relayer.init()` retries the initial update and, if it never succeeds, logs at error level and proceeds — the relayer then fills without a HubPool liquidity constraint.
