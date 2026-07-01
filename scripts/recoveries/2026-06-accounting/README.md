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

## Verify before signing

### 1. Validate `leaves.json` produces the documented root

```sh
yarn ts-node scripts/recoveries/2026-06-accounting/verify.ts
```

Rebuilds the merkle tree from `leaves.json`, confirms the rebuilt root matches the documented `relayerRefundRoot`, and validates each per-leaf proof.

### 2. Validate the multisig transaction matches what is proposed

The Safe transaction must, when executed by the HubPool admin, emit exactly **6 `SpokePoolAdminFunctionTriggered` events** from `0xc186fA914353c44b2E33eBE05f21846F1048bEda` (HubPool). Simulate it (Tenderly / forked-mainnet) and confirm the emitted log set matches the table below.

Event signature: `SpokePoolAdminFunctionTriggered(uint256 indexed chainId, bytes message)`

- **topic[0]** (all 6 events): `0x218987b934c2f6bc596136829fbf43a5fef4d6fafce41f3f6254d9a870c2deec`
- **`message` field** (all 6 events, identical 68-byte payload): `0x493a4f845c677c67dda35989ef11b0a131b1742c892fa23d6904e5c65d0dc3bb655a59c20000000000000000000000000000000000000000000000000000000000000000`
  - selector `0x493a4f84` = `relayRootBundle(bytes32,bytes32)`
  - first arg = `relayerRefundRoot` = `0x5c677c67dda35989ef11b0a131b1742c892fa23d6904e5c65d0dc3bb655a59c2`
  - second arg = `slowRelayRoot` = `0x0`
- **topic[1]** (`chainId`, one per event):

| Event | Chain | topic[1] |
| --- | --- | --- |
| 1 | OP (10) | `0x000000000000000000000000000000000000000000000000000000000000000a` |
| 2 | POL (137) | `0x0000000000000000000000000000000000000000000000000000000000000089` |
| 3 | Lens (232) | `0x00000000000000000000000000000000000000000000000000000000000000e8` |
| 4 | World (480) | `0x00000000000000000000000000000000000000000000000000000000000001e0` |
| 5 | Base (8453) | `0x0000000000000000000000000000000000000000000000000000000000002105` |
| 6 | ARB (42161) | `0x000000000000000000000000000000000000000000000000000000000000a4b1` |

If a simulation shows fewer/more than 6 events, a different `message` payload, an emitter other than the HubPool, or any chainId outside the set above, **do not sign**.

## Execution record

The multisig relayed the root to all 6 spokes, and every `RelayerRefundLeaf` was executed permissionlessly. All 12 `amountToReturn` bridges to the HubPool are initiated; funds then ride each chain's native L2→L1 window before the finalizer claims them to L1.

| Leaf | Chain | Amount | Execution tx |
| --- | --- | --- | --- |
| 0 | Optimism (10) | 787.2553 | [0x42947a73…c560b141](https://optimistic.etherscan.io/tx/0x42947a73631a6c4ced993d36e16e8c022aea79b8cfcbd7ffa04fc182c560b141) |
| 1 | Optimism (10) | 348.5436 | [0x72b5dc18…b5d25fa9](https://optimistic.etherscan.io/tx/0x72b5dc188d2c6054f058a73af71e804b7fbf3a6552be187085b97ddcb5d25fa9) |
| 2 | Optimism (10) | 14900.2593 | [0x8bfd314b…f1ad588f](https://optimistic.etherscan.io/tx/0x8bfd314b1a857056a28968b9f92d836f130841bf7547db4de2d14fe2f1ad588f) |
| 3 | Optimism (10) | 1716.4785 | [0x1bdb9b83…428ed135](https://optimistic.etherscan.io/tx/0x1bdb9b83ad5d31b88df9a90745d56efeecb5cb5c2d84c5ca106e52f3428ed135) |
| 4 | Polygon (137) | 4430.1895 | [0xc56f57ab…ecda2670](https://polygonscan.com/tx/0xc56f57abffbd799b03fcee152adc5606b934ea912734623110ae269becda2670) |
| 5 | Lens (232) | 46185.9779 | [0xc78411ad…953c2140](https://explorer.lens.xyz/tx/0xc78411ad413c7c4b7f0853a74635b7c67345b8299e53b2367f7e8311953c2140) |
| 6 | World Chain (480) | 940.3824 | [0xd42ba0b5…cf5593b0](https://worldchain-mainnet-explorer.alchemy.com/tx/0xd42ba0b58b6e0dfa0843d21620618c46ab9bdb877a9fdd19d0d760b5cf5593b0) |
| 7 | Base (8453) | 1273.1531 | [0x49bfd7b6…8adaf8a9](https://basescan.org/tx/0x49bfd7b6d5b67881437875a0237478d5bdd55458c44b4ef49c3e24808adaf8a9) |
| 8 | Base (8453) | 101.3445 | [0x49bfd7b6…8adaf8a9](https://basescan.org/tx/0x49bfd7b6d5b67881437875a0237478d5bdd55458c44b4ef49c3e24808adaf8a9) |
| 9 | Base (8453) | 416.3322 | [0x49bfd7b6…8adaf8a9](https://basescan.org/tx/0x49bfd7b6d5b67881437875a0237478d5bdd55458c44b4ef49c3e24808adaf8a9) |
| 10 | Arbitrum One (42161) | 2391.4547 | [0x8d06ebb6…55c0f9cf](https://arbiscan.io/tx/0x8d06ebb67fb3d00a8e9c9886941ec1adc96a0813bdbf70b8c32d25f055c0f9cf) |
| 11 | Arbitrum One (42161) | 470.8512 | [0x8d06ebb6…55c0f9cf](https://arbiscan.io/tx/0x8d06ebb67fb3d00a8e9c9886941ec1adc96a0813bdbf70b8c32d25f055c0f9cf) |
