/* eslint-disable no-console */
// Validates leaves.json self-consistently:
//   1. Rebuild the merkle tree from the 12 leaves.
//   2. Confirm tree.getHexRoot() matches leaves.json's `relayerRefundRoot`.
//   3. Confirm every leaf's stored proof matches tree.getHexProof(leaf).
//   4. Confirm UMIP canonical ordering (chainId asc, l2Token asc lowercase).
//   5. Confirm leafId == position.
//
// Run from the repo root:
//   yarn ts-node scripts/recoveries/2026-06-accounting/verify.ts
import { BigNumber, ethers } from "ethers";
import fs from "fs";
import path from "path";
import { MerkleTree } from "@across-protocol/contracts";

const LEAVES_PATH = path.resolve(__dirname, "leaves.json");

type LeafEntry = {
  amountToReturn: string;
  chainId: number;
  refundAmounts: string[];
  leafId: number;
  l2TokenAddress: string;
  refundAddresses: string[];
  proof: string[];
};

type RefundLeaf = {
  amountToReturn: BigNumber;
  chainId: BigNumber;
  refundAmounts: BigNumber[];
  leafId: number;
  l2TokenAddress: string;
  refundAddresses: string[];
};

function hashRefundLeaf(leaf: RefundLeaf): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(uint256 amountToReturn,uint256 chainId,uint256[] refundAmounts,uint32 leafId,address l2TokenAddress,address[] refundAddresses)",
      ],
      [leaf]
    )
  );
}

function fail(allOk: { v: boolean }, msg: string) {
  console.log(`✗ ${msg}`);
  allOk.v = false;
}

function main() {
  const leavesJson = JSON.parse(fs.readFileSync(LEAVES_PATH, "utf-8")) as {
    relayerRefundRoot: string;
    leaves: LeafEntry[];
  };
  const allOk = { v: true };

  console.log(`Loaded ${leavesJson.leaves.length} leaves from ${LEAVES_PATH}`);
  console.log(`Claimed relayerRefundRoot: ${leavesJson.relayerRefundRoot}`);
  console.log();

  // Rebuild the tree.
  const rebuiltLeaves: RefundLeaf[] = leavesJson.leaves.map((p) => ({
    amountToReturn: BigNumber.from(p.amountToReturn),
    chainId: BigNumber.from(p.chainId),
    refundAmounts: p.refundAmounts.map((a) => BigNumber.from(a)),
    leafId: p.leafId,
    l2TokenAddress: p.l2TokenAddress,
    refundAddresses: p.refundAddresses,
  }));
  const tree = new MerkleTree(rebuiltLeaves, hashRefundLeaf);
  const rebuiltRoot = tree.getHexRoot();

  if (rebuiltRoot.toLowerCase() !== leavesJson.relayerRefundRoot.toLowerCase()) {
    fail(allOk, `rebuilt root ${rebuiltRoot} != claimed root ${leavesJson.relayerRefundRoot}`);
  }

  // Per-leaf checks: stored proof matches recomputed proof, leafId is sequential, UMIP ordering.
  const leafIds = new Set<number>();
  let prevChainId = -1;
  let prevL2 = "";
  for (let i = 0; i < leavesJson.leaves.length; i++) {
    const p = leavesJson.leaves[i];
    const leaf = rebuiltLeaves[i];

    const computedProof = tree.getHexProof(leaf);
    if (JSON.stringify(computedProof) !== JSON.stringify(p.proof)) {
      fail(allOk, `[leaf ${i}] artifact proof differs from rebuilt proof`);
    }

    if (leaf.leafId !== i) {
      fail(allOk, `[leaf ${i}] leafId ${leaf.leafId} != position ${i}`);
    }
    if (leafIds.has(leaf.leafId)) {
      fail(allOk, `[leaf ${i}] duplicate leafId ${leaf.leafId}`);
    }
    leafIds.add(leaf.leafId);

    const cid = Number(leaf.chainId);
    const l2 = leaf.l2TokenAddress.toLowerCase();
    if (cid < prevChainId || (cid === prevChainId && l2 <= prevL2)) {
      fail(allOk, `[leaf ${i}] UMIP ordering violation: (${cid}, ${l2}) <= (${prevChainId}, ${prevL2})`);
    }
    prevChainId = cid;
    prevL2 = l2;
  }

  console.log("idx  chainId   leafId  amount (raw)             l2Token");
  console.log("─".repeat(110));
  for (let i = 0; i < leavesJson.leaves.length; i++) {
    const p = leavesJson.leaves[i];
    console.log(
      `${String(i).padStart(2)}   ${String(p.chainId).padEnd(8)} ${String(p.leafId).padEnd(7)} ${p.amountToReturn.padEnd(24)} ${p.l2TokenAddress}`
    );
  }
  console.log();
  console.log(`Rebuilt tree root: ${rebuiltRoot}`);
  console.log();

  if (allOk.v) {
    console.log(
      `✓ Verified: leaves.json produces relayerRefundRoot ${rebuiltRoot}; all proofs valid; UMIP ordering correct.`
    );
  } else {
    console.log("✗ Verification FAILED.");
    process.exitCode = 1;
  }
}

main();
