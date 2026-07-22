# Stranded-refund recovery — Solana SpokePool, July 2026 incident (13,832.309134 USDC)

Repays the relayer refunds stranded when the 2026-07-17 incident's two poisoned root bundles
were abandoned. A single SVM relayer refund leaf with **no `amountToReturn`** — nothing moves to
the HubPool — leaving exactly **236.090934 USDC** in the vault backing the 5 outstanding
`ClaimAccount`s. One of the two affected relayers (CBG4) was already compensated off-protocol on
the incident afternoon — evidence below — so the leaf pays the full available amount to the
other (E4bX, the Risk Labs relayer).

## The leaf

A single-leaf tree under `relayerRefundRoot = 0x022285d1b98169fa68340f2415eddd6b23e045b9b72fe62ac188116c31be31a1`
(single leaf ⇒ root = leaf hash, `proof = []`).

| Field             | Value                                                 |
| ----------------- | ----------------------------------------------------- |
| `amountToReturn`  | `0`                                                   |
| `chainId`         | `34268394551451`                                      |
| `mintPublicKey`   | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC) |
| `refundAddresses` | `E4bX4nCwe2GcKqt9NpofnXVrCeRp37PAMaiZtV9x3kxC`        |
| `refundAmounts`   | `13832309134` (13,832.309134 USDC)                    |
| `leafId`          | `0`                                                   |

Leaf hash = `keccak256(64 zero bytes ‖ borsh(leaf))`, matching the svm-spoke program's
verification (`programs/svm-spoke`, `verify_merkle_proof`); exact preimage in
[`leaves.json`](./leaves.json). Alternative two-recipient variant, only if CBG4's off-protocol
compensation is ever unwound (`refundAmounts ["13097475478", "734833656"]`, addresses
`[E4bX, CBG4]`): root `0xef1fab94e29947c550d5c95f0b59abe56f771c254286ccd1144c44e9ca6cfd95`.

## The condition this repayment rests on — provable from chain data

> The relayers made valid fills that were recognised by the protocol but which could not be
> repaid due to the coincidence of the relayer attack.

1. **Valid fills.** 17 fills, each listed in [`stranded_fills.csv`](./stranded_fills.csv) with
   its deposit tx (a real, escrowed deposit: 11 Solana-origin USDC deposits, ids 113014–113025,
   plus 6 Ethereum→Solana deposits, ids 4160927–4161139) and its fill tx (the relayer delivered
   the output to the recipient). Every fill elected `repaymentChainId = 34268394551451`.
   Entitlements: `E4bX…3kxC` **64,153.191307** (12 fills), `CBG4…1jUF` **734.833656** (5 fills).
2. **Recognised by the protocol.** Every one of these fills falls inside the evaluation ranges
   of the two bundles with spoke `rootBundleId`s 12662/12663 — Solana slot ranges
   `[433416232, 433424785]`, read from each `ProposedRootBundle` event's
   `bundleEvaluationBlockNumbers` (proposal txs
   `0x46f5926a5cb691cdf604fda01a16eff05158318c09e8830aef8d23c2ed2210bb` and
   `0xd9361db63d710a96de1af115037af6432ed3cb6a745c0956ba55b77758b806f5`). Both bundles passed
   the optimistic challenge window and were **executed on the HubPool** (txs `0x86e682e5…`,
   `0xd56b0540…`, 2026-07-17 06:14/06:47 UTC) — the protocol accepted the repayment
   obligations. The validity of these 17 repayments is independent of the forged content that
   poisoned the same bundles: an honest proposer would have included them identically.
3. **Could not be repaid.** The two bundles' Solana refund leaves were never executed, and could
   not be: their obligations were computed against ≈36.69M USDC of phantom deposit inflows
   (`netSendAmounts` −36,243,505.321905 and −445,702.471769 that never materialised), far in
   excess of the vault. No `ExecutedRelayerRefundRoot` exists for `rootBundleId` 12662 or 12663.
4. **Never repaid since — exact partition.** Every valid fill electing Solana repayment from
   05:01 UTC through the corrected chain's coverage is either one of the 17 stranded fills or is
   accounted, to the micro-dollar, by the corrective leaf executed at 13:54 UTC (Solana tx
   `2kPBJ5xd…`): for E4bX, 64,153.191307 (stranded) + 13,326.499700 (leaf payment) =
   **77,479.691007** = the sum of all its valid Solana-repayment fills in the window; for CBG4,
   734.833656 + 2,457.730607 = **3,192.564263** likewise. Later Solana leaves paid only two
   expired-deposit refunds (385.686428) and 1.999923 for a fill in their own ranges. LP fees on
   all affected routes are zero (every leaf payment equals a raw sum of fill input amounts), so
   repayment = fill input amount.
5. **The cap, and CBG4's prior compensation.** The stranded entitlement totals 64,888.024963,
   but the vault holds only 13,832.309134 above the ClaimAccount backing — the balance of the
   abandoned-window value was already swept to the HubPool on 2026-07-22. CBG4 was **already
   compensated off-protocol**, verified on both legs:
   - **Origin (Ethereum):** tx
     `0xed75fc80ac1793e308449f51609162f3f90b73fca09b88d070e004bb3ecfb76e`, block 25552651,
     2026-07-17 13:17:11 UTC, `from 0x837219D7a9C666F5542c4559Bf17D7B804E5c5fe`; its receipt's
     USDC `Transfer` logs move exactly **735.50 USDC** (the 734.833656 entitlement rounded up)
     into Mayan's forwarder/Swift contracts.
   - **Destination (Solana):** tx
     `2VNwQpsQGnEGLtq6FdXQWs8Qs3zopxK5niQjytXWCr85ZASLm6oyavh6eTSQ5GG3uYd3Gt9BE8dbpXF3gvJ4hxeU`,
     slot 433488475, 2026-07-17 13:17:40 UTC — a Mayan Swift `Fulfill` (order
     `Av8QA74PbQM6Dsm2DURq8x7dxxKNxY7ZqqpN96cQKJgK`) crediting **735.159139 USDC** to
     `7sySr1xbgnyXSykAELE7gir5RxSUwVagfSL6bni9ZCaG`, CBG4's USDC associated token account.
   - **Sender identity:** the Council Safe `0xB524735356985D2f267FA010D681f061DfF03715` reports
     the origin sender among its owners via `getOwners()` (checked 2026-07-22), and the address
     is listed in `across-protocol/contracts`' `script/safe-multisig/config.json`.
   This leaf therefore pays the full available **13,832.309134 to E4bX** (of its 64,153.191307);
   its uncovered 50,320.882173 remains a claim against the HubPool, settled off-chain.

## Why the vault balance is free to pay this

- The vault (`HYhZwef…k3Ru`, USDC ATA of state PDA `3tzNXZ…wnkz`) holds **14,068.400068** (slot
  434540333, finalized); deposits and fills are paused; `TransferLiability = 0`.
- Bundle accounting for Solana is settled at zero: the 2026-07-22 pool leaf (mainnet tx
  `0xafe4fd8a…`) carries `runningBalances [0]`, its return executed and bridged on Solana
  (tx `2fE3ZDCJ…`), and cumulatively Σ hub-instructed returns = Σ `TokensBridged` =
  **7,816,961.112666** exactly (excluding the two abandoned bundles). The residual is invisible
  to the dataworker and will never be swept by it.
- The only on-chain claims are the 5 `ClaimAccount`s totalling **236.090934** (= Σ deferred
  `ExecutedRelayerRefundRoot` amounts 511.777577 − Σ `ClaimedRelayerRefund` 275.686643), left
  untouched. Available = 14,068.400068 − 236.090934 = **13,832.309134** = Σ `refundAmounts`,
  invariant to claims being exercised before execution (a claim reduces the vault and the claim
  total equally).
- Origin of the residual: the abandoned bundles ingested 63,811.518504 of real deposits
  (ids 113014–113025) into books that were written off wholesale — only their 50,000 carried
  balance survived into the corrected chain. Identity on the first corrected bundle (hub tx
  `0xdf8d8c2c…`): −50,000 − 14,862.365817 (Σ deposits 113026–113060, the skipped ranges) +
  15,815.270212 (its executed refund leaf) = **−49,047.095605**, its exact on-chain running
  balance. Full per-deposit fill/refund resolution: [`deposits.csv`](./deposits.csv).

## Mechanism

One Safe batch of **three** HubPool `relaySpokePoolAdminFunction(34268394551451, message)` calls
(exact payloads in `leaves.json` → `adminMessages`), delivered to the SVM spoke via the Solana
adapter / CCTP. No pool rebalance leaf, no bond, no liveness window.

1. `emergencyDeleteRootBundle(12662)` and `emergencyDeleteRootBundle(12663)` — closes the two
   **poisoned root bundles relayed during the incident** (refund roots `0x34d80ac0…`/
   `0xb6a5b07e…`, relayed in Solana txs `9vQRMzpg…`/`4yxMmpTQ…`). Each carries a single Solana
   USDC refund leaf (refunds aggregate per relayer): reconstructed contents ≈**2,645,780** for
   12662 and ≈**871,452** for 12663 — dominated by E4bX repayments for forged-deposit fills
   already written off in the incident books — plus phantom `amountToReturn`s of
   **36,243,505.321905** and **445,702.471769** (see `leaves.json` →
   `poisonedRootBundlesNote`). Leaf execution only requires vault balance ≥ the leaf's refund
   total, and a relayed root never expires: not executable against today's ~14k, but if the
   spoke is ever un-paused and holds working balances again, execution would double-pay the
   written-off repayments and queue ≈36.69M of phantom `TransferLiability` — after which any
   caller can continuously bridge every future vault dollar to the HubPool. Deleting both now,
   while the spoke is paused, closes this permanently. (The `slowRelayRoot` is the bundle's single global tree relayed
   identically to every spoke: 12662's non-zero slow root `0x09691006…` contains exactly one
   leaf — a Base WETH slow fill, deposit 4160878, request tx `0x3dc59c6d…`, since
   fast-filled — and nothing executable on Solana, as `execute_slow_relay_leaf` rebuilds the
   leaf hash with the spoke's own `state.chain_id`; 12663's slow root is `0x0`.)
2. `relayRootBundle(0x022285d1…, 0x0)` — stores the recovery root (`relay_root_bundle`).
3. After cross-domain delivery, confirm via `verify.ts` that both poisoned bundles read
   **deleted** and the recovery root is stored, then permissionless
   `execute_relayer_refund_leaf(rootBundleId, leaf, [])` transfers 13,832.309134 USDC
   vault → E4bX's USDC ATA. The leaf is fully funded, so the standard finalizer can execute it
   once relayed; a manual fallback passes the refund ATA (printed by `verify.ts`) as the
   remaining account. `amountToReturn = 0` ⇒ no bridge step.

## Verify before signing

### 1. Validate `leaves.json` produces the documented root, against live chain state

```sh
tsx scripts/recoveries/2026-07-solana-residual/verify.ts
```

Rebuilds the SVM leaf hash from `leaves.json` (keccak256 of 64 zero bytes ‖ borsh(leaf)),
confirms it equals the documented root, requires deposits/fills to still be paused, and
re-derives the payable amount from live state: vault balance − Σ USDC `ClaimAccount`s (mint
membership proven by PDA re-derivation; fails on any unknown claim account) − pending
`TransferLiability` must equal the leaf total. It also reports the live status of the two
poisoned root bundles (12662/12663) — **both must read deleted before the recovery leaf is
executed**. **Re-run immediately before executing the leaf on Solana** — the program's
execution path checks only raw vault balance ≥ refund total, and a relayed root has no
execution deadline.

### 2. Validate the multisig transaction matches what is proposed

The Safe transaction must, when executed by the HubPool admin, emit exactly **3
`SpokePoolAdminFunctionTriggered` events** from `0xc186fA914353c44b2E33eBE05f21846F1048bEda`
(HubPool). Simulate it (Tenderly / forked mainnet) and confirm:

Event signature: `SpokePoolAdminFunctionTriggered(uint256 indexed chainId, bytes message)`

- **topic[0]** (all 3 events): `0x218987b934c2f6bc596136829fbf43a5fef4d6fafce41f3f6254d9a870c2deec`
- **topic[1]** (`chainId`, all 3 events):
  `0x00000000000000000000000000000000000000000000000000001f2abb7bf89b` (= 34268394551451)
- **`message` fields**, in order:
  1. `0x8a7860ce0000000000000000000000000000000000000000000000000000000000003176`
     — `emergencyDeleteRootBundle(uint256)` (selector `0x8a7860ce`), arg = 12662
  2. `0x8a7860ce0000000000000000000000000000000000000000000000000000000000003177`
     — `emergencyDeleteRootBundle(uint256)`, arg = 12663
  3. `0x493a4f84022285d1b98169fa68340f2415eddd6b23e045b9b72fe62ac188116c31be31a10000000000000000000000000000000000000000000000000000000000000000`
     — `relayRootBundle(bytes32,bytes32)` (selector `0x493a4f84`), first arg =
     `relayerRefundRoot` = `0x022285d1…31be31a1`, second arg = `slowRelayRoot` = `0x0`

The simulation should also emit the Solana adapter's CCTP `MessageSent` events carrying the
translated payloads to the SVM spoke's message transmitter.

Post-execution check: vault balance = Σ live `ClaimAccount` amounts (equals 236.090934 only if
no claim was exercised in the interim — claiming is not pause-gated and reduces both sides
equally); E4bX USDC ATA +13,832.309134.
