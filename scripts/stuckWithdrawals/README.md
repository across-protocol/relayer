# Across stuck-withdrawal scanner

Finds Across L2→L1 withdrawals that were initiated but never claimed, for the relayer EOAs and the
HubPool, across OP-Stack / Orbit / Polygon (and, less completely, zkSync / Scroll / Linea).

It exists because a manual investigation in August 2026 found withdrawals that had been sitting
unclaimed for **over three years** — five legacy SNX withdrawals totalling 344.22 SNX, plus three
Maker-bridge DAI withdrawals worth ~20k DAI. Both sets were invisible to the production finalizer
and to several "exhaustive" sweeps, for reasons that are structural rather than accidental. This
document is mostly about those reasons.

---

## Running it

The only runtime dependency is `ethers` v5, which this repo already provides. The directory also
carries its own `package.json`/`tsconfig.json`, so it runs standalone in a bare directory without
installing the relayer's full dependency tree — handy if you only want to run a scan.

```bash
# inside this repo
yarn tsx scripts/stuckWithdrawals/index.ts --verify-fixtures

# or standalone: copy the directory anywhere, then
npm install && npm run scan -- --verify-fixtures
```

```bash
export NODE_URL_1=<mainnet>            # required
export NODE_URL_10=<optimism>          # per-chain, see registry.ts for the full list

# Prove the tool still works. Reproduces known stuck/claimed cases. Run this FIRST.
npm run scan -- --verify-fixtures

# Scans
npm run scan -- --chains 10 --era both --since 400            # Optimism, both eras
npm run scan -- --chains 42161,137 --since 90 --out out.json
npm run scan -- --chains 10 --from-block 0 --to-block 105235062 --era legacy   # pre-Bedrock only
```

Flags: `--chains` (csv, default all) · `--since <days>` · `--from-block` / `--to-block` ·
`--era bedrock|legacy|nitro|classic|both` · `--chunk <blocks>` · `--out <file>` ·
`--verify-fixtures`.

Cost control: `--since` and `--chunk` bound the work. A full-history Optimism scan is the expensive
one; everything else is cheap. Start narrow, widen once you trust the output.

---

## Design in one paragraph

Discover at the **canonical message layer**, resolve status with an **L1 oracle that has been proven
to discriminate**, and treat any RPC error as a **coverage gap** rather than an empty result. Each
chain family gets one scanner per *era* (message layers change at hard forks), and one oracle per
era. The registry supplies addresses, event shapes and the watch-list; the core is generic.

- `src/rpc.ts` — chunked `eth_getLogs` with adaptive splitting and explicit gap accounting.
- `src/scanners.ts` — L2 discovery, one function per family/era.
- `src/oracles.ts` — L1 "has this been claimed?" plus the control harness.
- `src/registry.ts` — chains, contracts, event signatures, watch-list. **Edit this one.**
- `src/spokePools.ts` — historical SpokePool addresses and every `TokensBridged` shape.
- `src/fixtures.ts` — known-good/known-bad regression cases.

---

## The failure modes this is built around

Every item below is something that actually returned a wrong answer during the investigation. They
are listed because the next person will otherwise rediscover them one at a time, which is roughly
how the three weeks went.

### 1. Token-layer scanning cannot see custom bridges
Scanning "ERC20 burns" or `L2StandardBridge` events misses any token with its own bridge. Optimism
DAI exits via Maker's `0x467194771dAe2967Aef3ECbEDD3Bf9a310C76C65`; Lisk USDC via
`0x3b1aC69368Eb6447F5db2D4e1641380Fa9E40d29`. Both hid real withdrawals from exactly that approach.
**Fix:** scan `L2ToL1MessagePasser.MessagePassed`, which every OP-Stack withdrawal emits regardless
of bridge. A bridge we've never heard of cannot dodge it.

### 2. Burn detection also fails for lock-style bridges
The obvious repair to (1) — look for `Transfer(x → 0x0)` — is also incomplete. Some bridges lock
rather than burn, and Synthetix's SNX never entered the L2 standard bridge at all. No token-level
detector is sufficient.

### 3. Era boundaries invalidate "provably complete" scans — this is the big one
`MessagePassed` is a **Bedrock-era** predeploy. Pre-Bedrock Optimism (before 2023-06-06) used the
legacy `L2CrossDomainMessenger`, and those withdrawals emit **no** `MessagePassed` at any block
depth. A scan with perfect coverage back to genesis on the Bedrock event still returns zero.
That is precisely how five SNX withdrawals hid for three years, and it survived several sweeps that
were, within their own frame, genuinely exhaustive. Arbitrum has the same shape at the Nitro
boundary (`L2ToL1Tx` vs classic `L2ToL1Transaction`).
**Fix:** `eraBoundaryBlock` per chain, and a separate scanner + oracle per era.

### 4. An RPC error is indistinguishable from "no events"
These endpoints return `{"error":{...}}` or time out on wide ranges. In `jq`, `.result|length`
maps `null` → `0`. A timeout therefore reads as a clean zero. This produced false all-clears three
separate times.
**Fix:** `getLogsChunked` treats non-array results as errors, retries at finer granularity, and
records unreadable ranges in `stats.gaps`. **A scan with non-empty `gaps` is not exhaustive**, and
`coverage.exhaustive` says so.

### 5. An oracle that never returns `true` looks exactly like "everything is stuck"
A subtly wrong portal address, or a withdrawal hash computed at the wrong offset, returns
`finalized=false` for every query. That is a total false-positive, and it reads as a dramatic
finding. One sweep reported 19 stuck Ink withdrawals this way; all 19 were claimed. Blast is the
live trap — its portal does not emit standard `WithdrawalFinalized` topics.
**Fix:** `assertDiscriminates()` requires a positive control (a hash the portal itself emitted, or
a sampled historical withdrawal) *and* a negative control (a bogus hash) before any status is
believed. Failure downgrades the run to `UNPROVEN` in the output rather than reporting findings.

### 6. `withdrawalHash` is not the last 32 bytes of `MessagePassed.data`
It sits at hex chars `[192, 256)`. `bytes data` is dynamic and its contents trail *after* the hash,
so slicing from the end yields a hash the portal has never seen — i.e. failure mode (5).

### 7. Event shapes drift, and one address can emit two of them
`TokensBridged` widened `l2TokenAddress` from `address` to `bytes32` for Solana support, changing
topic0. Every chain live before 2025-02-06 emitted the old shape then the new one *from the same
proxy address*. Filter each address on **both** topic0s; do not partition by address or date.
`spokePools.ts` also records three shapes that were **never deployed** — including `0x61ddedf1…`,
a three-day dev shape from before the first mainnet SpokePool — so nobody chases them again.

### 8. Deployment artifacts point at implementations, not proxies
Since 2024-02, `deployments/<net>/*_SpokePool.json` in `across-protocol/contracts` records the
**implementation** address. Implementations never emit logs under their own address — delegatecall
attributes logs to the proxy. Scanning them returns a confident zero. Emitters are in
`deployments/legacy-addresses.json`.

### 9. There are three SpokePool generations, not two
The commonly-cited deprecated set is gen-2. An older gen-1 set exists from the original deployment
(`0x931A4352…` ETH, `0x59485d57…` OP, `0xD3ddAcAe…` Polygon, `0xe1C367e2…` Arbitrum) and is
confirmed on-chain to have emitted `TokensBridged`. All three generations are in `spokePools.ts`.

### 10. The production finalizer lags reality by about an hour
An OP-Stack withdrawal cannot be proven until its L2 output root is posted, so
`zion-across-finalizer-sweeper` does not report a withdrawal until it reaches a proof or
dispute-game state. "Check the bot's list" therefore misses everything younger than ~1h — which
caused a report of 7 pending items when there were 17. Never treat the bot's view as ground truth
for recent activity.

### 11. A withdrawal proven by someone else needs a different finalize call
`finalizeWithdrawalTransaction` resolves the proof against `msg.sender`. If a third party proved it
— a keeper at `0x9A8f92a8…` proves and finalizes ours — the plain variant **reverts**, and you need
`finalizeWithdrawalTransactionExternalProof(_tx, thatProver)`. `proofSubmitters[hash][0]` tells you
who to name. The scanner reports `proofSubmitter` for this reason.

### 12. Getting the outbox position wrong inverts the answer
An Orbit `isSpent(position)` on the wrong position happily returns `true` for some unrelated spent
message, i.e. "already claimed". Read `position` from the `L2ToL1Tx` log's topic3, not from a
secondary source. A reported position of 164110 vs the true 164622 nearly produced exactly this.

---

## Coverage proofs

Chunk accounting alone is weak, so where a chain exposes a monotonic counter the scanner
cross-checks against it. These are *independent* of `eth_getLogs`, so they catch truncation that
chunk counting cannot:

- **OP-Stack:** `L2CrossDomainMessenger.messageNonce()` delta over the window is a **lower bound**
  on `MessagePassed` count (a contract can call the MessagePasser directly, bypassing the
  messenger). `observed >= expected` is the assertion; `observed < expected` means logs went missing.
- **Orbit:** `L2ToL1Tx.position` is monotonic, so a contiguous run with no gaps proves every message
  in the range was seen. This is what established Robinhood's genuine zero (positions 0…1161).

`coverage.exhaustive` is only `true` when there were no gaps **and** the independent check agreed.

---

## Known gaps — read before trusting a zero

- **Polygon PoS is candidates-only.** An exit is keyed on a Merkle proof of the burn receipt against
  a checkpointed root, so `RootChainManager.processedExits()` cannot be keyed from the burn log
  alone. `polygonExitStatus()` returns `unknown` by design and the scanner falls back to
  reconciling burn amounts against L1 predicate transfers. Treat Polygon output as a review queue.
- **Pre-Nitro Arbitrum is wired but unverified.** The classic `L2ToL1Transaction` topic0 and the
  classic Outbox addresses are from documentation, not confirmed by a passing control.
- **Redstone (690) and Aleph Zero (41455)** SpokePool addresses could not be confirmed on-chain —
  both chains are sunset and their public RPCs are dead. Marked `verified: false`; a zero there is
  unproven until run against an archive node.
- **zkSync / Scroll / Linea** have oracle implementations but no control harness and no fixtures.
  Lower priority per the original request, but that means lower confidence too.
- **Solana** is out of scope; `SvmSpoke` emits Anchor/Borsh events with no EVM topic0. It is,
  however, *why* the EVM `TokensBridged` field became `bytes32`.
- **Non-EVM and CCTP/OFT paths** are not withdrawals in this sense and are excluded. Note that
  LayerZero OFT sends look superficially like burns and will not — and should not — appear.

---

## Adding a chain or an address

Watch-list: add to `WATCH` in `registry.ts`. Matching is a raw-payload substring search, so a new
address is picked up by every scanner without touching the core.

New chain: add a `ChainConfig` to `CHAINS`, list its SpokePools in `spokePools.ts`, and set
`eraBoundaryBlock` if it has a fork boundary. If you do not know the OP portal address, leave it
unset — `derivePortal()` resolves it on-chain via
`L2StandardBridge.otherBridge() → L1StandardBridge.messenger() → L1XDM.portal()`, which is more
trustworthy than a copied constant. Then add a fixture, ideally one stuck and one claimed case, and
confirm `--verify-fixtures` passes.
