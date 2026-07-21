# Stuck-token recovery — July 2026 (ACX, UMA, DAI, WBTC)

Second batch of the [June 2026 recovery](../2026-06-accounting/README.md): recovers ~24,690 ACX + ~7,400 UMA + ~70,109 DAI + 0.327 WBTC stranded on the OP, Polygon, zkSync, Base, Arbitrum and Blast SpokePools. All amounts except Base DAI were stranded by the same pre-SDK-4.4.0 running-balance reset bug (fixed in relayer `ba47ba115`); the Base DAI leaf recovers an unaccounted surplus orphaned when the DAI/Base rebalance route was retired. Every leaf amount reconciles wei-exact against on-chain state (last re-verified 2026-07-21 @ mainnet blk 25583166).

## The 9 leaves (UMIP canonical order)

A single 9-leaf merkle tree under `relayerRefundRoot = 0xc2272e649b5d9354b6e56778ace362a0b3fdb4477d60db5360609198788a7205`.

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

Totals: 24,689.770047262232121217 ACX + 7,400.258153629255938318 UMA + 70,109.176101209038944799 DAI + 0.32694665 WBTC. Each leaf matches `SpokePoolInterface.sol`'s `RelayerRefundLeaf` struct 1:1 (empty `refundAmounts`/`refundAddresses`); leaf hash = `keccak256(abi.encode(leaf))`; tree built via `@across-protocol/contracts`' `MerkleTree`.

## Mechanism

1. HubPool admin calls `multicall([relaySpokePoolAdminFunction(chainId, encoded(relayRootBundle(ROOT, 0x0))) × 6])` — same `ROOT` to each of OP (10), Polygon (137), zkSync (324), Base (8453), Arbitrum (42161), Blast (81457).
2. After cross-domain delivery, permissionless `SpokePool.executeRelayerRefundLeaf(rootBundleId, leaf, proof)` triggers `_bridgeTokensToHubPool(l2Token, amountToReturn)` for each leaf destined to that spoke.
3. After per-chain withdrawal challenge expires, standard `src/finalizer/` infrastructure claims to L1. After arrival, `HubPool.sync(l1Token)` (or any LP action) folds the tokens back into `liquidReserves`.

## Verify before signing

### 1. Validate `leaves.json` produces the documented root

```sh
yarn ts-node scripts/recoveries/verify.ts scripts/recoveries/2026-07-accounting/leaves.json
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

If a simulation shows fewer/more than 6 events, a different `message` payload, an emitter other than the HubPool, or any chainId outside the set above, **do not sign**.

### 3. Re-check the spoke balances

Leaf amounts were sized to the exact stranded balances (2026-07-21 @ mainnet blk 25583166). Before signing, confirm each spoke still holds at least the leaf amount of its token — a balance above the leaf amount is fine (excess stays on the spoke); below means something moved and the tree must be rebuilt.
