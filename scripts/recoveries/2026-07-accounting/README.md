# Stuck-token recovery — July 2026 (ACX, UMA, DAI, WBTC)

Second batch of the [June 2026 recovery](../2026-06-accounting/README.md): recovers ~24,690 ACX + ~7,400 UMA + ~70,109 DAI + 0.327 WBTC stranded on the OP, Polygon, zkSync, Base, Arbitrum and Blast SpokePools. All pairs except Base DAI were stranded by the same pre-SDK-4.4.0 `HubPoolClient.getRunningBalanceBeforeBlockForChain` bug (implicit-zero running balance after an inter-bundle gap exceeded the dataworker lookback; fixed in relayer `ba47ba115`). The Base DAI surplus is a different, non-reset-bug orphan class (see Evidence). These (chain, token) pairs were not included in the June tree.

## Evidence

Each stranded amount is the sum of running balances that were carried in one executed root bundle and then treated as zero at the token's next bundle inclusion, with `netSendAmount = 0` in between (i.e. the funds never left the spoke). Every amount reconciles against its forgotten running balances **to the wei**.

For the ACX/UMA pairs, all accounted flows have settled: the final wind-down sweeps (mainnet bundles `0x8dfbddc3…5c74` / `0x1b1174…9b3d`, executed 2026-07-06) returned every remaining *accounted* token, their L2 refund leaves have executed (OP `0xcbf0a7…586d`, Arbitrum `0x31f90d…8e09f`, Polygon `0x9da832…18dd`), and on-chain running balances are 0 — so the full spoke balances equal the orphans.

For the still-active DAI (zkSync) and WBTC (Blast) pairs, the orphan is the exact excess of the spoke balance over the accounted running balance (`balanceOf(spoke) − |runningBalance|`); the leaf takes only that excess, leaving the accounted portion untouched for normal refunds.

| Spoke | Token | Forgotten runningBalance (wei) | Carried in bundle (mainnet tx) | Zeroed by bundle (block, gap) |
| --- | --- | --- | --- | --- |
| Optimism | UMA | 999492284576218127191 | `0xfd9acb…1006` (blk 22917520, ≈2025-07) | blk 23856655, 130d gap |
| Optimism | UMA | 1101649369852406323249 | `0x6ec51d…d72a` (blk 24941170, ≈2026-04) | blk 25184397, 34d gap |
| Optimism | UMA | 2942660627103988454 | direct transfer; mirrors the identical UMA amount stranded on the deprecated V2 spoke `0xa420…F8C9` | n/a |
| Optimism | ACX | 6044254772739957081473 | `0x16c5e3…a210` (blk 22744897, ≈2025-06) | blk 23069371, 45d gap |
| Optimism | ACX | 5000000000000000000000 | `0x92aef6…4f32` (blk 23878229, ≈2025-11) | blk 24239870, 50d gap |
| Optimism | ACX | 6949506027059105048594 | `0x757a84…7b2d` (blk 24671692, ≈2026-03) | blk 25045681, 52d gap |
| Polygon | UMA | 4166163890795162948426 | `0x8d6046…adb9` (blk 23371686, ≈2025-09) | blk 23650213, 39d gap |
| Polygon | ACX | 838422581089185877133 | `0xa16838…d303` (blk 22600374, ≈2025-06) | blk 23233811, 88d gap |
| zkSync | DAI | 70005067780472529239685 | `0x56c621…de5c` (blk 24643352, ≈2026-03) | blk 24917820, 38d gap |
| Arbitrum | ACX | 857586666373984114017 | `0x3ed758…a792` (blk 23428151, ≈2025-09) | blk 23652966, 31d gap |
| Arbitrum | ACX | 5000000000000000000000 | `0x9b29f8…8e3a` (blk 24005724, ≈2025-12) | blk 24372461, 51d gap |
| Arbitrum | UMA | 130009947778364550998 | `0x679521…092e` (blk 21668850, ≈2025-01) | blk 23174250, 209d gap |
| Arbitrum | UMA | 1000000000000000000000 | `0x909c90…1d56` (blk 24194264, ≈2026-01) | blk 24573368, 53d gap |
| Blast | WBTC | 31497464 | `0x60a7b4…5b03` (blk 24061173, ≈2025-12) | blk 24339200, 39d gap |
| Blast | WBTC | 1197201 | `0x6af244…7cb1` (blk 24435354, ≈2026-02) | blk 24772651, 47d gap |

**Base DAI (leaf 5) — non-reset-bug orphan.** Found 2026-07-21 by direct balance reconciliation
(`balanceOf(spoke) − |runningBalance|`) across every UMA/ACX/DAI/WBTC deployment. The Base spoke
holds exactly 104.108320736509705114 DAI with runningBalance 0: the 2026-07-06 wind-down sweep
(mainnet blk 25480416, netSend −88,907.55 vs rb −88,914.34) returned only the *accounted* balance,
and the DAI/Base pool-rebalance route was retired on 2026-07-21 (blk 25582041), so no bundle can
ever move the remainder. The reset bug is excluded as the cause: 4,825 DAI-carrying Base bundles
since blk 22M with no inter-bundle gap above ~5.5 days, so the lookback was never exceeded. The
spoke's DAI balance last touched zero on 2025-09-01; the surplus accumulated unaccounted during
normal operation after that (never-bundled-flow class, like the Arbitrum BADGER 10.0 — exact
source attribution would need a bundle-by-bundle replay). Post-sweep netSend mints reconcile 1:1
against refund payouts, so the surplus is static.

Reconciliation (live SpokePool balances, 2026-07-07; re-verified wei-exact 2026-07-21 @ mainnet blk 25583166 — all diffs are 0 wei):

| leafId | symbol | chainId | l2Token | amount |
| --- | --- | --- | --- | --- |
| 0 | UMA | 10 | `0xE7798f02…77Ea` | 2,104.084315055728438894 UMA |
| 1 | ACX | 10 | `0xFf733b2A…1b76B` | 17,993.760799799062130067 ACX |
| 2 | UMA | 137 | `0x30668188…B731` | 4,166.163890795162948426 UMA |
| 3 | ACX | 137 | `0xF328b73B…D8FC` | 838.422581089185877133 ACX |
| 4 | DAI | 324 | `0x4B9eb6c0…b656` | 70,005.067780472529239685 DAI |
| 5 | DAI | 8453 | `0x50c57259…B0Cb` | 104.108320736509705114 DAI |
| 6 | ACX | 42161 | `0x53691596…C99d` | 5,857.586666373984114017 ACX |
| 7 | UMA | 42161 | `0xd693Ec94…3b22` | 1,130.009947778364550998 UMA |
| 8 | WBTC | 81457 | `0xF7bc58b8…2692` | 0.32694665 WBTC |

Totals: 24,689.770047262232121217 ACX + 7,400.258153629255938318 UMA + 70,109.176101209038944799 DAI + 0.32694665 WBTC.

For the settled ACX/UMA pairs, amounts equal the full current spoke balances; with running balances at 0 and routes wound down, no bundle can move these tokens, so balances can only grow (dust) before execution. For zkSync DAI: the accounted `runningBalance = −898.275777` (2026-07-07) has since been pulled back — rb is now 0 (blk 25481195) and `balanceOf` equals the leaf amount exactly. Base DAI likewise: rb 0, `balanceOf` equals the leaf exactly. For Blast WBTC: `balanceOf = 0.37857072`, accounted `−0.05162407` → excess exactly the leaf amount.

## Investigated, nothing to recover

- **LGHO/WGHO (Lens, 232)** — fully recovered already: June leaf 5 (46,185.977901592957 WGHO) executed 2026-07-01 (Lens tx `0xc78411…2140`) and landed on L1; the remaining *accounted* 25,735.941223310944 WGHO returned via the 2026-07-06 sweep (Lens tx `0x8d2b80…8d97`) and has arrived at the HubPool (balance − liquidReserves matches it exactly, pending `sync()`). Lens SpokePool WGHO and native GHO balances are both 0.
- A full audit of every (chain, token) pair that ever had a pool rebalance route (116 pairs, 24 EVM chains, 2026-07-07) found no further reset-bug strandings beyond this tree.
- A direct balance-reconciliation sweep of every UMA/ACX/DAI/WBTC deployment (2026-07-21) found only the Base DAI orphan (now leaf 5) beyond the tree. WBTC on OP/Polygon/zkSync/World Chain/Mode/Linea reconciles to a surplus of exactly 0; an apparent 0.006 WBTC surplus on Arbitrum was an in-flight deposit landing minutes before the scan. Remaining unaccounted dust, deliberately not recovered: 0.0104 DAI (Ethereum spoke), 0.0307 DAI (Polygon), 0.00062107 WBTC (Ethereum spoke).

## Deliberately excluded (pending scope decision)

- **POOL on Scroll (534352)** — 715.653802514570613085 POOL stranded on `0x3baD7AD0…Dd96` by the same bug (forgotten running balances 622.761680162294437432 + 92.892122352276175653, wei-exact).
- **BADGER** — 20.267293865883499827 stranded on the Ethereum spoke since July 2022 (route removed with the running balance never returned; balance equals the final 2022 running balance exactly), plus 10.0 unaccounted BADGER on the Arbitrum spoke and a 20.224242055436978582 BADGER refund liability (positive running balance — hub owes relayers) that predates the reset bug.

Scroll (534352) sorts after 81457 and chain 1 sorts first, so either can be added without disturbing the existing leaf order prefix beyond renumbering.

## The 9 leaves (UMIP canonical order)

A single 9-leaf merkle tree under `relayerRefundRoot = 0xc2272e649b5d9354b6e56778ace362a0b3fdb4477d60db5360609198788a7205`. (Supersedes the earlier 8-leaf root `0x61bdfa33…fe0fca`, never relayed, which lacked the Base DAI leaf.)

Each leaf matches `SpokePoolInterface.sol`'s `RelayerRefundLeaf` struct 1:1 (empty `refundAmounts`/`refundAddresses`); leaf hash = `keccak256(abi.encode(leaf))`; tree built via `@across-protocol/contracts`' `MerkleTree`.

## Mechanism

1. HubPool admin calls `multicall([relaySpokePoolAdminFunction(chainId, encoded(relayRootBundle(ROOT, 0x0))) × 6])` — same `ROOT` to each of OP (10), Polygon (137), zkSync (324), Base (8453), Arbitrum (42161), Blast (81457).
2. After cross-domain delivery, permissionless `SpokePool.executeRelayerRefundLeaf(rootBundleId, leaf, proof)` triggers `_bridgeTokensToHubPool(l2Token, amountToReturn)` for each leaf destined to that spoke.
3. After per-chain withdrawal challenge expires, standard `src/finalizer/` infrastructure claims to L1. After arrival, `HubPool.sync(l1Token)` (or any LP action) folds the tokens back into `liquidReserves`.

## Verify before signing

### 1. Validate `leaves.json` produces the documented root

```sh
yarn ts-node scripts/recoveries/2026-07-accounting/verify.ts
```

Rebuilds the merkle tree from `leaves.json`, confirms the rebuilt root matches the documented `relayerRefundRoot`, and validates each per-leaf proof.

### 2. Validate the multisig transaction matches what is proposed

The Safe transaction must, when executed by the HubPool admin, emit exactly **6 `SpokePoolAdminFunctionTriggered` events** from `0xc186fA914353c44b2E33eBE05f21846F1048bEda` (HubPool). Simulate it (Tenderly / forked-mainnet) and confirm the emitted log set matches the table below.

Event signature: `SpokePoolAdminFunctionTriggered(uint256 indexed chainId, bytes message)`

- **topic[0]** (all 6 events): `0x218987b934c2f6bc596136829fbf43a5fef4d6fafce41f3f6254d9a870c2deec`
- **`message` field** (all 6 events, identical 68-byte payload): `0x493a4f84c2272e649b5d9354b6e56778ace362a0b3fdb4477d60db5360609198788a72050000000000000000000000000000000000000000000000000000000000000000`
  - selector `0x493a4f84` = `relayRootBundle(bytes32,bytes32)`
  - first arg = `relayerRefundRoot` = `0xc2272e649b5d9354b6e56778ace362a0b3fdb4477d60db5360609198788a7205`
  - second arg = `slowRelayRoot` = `0x0`
- **topic[1]** (`chainId`, one per event):

| Event | Chain | topic[1] |
| --- | --- | --- |
| 1 | Optimism (10) | `0x000000000000000000000000000000000000000000000000000000000000000a` |
| 2 | Polygon (137) | `0x0000000000000000000000000000000000000000000000000000000000000089` |
| 3 | zkSync (324) | `0x0000000000000000000000000000000000000000000000000000000000000144` |
| 4 | Base (8453) | `0x0000000000000000000000000000000000000000000000000000000000002105` |
| 5 | Arbitrum (42161) | `0x000000000000000000000000000000000000000000000000000000000000a4b1` |
| 6 | Blast (81457) | `0x0000000000000000000000000000000000000000000000000000000000013e31` |

### 3. Import the prepared Safe transaction

[`safe-tx.json`](./safe-tx.json) is a Safe Transaction Builder import (Safe `0xB524735356985D2f267FA010D681f061DfF03715`, mainnet) containing the single call: `HubPool.multicall([relaySpokePoolAdminFunction(cid, 0x493a4f84 ++ ROOT ++ 0x00…00) for cid in (10, 137, 324, 8453, 42161, 81457)])` — `to = 0xc186fA914353c44b2E33eBE05f21846F1048bEda`, `value = 0`, operation `CALL`. Same shape as the June batch execution (`0x7697a76f…560e29e7`). `safeTxHash` at Safe nonce **453** (on-chain nonce, 2026-07-21, post route-retirement): `0x4fc992bc3ce09e6c1ccbf15db50ccd4364efd810537e9cfdb50a19df20455096` — recompute via `Safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, 0x0, 0x0, nonce)` if the nonce has moved.

### 4. Re-check the spoke balances

For the settled ACX/UMA pairs and both DAI pairs (zkSync rb pulled back to 0; Base route retired 2026-07-21), leaf amounts equal the exact stranded balances — a balance *above* the leaf amount is fine (excess stays on the spoke); below means something moved and the tree must be rebuilt. For Blast WBTC (still-active pair), re-verify `balanceOf(spoke) − |current runningBalance| ≥ leaf amount` before signing. All nine were last re-verified 2026-07-21 @ mainnet blk 25583166 with zero slack.
