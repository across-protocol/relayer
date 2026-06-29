# Stuck-token recovery — June 2026

Recovers ~$50K of L2 SpokePool balances stuck due to a bug in `@across-protocol/sdk`'s `HubPoolClient.getRunningBalanceBeforeBlockForChain`, fixed in **SDK 4.4.0** (relayer commit `ba47ba115`).

## Root cause

Pre-4.4.0, the SDK returned `runningBalance = 0` whenever no `RootBundleExecuted` event for a given (chain, l1Token) pair was in the dataworker's cache. Any pair whose **inter-bundle gap exceeded the lookback window** got an implicit-zero baseline, and subsequent bundles' `netSendAmount` was computed against incorrect history — drift accumulated on L2 vaults. The fix adds a paginated `RootBundleExecuted` query from `deploymentBlock` when the cache misses; this recovery clears the historical residuals.

## The 12 leaves (UMIP canonical order)

A single 12-leaf merkle tree under `relayerRefundRoot = 0x5c677c67dda35989ef11b0a131b1742c892fa23d6904e5c65d0dc3bb655a59c2`.

| leafId | symbol | chainId | l2Token | amount |
| --- | --- | --- | --- | --- |
| 0 | POOL | 10 | `0x395Ae52b…e125` | 787.26 POOL |
| 1 | VLR | 10 | `0x4e107a00…fc74` | 348.54 VLR |
| 2 | SNX | 10 | `0x8700dAec…99B4` | 14,900.26 SNX |
| 3 | BAL | 10 | `0xFE8B128b…9921` | 1,716.48 BAL |
| 4 | POOL | 137 | `0x25788a1a…4CF6` | 4,430.19 POOL |
| 5 | LGHO | 232 | `0x6bdc36e2…05e2f` | 46,185.98 WGHO |
| 6 | POOL | 480 | `0x7077C71B…dC57` | 940.38 POOL |
| 7 | BAL | 8453 | `0x4158734D…47F1` | 1,273.15 BAL |
| 8 | VLR | 8453 | `0x4e107a00…fc74` | 101.34 VLR |
| 9 | POOL | 8453 | `0xd652C542…afc3` | 416.33 POOL |
| 10 | BAL | 42161 | `0x040d1EdC…56B8` | 2,391.45 BAL |
| 11 | POOL | 42161 | `0xCF934E24…B79C` | 470.85 POOL |

Totals: 5,381 BAL + 7,045 POOL + 14,900 SNX + 450 VLR + 46,186 WGHO/LGHO. Each leaf matches `SpokePoolInterface.sol`'s `RelayerRefundLeaf` struct 1:1; leaf hash = `keccak256(abi.encode(leaf))`; tree built via `@across-protocol/contracts`' `MerkleTree`.

## Mechanism

1. HubPool admin calls `multicall([relaySpokePoolAdminFunction(chainId, encoded(relayRootBundle(ROOT, 0x0))) × 6])` — same `ROOT` to each of OP (10), POL (137), Lens (232), World (480), Base (8453), ARB (42161).
2. After cross-domain delivery (1–7d), permissionless `SpokePool.executeRelayerRefundLeaf(rootBundleId, leaf, proof)` triggers `_bridgeTokensToHubPool(l2Token, amountToReturn)` for each leaf destined to that spoke. Other-chain leaves are rejected at `SpokePool.sol:1204`.
3. After per-chain withdrawal challenge expires, standard `src/finalizer/` infrastructure claims to L1.

## Multisig transaction

- **Target**: `0xc186fA914353c44b2E33eBE05f21846F1048bEda` (HubPool)
- **Value**: 0
- **Method**: `multicall(bytes[])` with 6 inner `relaySpokePoolAdminFunction` calls, each carrying the same `relayerRefundRoot`
- **Calldata**: `multicall.json` (Safe Transaction Builder JSON; drag into Safe UI)

Selectors verifiable via `cast 4byte`:

| Selector | Function |
| --- | --- |
| `0xac9650d8` | `multicall(bytes[])` |
| `0xdd70e5e8` | `relaySpokePoolAdminFunction(uint256,bytes)` |
| `0x493a4f84` | `relayRootBundle(bytes32,bytes32)` |

## Verify before signing

```sh
yarn ts-node scripts/recoveries/2026-06-stuck-token-recovery/verify.ts
```

Rebuilds the merkle tree from `leaves.json`, confirms its root matches the one relayed in `multicall.json`, and validates each per-leaf proof.
