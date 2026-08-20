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

# 1. Prove the tool still works. Reproduces known stuck/claimed cases. Run this FIRST.
npm run scan -- --verify-fixtures

# 2. Scan
npm run scan -- --chains 10 --era both --since 400          # Optimism, both eras
npm run scan -- --chains 42161,137 --since 90 --out out.json
npm run scan -- --chains 10 --from-block 0 --to-block 105235062 --era legacy   # pre-Bedrock only
npm run scan -- --chains 137 --since 30 --tokens 0x2791Bca1…,0x…   # Polygon needs child tokens
npm run scan -- --chains 42161 --era classic --resolve-classic     # + wide L1 outbox log scan
```

Flags: `--chains` (csv, default all) · `--since <days>` · `--from-block` / `--to-block` ·
`--era bedrock|legacy|nitro|classic|both` · `--chunk <blocks>` · `--out <file>` ·
`--tokens <csv>` (required for Polygon) · `--resolve-classic` · `--verify-fixtures`.

**Exit codes matter — do not just read stdout:**

| code | meaning |
| --- | --- |
| `0` | scan complete, every oracle proven, nothing unclaimed |
| `1` | scan complete, unclaimed withdrawals found (actionable) |
| `2` | scan **incomplete or unproven** — a chain was unreachable, a block range could not be read, or an oracle failed its control |

`2` outranks `1` on purpose. "We could not look" must never be indistinguishable from "all clear":
a missing `NODE_URL_<chain>` used to produce zero findings and exit `0`, which reads as a clean
result for a chain the scanner never contacted. Anything that leaves a candidate unresolved prints
`UNKNOWN` alongside the `STUCK` lines rather than being silently omitted.

Cost control: `--since` and `--chunk` bound the work. A full-history Optimism scan is the expensive
one; `--resolve-classic` adds a wide L1 log scan per classic batch. Start narrow, widen once you
trust the output.

---

## Design in one paragraph

Discover at the **canonical message layer**, resolve status with an **L1 oracle that has been proven
to discriminate**, and treat any RPC error as a **coverage gap** rather than an empty result. Each
chain family gets one scanner per *era* (message layers change at hard forks), and one oracle per
era. The registry supplies addresses, event shapes and the watch-list; the core is generic.

- `rpc.ts` — chunked `eth_getLogs` with adaptive splitting and explicit gap accounting, plus the
  `eth_call` wrapper that distinguishes a revert from a node that could not answer.
- `scanners.ts` — L2 discovery, one function per family/era.
- `oracles.ts` — L1 "has this been claimed?" plus the control harness.
- `registry.ts` — chains, contracts, event signatures, per-chain controls, watch-list. **Edit this one.**
- `spokePools.ts` — historical SpokePool addresses and every `TokensBridged` shape.
- `fixtures.ts` — known-good/known-bad regression cases and offline hash-derivation fixtures.
- `selfTest.ts` — offline tests for the chunking loop, run as part of `--verify-fixtures`.

**Controls are gates, not warnings.** Every oracle must be shown to return `true` for a known-claimed
message before the scanner will report any `finalized: false` from it as a finding. An oracle that
fails its control forces every candidate on that chain to `unknown`. The known-claimed values live in
`ChainConfig.controls` per chain — they are *not* global constants, because a control that is correct
for Arbitrum is meaningless on Aleph Zero.

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

The same trap applies to `eth_call`, and it is worse there because the result feeds a *finding*
rather than coverage. A wrapper that swallows every failure into `undefined` turns a five-second L1
timeout into `finalized = false`, i.e. a withdrawal reported as stuck because the RPC blinked.
`ethCall` therefore returns `undefined` **only** for a genuine revert (a real answer from the node —
which is legitimately how "this function does not exist here" presents on the classic outboxes) and
throws `RpcError` when the node could not answer, after retrying. Callers record those candidates as
`unknown`; nothing that could not be read is ever reported as a finding.

### 4b. An adaptive chunker can shrink and grow forever without making progress
`getLogsChunked` grew its window whenever no chunk had failed yet — including on the very iteration
that had just shrunk. Against an endpoint that rejects `chunk` but accepts `chunk/4` it oscillated
indefinitely: shrink to `minChunk`, grow back, get rejected, shrink again, never issuing the narrower
request and never recording a gap. The scan hung with no error.
**Fix:** grow only after a *successful* batch at the current size, and record a gap once retries are
exhausted at `minChunk`. `selfTest.ts` pins all three behaviours (shrink past a cap, cover the range,
account for every unreadable block) offline against a fake capped endpoint.

### 5. An oracle that never returns `true` looks exactly like "everything is stuck"
A subtly wrong portal address, or a withdrawal hash computed at the wrong offset, returns
`finalized=false` for every query. That is a total false-positive, and it reads as a dramatic
finding. One sweep reported 19 stuck Ink withdrawals this way; all 19 were claimed. Blast is the
live trap — its portal does not emit standard `WithdrawalFinalized` topics.
**Fix:** `assertDiscriminates()` requires a positive control (a hash the portal itself emitted, or
one of `controls.finalizedWithdrawalHashes`) *and* a negative control (a bogus hash) before any status
is believed. A failed control **forces every candidate on that chain to `unknown`** — it is a gate,
not a log line. Blast ships three verified fallback hashes precisely because its portal cannot supply
the self-emitted control.

The controls have to be per chain and they have to be right. The Orbit positive control was once the
literal position `164622` for every Orbit chain — which is Arbitrum's, and which `fixtures.ts`
simultaneously pins as **unspent** because it was inside its challenge window. So the control asked
"is this unclaimed withdrawal claimed?", correctly got `false`, and declared the oracle broken on
every Arbitrum scan. A control value must be a *known-claimed* message on *that* chain
(`controls.spentOutboxPosition`), and because claiming is irreversible such a value never goes stale.

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
`finalizeWithdrawalTransactionExternalProof(_tx, thatProver)`. The scanner reports `proofSubmitter`
for this reason. Read the **last** submitter, not index 0: a reproven withdrawal keeps its stale first
proof at index 0, backed by a game that will never resolve favourably, so naming it sends you into a
reverting finalization. The scanner enumerates `numProofSubmitters(hash)` and prefers the newest proof
with a resolved game, matching `getDisputeGameFinalizableAt()` in `src/finalizer/utils/opStack.ts`.

### 11b. "Proven + 7 days" is not when a Portal-2 withdrawal becomes claimable
There are **two independent clocks** and the gate is the later of them:
`provenAt + proofMaturityDelaySeconds`, and `disputeGame.resolvedAt() + disputeGameFinalityDelaySeconds`
— and the second has not even *started* while the backing game is unresolved (`resolvedAt == 0`).
Mainnet OP reads `604800` and `302400` respectively, so a hardcoded seven days silently matched the
first clock alone and ignored the second, advertising a `claimableAt` that can be days early. The
scanner now reads both off the portal and reports `claimableBlockedOn` instead of a timestamp when the
game has not resolved.

### 12. An oracle can exist, be callable, and still be the wrong one
Linea's `inboxL2L1MessageStatus(bytes32)` is callable and returns `0` for **every** real message,
including confirmed-claimed ones — it is the dead pre-Merkle-proof path, and its output is
indistinguishable from a random hash. I shipped it in the first cut of this tool; it would have
reported every Linea message as stuck. The live oracle is the nonce-keyed bitmap
`isMessageClaimed(uint256 _messageNumber)`. Same shape on zkSync: the Era diamond's
`isEthWithdrawalFinalized` and `L1ERC20Bridge.isWithdrawalFinalized` both return false for
known-true keys.

### 13. Cross-era outbox queries return plausible garbage, not errors
Arbitrum's classic and Nitro outbox index spaces overlap numerically. For a real classic withdrawal
(`uniqueId 81359`, `batchNumber 15531`): `NitroOutbox.isSpent(81359)` = false (false negative), while
`isSpent(15531)` and `isSpent(81360)` both = true (false positives). Worse, `isSpent` **does not
exist** on the classic outboxes — it reverts, which a permissive `eth_call` wrapper turns into a
silent "not claimed". Route strictly on block 22207817; classic status needs
`outboxEntryExists(batchNumber)` plus L1 `OutBoxTransactionExecuted` logs. Classic claims are still
arriving in 2026 (481 in the last 500k L1 blocks, batch numbers as low as 881), so this is live.

### 14. Optimism has an era boundary *below* the legacy era
The Nov-2021 regenesis seeded `messageNonce` at **100000**. Legacy nonces `0…99999` belong to the
pre-regenesis OVM 1.0 chain, whose logs are **not in the current chain at all** — undiscoverable by
any `eth_getLogs` scan, at any depth, and they would need the archived pre-regenesis chain. The SNX
nonces (137k) are safely above this, but a zero below 100000 is meaningless rather than reassuring.

### 14b. The legacy claim key is not value-independent — ETH withdrawals hash differently
`hashCrossDomainMessageV1` covers `(nonce, sender, target, value, minGasLimit, data)`. For a
pre-Bedrock **ETH** withdrawal the `value` is the withdrawn amount, not `0`: ETH left L2 as a
message to `L1StandardBridge.finalizeETHWithdrawal`, and the migration re-encoded it carrying that
amount. Hardcoding `value = 0` — which the first cut did, from an n=2 sample that happened to be
two SNX (ERC20, value 0) proofs — yields a key the messenger has never written, for every ETH
withdrawal ever, forever. It reported five *claimed* withdrawals totalling **1,552.38 ETH**
(SpokePool → HubPool, relayed 2023-06-14) as stuck.

The tell was that it looked like a jackpot: five findings, one address, one narrow date range, all
in the last five days before Bedrock. A cluster that tidy is a bug signature, not a discovery — the
cross-check that settled it was `ETHWithdrawalFinalized` on the L1 bridge, which is the *other* side
of the same event and does not share the derivation. `legacyMessageValue()` now derives value from
the message selector, `legacyRelayed()` probes the zero-value key too, and both directions are
fixture-pinned on nonce 139216.

### 15. `cast logs` silently drops results when given a `null` topic placeholder
It returns zero hits rather than erroring. This produced a false "no burns exist" reading mid-
investigation. Use raw `eth_getLogs` for anything load-bearing.

### 15b. Polygon identifies a withdrawal only by `from`, so the watch-list alone is not enough
Every other scanner substring-matches `WATCH` against the raw message payload, which is why the
"add an address to `WATCH` and every scanner picks it up" rule in *Adding a chain or an address*
holds. Polygon is the exception and the rule did not survive contact with it: a PoS exit is an ERC20
burn to `0x0`, whose only identifying field is the burner. Across never burns from the SpokePool —
it transfers to **`PolygonTokenBridger` `0x0330E9b4…`**, which calls `withdraw()` — so scanning
`WATCH + spokePools` returned a clean zero for every HubPool return Polygon has ever made. Fixed
with `ChainConfig.extraSenders`. Any future sender-keyed chain needs the same treatment.

### 15c. A family with no scanner is not the same as a family with nothing to find
`zk-stack`, `scroll` and `linea` have verified, fixture-pinned L1 oracles but no L2 discovery
scanner. They also had no branch in the family dispatch, so they scanned nothing, produced no
findings, incremented no skip counter, and exited **0 — "scan complete, nothing unclaimed"**. The
whole point of separating exit 2 from exit 0 is that this cannot happen; it happened anyway,
because the guard was written for the *chain unreachable* case and an unimplemented family reaches
the end of the dispatch chain looking exactly like a completed one. Unhandled families now count as
skipped. If you add a family to `Family`, add its dispatch branch or accept exit 2.

### 16. Getting the outbox position wrong inverts the answer
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
  Classic has the same property under a different field — `L2ToL1Transaction`'s `uniqueId` (topic2) is
  the global counter, while `batchNumber` (topic3) is **not** and repeats across messages.

`coverage.exhaustive` is only `true` when there were no gaps **and** the independent check agreed.

**An empty sequence proves nothing.** Contiguity over zero observations used to evaluate to `true`,
so a wrong event address, a wrong topic0, or an endpoint that answered `[]` to everything satisfied
the cross-check vacuously and the scan was marked exhaustive on the strength of a zero corroborating
itself. Contiguity now requires at least two observations; below that the independent check is
reported as unavailable, `exhaustive` is `false`, and the coverage note says why. A genuinely empty
window therefore exits `2` rather than `0` — widen the range, or confirm by hand that the positions
either side are adjacent.

---

## Known gaps — read before trusting a zero

- **Polygon PoS is a real oracle** (corrected — an earlier version of this file said otherwise).
  The exit key is `keccak256(abi.encodePacked(blockNumber, nibbles(rlp(txIndex)), receiptLogIndex))`
  and is fully computable from the burn receipt: no Merkle proof, no proof-generator API. Verified
  round trip plus negative control, and pinned as a fixture. Two live caveats: `receiptLogIndex` is
  the index within *that receipt's* log array (every verified sample was 0, so nonzero is
  structurally certain but not empirically confirmed), and a burn to `0x0` is **necessary but not
  sufficient** — LayerZero OFT sends also burn, so the scanner requires the tx to have called
  `withdraw(uint256)`/`withdrawTo`. Recent burns are gated on `rootChain.getLastChildBlock()`;
  the checkpoint lag runs 15–40 minutes and without the gate every fresh burn reads as stuck.
- **Pre-Nitro Arbitrum now resolves, behind `--resolve-classic`.** Classic is keyed on the *pair*
  `(batchNumber, indexInBatch)` — `batchNumber` alone is not a message id — and `indexInBatch` is data
  **word 1**, not word 0, because the non-indexed `caller` occupies word 0. Status comes from matching
  L1 `OutBoxTransactionExecuted` logs, which is a wide L1 log scan and so is opt-in. It has its own
  control (`controls.executedClassic`): batch 16378 on Outbox2 is *partially* executed — indices
  4,5,6,7 claimed, 1,2,3 not — so a single query proves the oracle discriminates in both directions.
  Without `--resolve-classic`, classic candidates stay `unknown`; they are never resolved against the
  Nitro outbox, because the index spaces overlap and a cross-era `isSpent` answers confidently and
  wrongly in both directions.
- **Redstone (690) and Aleph Zero (41455)** SpokePool addresses could not be confirmed on-chain —
  both chains are sunset and their public RPCs are dead. Marked `verified: false`, and the
  `TokensBridged` sweep now reports `exhaustive: false` for an unverified address that returned zero
  logs: a zero from an address we cannot prove is the right address is not evidence. Any *hit* proves
  the address, and flips it to exhaustive.
- **zkSync, Scroll and Linea have oracles but NO L2 scanner**, so they are never actually scanned
  and always exit `2`. The zkSync and Linea oracles are verified and fixture-pinned (zkSync via
  `L1Nullifier` `0xD7f9f541…` — the upgraded L1SharedBridge, *not* the AssetRouter; Linea via
  `isMessageClaimed`); Scroll's oracle and key derivation are verified but unfixtured. Wiring
  `zkL1MessageSent` / the Scroll and Linea L2 messengers into `scanners.ts` is the open work.
- **Boba (288)** is an OVM 1.0 fork and so has a legacy era, but no RPC was available: its L1
  messenger address and migration parameters are entirely unconfirmed. Open item.
- **Arbitrum classic `path` derivation** (`2^proofLen − 1 − indexInBatch`) held 4/4 across two
  batches, but `proofLen` is not in the L2 event, so prefer L1 log-scanning over storage reads.
- **Solana** is out of scope; `SvmSpoke` emits Anchor/Borsh events with no EVM topic0. It is,
  however, *why* the EVM `TokensBridged` field became `bytes32`.
- **Non-EVM and CCTP/OFT paths** are not withdrawals in this sense and are excluded. Note that
  LayerZero OFT sends look superficially like burns and will not — and should not — appear.

---

## Adding a chain or an address

Watch-list: add to `WATCH` in `registry.ts`. Matching is a raw-payload substring search, so a new
address is picked up by every scanner without touching the core — **except Polygon**, which keys on
the burn's `from` and needs the address in `WATCH`, `spokePools` or `extraSenders` to see it at all
(see failure mode 15b). Any contract that withdraws *on our behalf* belongs in `extraSenders`.

New chain: add a `ChainConfig` to `CHAINS`, list its SpokePools in `spokePools.ts`, and set
`eraBoundaryBlock` if it has a fork boundary. If you do not know the OP portal address, leave it
unset — `derivePortal()` resolves it on-chain via
`L2StandardBridge.otherBridge() → L1StandardBridge.messenger() → L1XDM.portal()`, which is more
trustworthy than a copied constant.

Then — and this is the part that is easy to skip — populate `controls` for that chain with a
**known-claimed** message, or the scanner will (correctly) refuse to report anything on it and every
candidate will come back `unknown`. Find one by reading the relevant L1 claim event
(`WithdrawalFinalized`, `OutBoxTransactionExecuted`, …) and confirming the oracle returns `true` for
it. Finally add a fixture — ideally one claimed and one *permanently* unclaimed case — and confirm
`--verify-fixtures` passes. Prefer permanent negatives: a negative pinned to a live withdrawal is only
valid until somebody claims it, and must be marked `mutable: true` so a later claim reports as DRIFT
rather than failing the suite.
