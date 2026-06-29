/* eslint-disable no-console */
import { BigNumber, ethers } from "ethers";
import fs from "fs";
import path from "path";
import { MerkleTree } from "@across-protocol/contracts";

const ZERO32 = "0x" + "00".repeat(32);
const MULTICALL_PATH = path.resolve(__dirname, "multicall.json");
const LEAVES_PATH = path.resolve(__dirname, "leaves.json");

const hubIface = new ethers.utils.Interface([
  "function relaySpokePoolAdminFunction(uint256 chainId, bytes functionData)",
  "function multicall(bytes[] data) returns (bytes[])",
]);
const spokeIface = new ethers.utils.Interface([
  "function relayRootBundle(bytes32 relayerRefundRoot, bytes32 slowRelayRoot)",
]);

const SELECTORS = {
  multicall: "0xac9650d8",
  relaySpokePoolAdminFunction: "0xdd70e5e8",
  relayRootBundle: "0x493a4f84",
};

// Mirrors SpokePoolInterface.sol's RelayerRefundLeaf struct + the merkle proof needed
// for executeRelayerRefundLeaf.
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
  const multicallJson = JSON.parse(fs.readFileSync(MULTICALL_PATH, "utf-8"));
  const leavesJson = JSON.parse(fs.readFileSync(LEAVES_PATH, "utf-8")) as {
    relayerRefundRoot: string;
    leaves: LeafEntry[];
  };
  const tx = multicallJson.transactions[0];
  const allOk = { v: true };

  console.log("Multicall decode + verify");
  console.log("=========================");
  console.log(`Target:    ${tx.to}`);
  console.log(`Value:     ${tx.value}`);
  console.log(`Selector:  ${tx.data.slice(0, 10)}  (expect ${SELECTORS.multicall} = multicall(bytes[]))`);
  if (tx.data.slice(0, 10) !== SELECTORS.multicall) {
    fail(allOk, "outer selector mismatch — abort");
    process.exitCode = 1;
    return;
  }

  const innerCalls: string[] = hubIface.decodeFunctionData("multicall", tx.data).data;
  console.log(`Inner calls (one relayRootBundle per spoke): ${innerCalls.length}`);
  console.log(`Leaves in artifact: ${leavesJson.leaves.length}`);
  console.log();

  // Decode each inner call; collect (chainId, refundRoot) tuples.
  const relayed: Array<{ chainId: number; refundRoot: string }> = [];
  let prevChainId = -1;
  for (let i = 0; i < innerCalls.length; i++) {
    const inner = innerCalls[i];
    if (inner.slice(0, 10) !== SELECTORS.relaySpokePoolAdminFunction) {
      fail(allOk, `[${i}] wrong inner selector ${inner.slice(0, 10)}`);
      continue;
    }
    const { chainId, functionData } = hubIface.decodeFunctionData("relaySpokePoolAdminFunction", inner);
    const cid = Number(chainId);
    if (functionData.slice(0, 10) !== SELECTORS.relayRootBundle) {
      fail(allOk, `[${i}] wrong admin selector ${functionData.slice(0, 10)}`);
      continue;
    }
    const { relayerRefundRoot, slowRelayRoot } = spokeIface.decodeFunctionData("relayRootBundle", functionData);
    if (slowRelayRoot.toLowerCase() !== ZERO32) fail(allOk, `[${i}] slowRelayRoot non-zero: ${slowRelayRoot}`);
    if (cid <= prevChainId) fail(allOk, `[${i}] chainId ${cid} <= previous ${prevChainId} (UMIP ordering)`);
    prevChainId = cid;
    relayed.push({ chainId: cid, refundRoot: relayerRefundRoot });
  }

  // All relayed refundRoots must be identical (single global root).
  const uniqueRoots = new Set(relayed.map((r) => r.refundRoot.toLowerCase()));
  if (uniqueRoots.size !== 1) {
    fail(
      allOk,
      `expected a single relayerRefundRoot across all inner calls; got ${uniqueRoots.size} distinct: ${[...uniqueRoots].join(", ")}`
    );
  }
  const relayedRoot = relayed[0]?.refundRoot ?? "0x";

  // Relayed root must match the artifact's claimed root.
  if (relayedRoot.toLowerCase() !== leavesJson.relayerRefundRoot.toLowerCase()) {
    fail(allOk, `relayed root ${relayedRoot} != artifact root ${leavesJson.relayerRefundRoot}`);
  }

  // Inner-call chainIds must match the unique set of chainIds appearing in the leaves, in order.
  const relayedChainIds = relayed.map((r) => r.chainId);
  const expectedChainIds = [...new Set(leavesJson.leaves.map((l) => l.chainId))].sort((a, b) => a - b);
  if (JSON.stringify(relayedChainIds) !== JSON.stringify(expectedChainIds)) {
    fail(allOk, `relayed chainIds ${relayedChainIds.join(",")} != unique leaf chainIds ${expectedChainIds.join(",")}`);
  }

  // Rebuild the merkle tree from the artifact's leaves and confirm the root.
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
  if (rebuiltRoot.toLowerCase() !== relayedRoot.toLowerCase()) {
    fail(allOk, `rebuilt tree root ${rebuiltRoot} != relayed root ${relayedRoot}`);
  }

  // Per-leaf proof verification + leafId uniqueness + UMIP ordering inside the artifact.
  const leafIds = new Set<number>();
  let prevLeafChain = -1;
  let prevLeafL2 = "";
  for (let i = 0; i < leavesJson.leaves.length; i++) {
    const p = leavesJson.leaves[i];
    const leaf = rebuiltLeaves[i];
    const computedProof = tree.getHexProof(leaf);
    if (JSON.stringify(computedProof) !== JSON.stringify(p.proof)) {
      fail(allOk, `[leaf ${i}] artifact proof differs from rebuilt proof`);
    }
    if (leaf.leafId !== i) fail(allOk, `[leaf ${i}] leafId ${leaf.leafId} != position ${i}`);
    if (leafIds.has(leaf.leafId)) fail(allOk, `[leaf ${i}] duplicate leafId ${leaf.leafId}`);
    leafIds.add(leaf.leafId);

    // UMIP ordering within the artifact.
    const cid = Number(leaf.chainId);
    const l2 = leaf.l2TokenAddress.toLowerCase();
    if (cid < prevLeafChain || (cid === prevLeafChain && l2 <= prevLeafL2)) {
      fail(allOk, `[leaf ${i}] UMIP ordering violation: (${cid}, ${l2}) <= (${prevLeafChain}, ${prevLeafL2})`);
    }
    prevLeafChain = cid;
    prevLeafL2 = l2;
  }

  console.log(`Single relayed root: ${relayedRoot}`);
  console.log(
    `Rebuilt tree root:   ${rebuiltRoot}  (matches: ${relayedRoot.toLowerCase() === rebuiltRoot.toLowerCase()})`
  );
  console.log(`Spoke chainIds:      ${relayedChainIds.join(", ")}`);
  console.log();
  console.log("Leaves:");
  console.log("idx  chainId   leafId  amount (raw)             l2Token");
  console.log("─".repeat(110));
  for (let i = 0; i < leavesJson.leaves.length; i++) {
    const p = leavesJson.leaves[i];
    console.log(
      `${String(i).padStart(2)}   ${String(p.chainId).padEnd(8)} ${String(p.leafId).padEnd(7)} ${p.amountToReturn.padEnd(24)} ${p.l2TokenAddress}`
    );
  }
  console.log();

  if (allOk.v) {
    console.log(
      `✓ Verified: single root ${relayedRoot} relayed to ${innerCalls.length} spokes; all ${leavesJson.leaves.length} leaf proofs valid against this root; UMIP ordering correct.`
    );
  } else {
    console.log("✗ Verification FAILED — do not sign.");
    process.exitCode = 1;
  }
}

main();
