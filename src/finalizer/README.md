# Finalizer

Bot that completes the delayed leg of cross-chain flows: executing L2 → L1 withdrawals once their challenge/proof
window elapses, relaying L1 → L2 deposits that require manual execution, and retrying miscellaneous cross-chain
messages. Each supported chain delegates to one or more chain-specific finalizers in `./utils/`.

---

## Runtime Flow (current behavior)

1. **Entrypoint** – `index.ts` `finalize()` iterates the configured chains in chunks (`FINALIZER_CHUNK_SIZE`) and
   invokes each chain's registered finalizers.
2. **Finalizer registry** – `chainFinalizers` holds explicit per-chain entries (e.g. Polygon, Linea, BSC, Solana
   CCTP) and `generateChainConfig()` autopopulates the rest by chain family: OP stack → `opStackFinalizer`,
   Orbit → `arbStackFinalizer`, ZK stack → `zkSyncFinalizer`, plus `cctpV2Finalizer` for CCTP-enabled chains and
   `heliosL1toL2Finalizer` for universal chains.
3. **Direction filter** – `FINALIZATION_STRATEGY` (`l1->l2`, `l2->l1`, `l1<->l2`, `any<->any`) selects which of a
   chain's finalizers (`finalizeOnL2`, `finalizeOnL1`, `finalizeOnAny`) run.
4. **Tracked addresses** – Each finalizer receives an `AddressesToFinalize` map comprising the operator-supplied
   `FINALIZER_WITHDRAWAL_TO_ADDRESSES` entries plus, always, the HubPool, the AtomicDepositor, and the chain's
   SpokePool. Finalizers that discover work purely from SpokePool `TokensBridged` events ignore this list; others
   use it as the sender and/or recipient filter when querying bridge events.
5. **Submission** – Resulting calls are batched per destination chain through Multicall2 and submitted via the
   `MultiCallerClient` (simulation included). `SEND_TRANSACTIONS=true` gates actual submission.

## Withdrawal Discovery on ZK Stack Chains

`utils/zkSync.ts` discovers withdrawals to finalize from two sources:

1. **SpokePool withdrawals** – `TokensBridged` events from the chain's SpokePool client.
2. **Direct native token withdrawals** – Withdrawals of the chain's native token (ETH on zkSync, GHO on Lens)
   initiated directly on the `L2BaseToken` system contract (`0x…800A`, the `nativeToken` entry in
   `CONTRACT_ADDRESSES`) do not emit `TokensBridged`. The finalizer queries the contract's `Withdrawal` and
   `WithdrawalWithMessage` events emitted by the tracked sender addresses (the SpokePool is excluded — its
   withdrawals are covered by path 1) and molds them into the `TokensBridged` shape for the rest of the pipeline.

Withdrawals from both sources are merged and sorted into on-chain log order before status sorting and proof
generation. Ordering matters: a transaction containing multiple withdrawals is finalized by each withdrawal's
ordinal position within the transaction (`getUniqueLogIndex` → `finalizeWithdrawalParams`), so the merged list must
reflect the order the messages were emitted on chain.

## Configuration

- `FINALIZER_CHAINS` – JSON array of chain IDs to finalize.
- `FINALIZATION_STRATEGY` – direction filter, defaults to `l1<->l2`.
- `FINALIZER_WITHDRAWAL_TO_ADDRESSES` – JSON map of address → token symbols; senders/recipients to track in
  addition to the protocol contracts.
- `FINALIZER_MAX_TOKENBRIDGE_LOOKBACK` – how far back events are queried.
- `FINALIZER_CHUNK_SIZE` – number of chains processed concurrently.
- `SEND_TRANSACTIONS` – must be `"true"` to submit transactions; otherwise the run is simulation-only.

---

## Contributor Recommendations

- Register new chain finalizers through `generateChainConfig()` family defaults where possible; reserve explicit
  `chainFinalizers` entries for exceptions.
- When adding a discovery path that molds foreign events into the `TokensBridged` shape, preserve on-chain log
  ordering in any merged event list — per-transaction withdrawal ordinals map directly to L2 → L1 messages.
- Finalization transactions are assumed unpermissioned (any `msg.sender` may execute them). If a new finalizer
  breaks that assumption, it cannot rely on the shared Multicall2 batching.
