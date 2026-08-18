/**
 * L1-side "has this been claimed?" oracles, one per chain family.
 *
 * RULE, enforced by assertDiscriminates(): never trust an oracle that has not been shown to
 * return BOTH true and false. A portal address that is subtly wrong — or a hash computed with
 * the wrong offset — returns `false` for every query, which is indistinguishable from
 * "everything is stuck". That failure mode produced a 19-item false positive during the
 * manual investigation, and nearly produced a false all-clear in the opposite direction.
 */
import { ethers } from "ethers";
import { ethCall, isTrue, getLogsChunked, Log } from "./rpc";
import { SELECTORS, EVENTS } from "./registry";

const WITHDRAWAL_FINALIZED_TOPIC = ethers.utils.id("WithdrawalFinalized(bytes32,bool)");
const pad32 = (h: string) => ethers.utils.hexZeroPad(h, 32).slice(2);

export interface Control {
  ok: boolean;
  positive: "pass" | "fail" | "unavailable";
  negative: "pass" | "fail";
  detail: string;
}

/** Bogus hash — must read as not-finalized on any healthy oracle. */
const BOGUS = "0x" + "ab".repeat(32);

// ---------------------------------------------------------------------------
// OP-Stack (Bedrock)
// ---------------------------------------------------------------------------
export async function opFinalized(
  l1: ethers.providers.JsonRpcProvider,
  portal: string,
  withdrawalHash: string
): Promise<boolean> {
  return isTrue(await ethCall(l1, portal, SELECTORS.finalizedWithdrawals + pad32(withdrawalHash)));
}

export async function opProvenAt(
  l1: ethers.providers.JsonRpcProvider,
  portal: string,
  withdrawalHash: string,
  proofSubmitter: string
): Promise<{ disputeGame: string; timestamp: number } | undefined> {
  const ret = await ethCall(
    l1,
    portal,
    SELECTORS.provenWithdrawals + pad32(withdrawalHash) + pad32(proofSubmitter)
  );
  if (!ret || ret.length < 130) return undefined;
  return {
    disputeGame: ethers.utils.getAddress("0x" + ret.slice(26, 66)),
    timestamp: Number(BigInt("0x" + ret.slice(66, 130))),
  };
}

export async function opProofSubmitter(
  l1: ethers.providers.JsonRpcProvider,
  portal: string,
  withdrawalHash: string,
  index = 0
): Promise<string | undefined> {
  const ret = await ethCall(
    l1,
    portal,
    SELECTORS.proofSubmitters + pad32(withdrawalHash) + pad32(ethers.utils.hexlify(index))
  );
  if (!ret || ret.length < 66) return undefined;
  const a = ethers.utils.getAddress("0x" + ret.slice(-40));
  return a === ethers.constants.AddressZero ? undefined : a;
}

/**
 * Prove the portal oracle discriminates.
 * Positive control: a hash the portal itself emitted via WithdrawalFinalized must read true.
 * Fallback (Blast, whose portal uses non-standard topics): sample old L2 withdrawals until one
 * reads true.
 */
export async function assertDiscriminates(
  l1: ethers.providers.JsonRpcProvider,
  portal: string,
  fallbackHashes: string[] = []
): Promise<Control> {
  const negative = (await opFinalized(l1, portal, BOGUS)) ? "fail" : "pass";
  const head = await l1.getBlockNumber();
  let positive: Control["positive"] = "unavailable";
  let detail = "";

  const { logs } = await getLogsChunked(
    l1,
    { address: portal, topics: [WITHDRAWAL_FINALIZED_TOPIC] },
    Math.max(1, head - 60_000),
    head,
    { chunk: 10_000 }
  );
  if (logs.length > 0) {
    const h = logs[logs.length - 1].topics[1];
    positive = (await opFinalized(l1, portal, h)) ? "pass" : "fail";
    detail = `positive control from self-emitted WithdrawalFinalized ${h.slice(0, 12)}…`;
  } else {
    for (const h of fallbackHashes) {
      if (await opFinalized(l1, portal, h)) {
        positive = "pass";
        detail = `positive control from sampled historical withdrawal ${h.slice(0, 12)}…`;
        break;
      }
    }
    if (positive === "unavailable")
      detail = "no WithdrawalFinalized events and no sampled hash read true — results are UNPROVEN";
  }
  return { ok: negative === "pass" && positive === "pass", positive, negative, detail };
}

// ---------------------------------------------------------------------------
// OP-Stack (pre-Bedrock legacy)
// ---------------------------------------------------------------------------
/**
 * Legacy messages are keyed on the "xDomainCalldata" hash, not a Bedrock withdrawal hash:
 *   keccak256(abi.encodeWithSignature("relayMessage(address,address,bytes,uint256)",
 *                                     target, sender, message, messageNonce))
 * This is the same preimage the legacy L1CrossDomainMessenger records in successfulMessages.
 */
export function legacyXDomainCalldataHash(
  target: string,
  sender: string,
  message: string,
  messageNonce: ethers.BigNumberish
): string {
  const iface = new ethers.utils.Interface([
    "function relayMessage(address target, address sender, bytes message, uint256 messageNonce)",
  ]);
  return ethers.utils.keccak256(
    iface.encodeFunctionData("relayMessage", [target, sender, message, messageNonce])
  );
}

/**
 * The V1 "versioned" hash.
 *
 * THIS IS THE ONE THAT ACTUALLY GETS RECORDED, and getting it wrong is a mass false positive.
 * OP's CrossDomainMessenger.relayMessage() *reads* successfulMessages[v0Hash] as replay protection
 * for messages the pre-Bedrock messenger already relayed, but it *writes*
 * successfulMessages[v1Hash]. So a legacy withdrawal relayed after the migration leaves the v0 key
 * false forever. Checking only v0 reports every legacy message as stuck — verified against the five
 * SNX withdrawals: v0 => false, v1 => true, after they were demonstrably claimed.
 *
 * For migrated legacy messages the inner relayMessage carries value = 0 and minGasLimit = 0.
 * That is empirical (n=2, both SNX proofs) rather than read from the migration spec, so if a
 * legacy control ever fails, suspect these two zeros first.
 */
export function legacyVersionedHash(
  messageNonce: ethers.BigNumberish,
  sender: string,
  target: string,
  message: string,
  value: ethers.BigNumberish = 0,
  minGasLimit: ethers.BigNumberish = 0
): string {
  const iface = new ethers.utils.Interface([
    "function relayMessage(uint256 nonce, address sender, address target, uint256 value, uint256 minGasLimit, bytes message)",
  ]);
  return ethers.utils.keccak256(
    iface.encodeFunctionData("relayMessage", [messageNonce, sender, target, value, minGasLimit, message])
  );
}

/**
 * Relayed status for a legacy message. Checks BOTH keys:
 *   v0 - set by the pre-Bedrock messenger for messages relayed before the migration
 *   v1 - set by the post-Bedrock messenger for legacy messages relayed after it
 * Either being true means the funds have moved.
 */
export async function legacyRelayed(
  l1: ethers.providers.JsonRpcProvider,
  l1XDM: string,
  hashes: { v0?: string; v1?: string }
): Promise<{ successful: boolean; failed: boolean; via?: "v0" | "v1" }> {
  const keys = [
    ["v0", hashes.v0],
    ["v1", hashes.v1],
  ] as const;
  let failed = false;
  for (const [which, h] of keys) {
    if (!h) continue;
    if (isTrue(await ethCall(l1, l1XDM, SELECTORS.successfulMessages + pad32(h))))
      return { successful: true, failed: false, via: which };
    if (isTrue(await ethCall(l1, l1XDM, SELECTORS.failedMessages + pad32(h)))) failed = true;
  }
  return { successful: false, failed };
}

/** Control for the legacy oracle: needs at least one known-relayed message to read true. */
export async function assertLegacyDiscriminates(
  l1: ethers.providers.JsonRpcProvider,
  l1XDM: string,
  knownRelayedHashes: string[]
): Promise<Control> {
  const neg = (await legacyRelayed(l1, l1XDM, { v0: BOGUS, v1: BOGUS })).successful ? "fail" : "pass";
  let positive: Control["positive"] = "unavailable";
  for (const h of knownRelayedHashes) {
    if ((await legacyRelayed(l1, l1XDM, { v0: h, v1: h })).successful) {
      positive = "pass";
      break;
    }
  }
  return {
    ok: neg === "pass" && positive === "pass",
    positive,
    negative: neg,
    detail:
      positive === "pass"
        ? "successfulMessages returned true for a known-relayed legacy message"
        : "could not confirm successfulMessages ever returns true — legacy results UNPROVEN",
  };
}

// ---------------------------------------------------------------------------
// Orbit
// ---------------------------------------------------------------------------
/** Checks every known Outbox (Nitro + classic); spent in any one means claimed. */
export async function orbitSpent(
  l1: ethers.providers.JsonRpcProvider,
  outboxes: string[],
  position: ethers.BigNumberish
): Promise<{ spent: boolean; via?: string }> {
  const key = pad32(ethers.utils.hexlify(ethers.BigNumber.from(position)));
  for (const o of outboxes) {
    if (isTrue(await ethCall(l1, o, SELECTORS.isSpent + key))) return { spent: true, via: o };
  }
  return { spent: false };
}

export async function assertOrbitDiscriminates(
  l1: ethers.providers.JsonRpcProvider,
  outboxes: string[],
  knownSpentPosition: number
): Promise<Control> {
  const neg = (await orbitSpent(l1, outboxes, 999_999_999)).spent ? "fail" : "pass";
  const pos = (await orbitSpent(l1, outboxes, knownSpentPosition)).spent ? "pass" : "fail";
  return {
    ok: neg === "pass" && pos === "pass",
    positive: pos,
    negative: neg,
    detail: `isSpent(${knownSpentPosition}) vs isSpent(999999999)`,
  };
}

// ---------------------------------------------------------------------------
// Polygon PoS
// ---------------------------------------------------------------------------
/**
 * Honest limitation. A PoS exit is keyed on a Merkle proof of the burn receipt against a
 * checkpointed block root; the key for RootChainManager.processedExits() cannot be derived
 * from the burn log alone without building that proof. So this returns `unknown` and the
 * scanner falls back to reconciliation: match burn amounts on L2 against
 * predicate-exit transfers on L1. Treat Polygon output as "candidates needing review",
 * not as a definitive stuck list.
 */
export async function polygonExitStatus(): Promise<"unknown"> {
  return "unknown";
}

export async function polygonExitedAmounts(
  l1: ethers.providers.JsonRpcProvider,
  l1Token: string,
  recipient: string,
  fromBlock: number,
  toBlock: number
): Promise<Map<string, number>> {
  // Exits surface as an ERC20 Transfer from the predicate to the recipient on L1.
  const { logs } = await getLogsChunked(
    l1,
    {
      address: l1Token,
      topics: [EVENTS.erc20Transfer.topic0, null, ethers.utils.hexZeroPad(recipient, 32)],
    },
    fromBlock,
    toBlock,
    { chunk: 10_000 }
  );
  const counts = new Map<string, number>();
  for (const l of logs) {
    const amt = BigInt(l.data).toString();
    counts.set(amt, (counts.get(amt) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// zk-stack / Scroll / Linea
// ---------------------------------------------------------------------------
export async function zkWithdrawalFinalized(
  l1: ethers.providers.JsonRpcProvider,
  l1Nullifier: string,
  chainId: number,
  l2BatchNumber: ethers.BigNumberish,
  l2MessageIndex: ethers.BigNumberish
): Promise<boolean> {
  const sel = ethers.utils.id("isWithdrawalFinalized(uint256,uint256,uint256)").slice(0, 10);
  const args = [chainId, l2BatchNumber, l2MessageIndex]
    .map((v) => pad32(ethers.utils.hexlify(ethers.BigNumber.from(v))))
    .join("");
  return isTrue(await ethCall(l1, l1Nullifier, sel + args));
}

export async function scrollExecuted(
  l1: ethers.providers.JsonRpcProvider,
  l1Messenger: string,
  messageHash: string
): Promise<boolean> {
  const sel = ethers.utils.id("isL2MessageExecuted(bytes32)").slice(0, 10);
  return isTrue(await ethCall(l1, l1Messenger, sel + pad32(messageHash)));
}

export async function lineaClaimed(
  l1: ethers.providers.JsonRpcProvider,
  l1Messenger: string,
  messageHash: string
): Promise<number | undefined> {
  const sel = ethers.utils.id("inboxL2L1MessageStatus(bytes32)").slice(0, 10);
  const ret = await ethCall(l1, l1Messenger, sel + pad32(messageHash));
  return ret === undefined ? undefined : Number(BigInt(ret));
}

export const extractWithdrawalHash = (log: Log): string => {
  const [a, b] = EVENTS.messagePassed.withdrawalHashSlice;
  return "0x" + log.data.slice(2).slice(a, b);
};
