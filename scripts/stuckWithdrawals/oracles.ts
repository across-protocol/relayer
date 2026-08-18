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
const OUTBOX_TX_EXECUTED_TOPIC = ethers.utils.id("OutBoxTransactionExecuted(address,address,uint256,uint256)");
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
  const ret = await ethCall(l1, portal, SELECTORS.provenWithdrawals + pad32(withdrawalHash) + pad32(proofSubmitter));
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

export async function opNumProofSubmitters(
  l1: ethers.providers.JsonRpcProvider,
  portal: string,
  withdrawalHash: string
): Promise<number | undefined> {
  const ret = await ethCall(l1, portal, SELECTORS.numProofSubmitters + pad32(withdrawalHash));
  return ret === undefined || ret.length < 3 ? undefined : Number(BigInt(ret));
}

/**
 * Every proof submitter for a withdrawal, newest LAST.
 *
 * DO NOT just read index 0. When a withdrawal is reproven — which is exactly what happens after a
 * dispute game is invalidated — index 0 still points at the OLD proof, backed by a game that can
 * never resolve favourably. Reporting that submitter tells an operator to submit a finalization
 * that reverts. The production finalizer reads `numProofSubmitters - 1` for this reason
 * (src/finalizer/utils/opStack.ts); we enumerate so we can prefer the newest proof that actually
 * has a resolved game.
 */
export async function opProofSubmitters(
  l1: ethers.providers.JsonRpcProvider,
  portal: string,
  withdrawalHash: string
): Promise<string[]> {
  const n = await opNumProofSubmitters(l1, portal, withdrawalHash);
  if (n === undefined) {
    // Pre-Portal-2 portals have no numProofSubmitters; index 0 is the only proof that can exist.
    const only = await opProofSubmitter(l1, portal, withdrawalHash, 0);
    return only ? [only] : [];
  }
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = await opProofSubmitter(l1, portal, withdrawalHash, i);
    if (s) out.push(s);
  }
  return out;
}

const uint = async (
  l1: ethers.providers.JsonRpcProvider,
  to: string,
  selector: string
): Promise<number | undefined> => {
  const ret = await ethCall(l1, to, selector);
  return ret === undefined || ret.length < 3 ? undefined : Number(BigInt(ret));
};

export const opProofMaturityDelay = (l1: ethers.providers.JsonRpcProvider, portal: string) =>
  uint(l1, portal, SELECTORS.proofMaturityDelaySeconds);

export const opDisputeGameFinalityDelay = (l1: ethers.providers.JsonRpcProvider, portal: string) =>
  uint(l1, portal, SELECTORS.disputeGameFinalityDelaySeconds);

/** DisputeGame.resolvedAt(); 0 (returned as undefined here) means the game has not resolved. */
export async function disputeGameResolvedAt(
  l1: ethers.providers.JsonRpcProvider,
  game: string
): Promise<number | undefined> {
  const v = await uint(l1, game, SELECTORS.resolvedAt);
  return v ? v : undefined;
}

export interface Claimability {
  /** Unix seconds at which finalization first becomes possible, if that is knowable now. */
  claimableAt?: number;
  /** Set when the answer is "not yet knowable" rather than a timestamp. */
  blockedOn?: string;
  proofSubmitter?: string;
  disputeGame?: string;
  provenAt?: number;
}

/**
 * When can this proven withdrawal actually be finalized?
 *
 * NOT `provenAt + 7 days`. On a Portal-2 (fault-proof) chain there are TWO independent clocks and
 * the gate is the later of them:
 *   1. proof maturity:      provenAt        + proofMaturityDelaySeconds
 *   2. dispute-game airgap: game.resolvedAt + disputeGameFinalityDelaySeconds
 * and clock 2 has not even STARTED while the game is unresolved (resolvedAt == 0). Mainnet OP
 * reads proofMaturityDelaySeconds = 604800 and disputeGameFinalityDelaySeconds = 302400, so the
 * hardcoded seven days silently matched clock 1 alone and ignored clock 2 entirely — advertising a
 * claimableAt that can be days early and sending operators into reverting finalizations. This
 * mirrors getDisputeGameFinalizableAt() in src/finalizer/utils/opStack.ts.
 */
export async function opClaimability(
  l1: ethers.providers.JsonRpcProvider,
  portal: string,
  withdrawalHash: string,
  submitters: string[]
): Promise<Claimability> {
  // Newest proof first: a reproof supersedes whatever index 0 holds.
  for (const submitter of [...submitters].reverse()) {
    const pv = await opProvenAt(l1, portal, withdrawalHash, submitter);
    if (!pv?.timestamp) continue;
    const base: Claimability = {
      proofSubmitter: submitter,
      disputeGame: pv.disputeGame,
      provenAt: pv.timestamp,
    };
    const maturity = await opProofMaturityDelay(l1, portal);
    // Legacy (pre-fault-proof) portal: no dispute games, single 7-day clock.
    if (maturity === undefined) return { ...base, claimableAt: pv.timestamp + 7 * 86400 };

    const matureAt = pv.timestamp + maturity;
    const airgap = await opDisputeGameFinalityDelay(l1, portal);
    if (airgap === undefined) return { ...base, claimableAt: matureAt };

    const resolvedAt =
      pv.disputeGame === ethers.constants.AddressZero ? undefined : await disputeGameResolvedAt(l1, pv.disputeGame);
    if (resolvedAt === undefined)
      return {
        ...base,
        blockedOn: `dispute game ${pv.disputeGame} unresolved — airgap clock has not started; earliest possible is proof maturity at ${new Date(matureAt * 1000).toISOString()}`,
      };
    return { ...base, claimableAt: Math.max(matureAt, resolvedAt + airgap) };
  }
  return { blockedOn: "no proof found for any known submitter" };
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
  return ethers.utils.keccak256(iface.encodeFunctionData("relayMessage", [target, sender, message, messageNonce]));
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
/**
 * Nitro-era claim check. MUST be era-routed — do NOT fan out across classic outboxes.
 *
 * The classic and Nitro index spaces overlap numerically, so querying the wrong outbox returns
 * plausible garbage rather than an error. Measured on a real classic withdrawal
 * (uniqueId 81359, batchNumber 15531): NitroOutbox.isSpent(81359) = false (false negative),
 * isSpent(15531) = true and isSpent(81360) = true (false positives). Route strictly on
 * Arbitrum block 22207817.
 */
export async function orbitNitroSpent(
  l1: ethers.providers.JsonRpcProvider,
  nitroOutbox: string,
  position: ethers.BigNumberish
): Promise<{ spent: boolean; via?: string }> {
  const key = pad32(ethers.utils.hexlify(ethers.BigNumber.from(position)));
  if (isTrue(await ethCall(l1, nitroOutbox, SELECTORS.isSpent + key))) return { spent: true, via: nitroOutbox };
  return { spent: false };
}

/**
 * Classic (pre-Nitro) claim check. `isSpent` DOES NOT EXIST on the classic outboxes — it reverts,
 * which ethCall swallows into `undefined`, i.e. a silent "not claimed" for every query. Use
 * outboxEntryExists(batchNumber) plus L1 OutBoxTransactionExecuted logs instead.
 *
 * Classic claims are still arriving: 481 OutBoxTransactionExecuted on Outbox2 in the last 500k L1
 * blocks, for batch numbers as low as 881. An L2ToL1Tx-only scan sees none of it.
 */
export async function orbitClassicEntryExists(
  l1: ethers.providers.JsonRpcProvider,
  classicOutbox: string,
  batchNumber: ethers.BigNumberish
): Promise<boolean> {
  const sel = ethers.utils.id("outboxEntryExists(uint256)").slice(0, 10);
  return isTrue(
    await ethCall(l1, classicOutbox, sel + pad32(ethers.utils.hexlify(ethers.BigNumber.from(batchNumber))))
  );
}

/**
 * Definitive classic claim check: the L1 OutBoxTransactionExecuted log.
 *
 * Classic identifies a message by the PAIR (batchNumber, indexInBatch) — not by a single global
 * position — and the event carries batchNumber in indexed topic3 with indexInBatch in `data`.
 * outboxEntryExists() alone is not enough: it says the batch was confirmed, not that this
 * particular message inside it was executed.
 *
 * Returns `undefined` (not `false`) when the log scan hit a gap, so an unreadable range can never
 * be mistaken for "not claimed".
 */
export async function orbitClassicExecutedIndices(
  l1: ethers.providers.JsonRpcProvider,
  classicOutboxes: string[],
  batchNumber: ethers.BigNumberish,
  fromBlock: number,
  toBlock: number,
  chunk = 500_000
): Promise<{ indices: Set<string>; complete: boolean }> {
  const indices = new Set<string>();
  let complete = true;
  for (const outbox of classicOutboxes) {
    const { logs, stats } = await getLogsChunked(
      l1,
      {
        address: outbox,
        topics: [
          OUTBOX_TX_EXECUTED_TOPIC,
          null,
          null,
          ethers.utils.hexZeroPad(ethers.BigNumber.from(batchNumber).toHexString(), 32),
        ],
      },
      fromBlock,
      toBlock,
      { chunk }
    );
    if (stats.gaps.length) complete = false;
    for (const l of logs) if (l.data) indices.add(ethers.BigNumber.from(l.data).toString());
  }
  return { indices, complete };
}

export async function orbitClassicExecuted(
  l1: ethers.providers.JsonRpcProvider,
  classicOutboxes: string[],
  batchNumber: ethers.BigNumberish,
  indexInBatch: ethers.BigNumberish,
  fromBlock: number,
  toBlock: number
): Promise<boolean | undefined> {
  const { indices, complete } = await orbitClassicExecutedIndices(l1, classicOutboxes, batchNumber, fromBlock, toBlock);
  const hit = indices.has(ethers.BigNumber.from(indexInBatch).toString());
  // An incomplete scan may only ever produce `true` (a hit is proof) or `undefined`.
  return hit ? true : complete ? false : undefined;
}

/**
 * Control for the classic outbox oracle.
 *
 * Uses a batch known to be PARTIALLY executed, so one L1 log query yields both halves: the known
 * executed index must read true and an index that batch never contained must read false. Without
 * this the oracle is a log scan whose empty result is indistinguishable from a wrong topic0, a
 * wrong outbox address, or a range the endpoint quietly refused — i.e. a silent all-stuck oracle,
 * which is the exact failure this file exists to prevent.
 */
export async function assertOrbitClassicDiscriminates(
  l1: ethers.providers.JsonRpcProvider,
  classicOutboxes: string[],
  known: { batchNumber: number; indexInBatch: number },
  fromBlock: number,
  toBlock: number
): Promise<Control> {
  const { indices, complete } = await orbitClassicExecutedIndices(
    l1,
    classicOutboxes,
    known.batchNumber,
    fromBlock,
    toBlock
  );
  const pos = indices.has(String(known.indexInBatch)) ? "pass" : "fail";
  const neg = indices.has("999999999") ? "fail" : "pass";
  return {
    ok: pos === "pass" && neg === "pass" && complete,
    positive: pos,
    negative: neg,
    detail:
      `batch ${known.batchNumber}: executed indices [${[...indices].sort((a, b) => Number(a) - Number(b)).join(",")}]` +
      `, expected ${known.indexInBatch} present${complete ? "" : " (L1 LOG SCAN INCOMPLETE)"}`,
  };
}

/** Back-compat shim for the fixture harness; Nitro only. */
export async function orbitSpent(
  l1: ethers.providers.JsonRpcProvider,
  outboxes: string[],
  position: ethers.BigNumberish
): Promise<{ spent: boolean; via?: string }> {
  return outboxes.length ? orbitNitroSpent(l1, outboxes[0], position) : { spent: false };
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
 * Polygon PoS exit key — computable entirely offline from the burn receipt.
 *
 * exitHash = keccak256(abi.encodePacked(uint256 l2BlockNumber,
 *                                      bytes nibbles(rlp(txIndex)),
 *                                      uint256 receiptLocalLogIndex))
 *
 * `branchMask` in the exit payload is just the HP-encoded receipts-trie key, which is
 * rlp(txIndex) — so no Merkle proof and no proof-generator API is needed to DETECT an
 * unclaimed exit (you still need the proof to SUBMIT one).
 *
 * Verified: (92225980, txIdx 0, logIdx 0) -> 0xdd87f9ea… -> processedExits = true, with a
 * zero-key negative control returning false.
 *
 * CAVEAT: receiptLogIndex is the index within THAT RECEIPT's log array, not the block-global
 * logIndex. Every verified sample had 0, so the nonzero case is structurally certain but not
 * empirically confirmed.
 */
export function polygonNibbles(buf: Uint8Array): string {
  const out: number[] = [];
  for (const b of buf) out.push(b >> 4, b & 0x0f);
  return ethers.utils.hexlify(Uint8Array.from(out));
}

export function polygonExitHash(l2BlockNumber: number, txIndex: number, receiptLogIndex: number): string {
  const key = ethers.utils.arrayify(ethers.utils.RLP.encode(txIndex === 0 ? "0x" : ethers.utils.hexlify(txIndex)));
  return ethers.utils.solidityKeccak256(
    ["uint256", "bytes", "uint256"],
    [l2BlockNumber, polygonNibbles(key), receiptLogIndex]
  );
}

export async function polygonExitProcessed(
  l1: ethers.providers.JsonRpcProvider,
  rootChainManager: string,
  exitHash: string
): Promise<boolean> {
  return isTrue(await ethCall(l1, rootChainManager, SELECTORS.processedExits + pad32(exitHash)));
}

/**
 * Polygon checkpoint gate. A burn cannot be exited until its L2 block is checkpointed, and the
 * lag runs 15-40 minutes. Without this gate every recent burn reads as "stuck".
 */
export async function polygonLastCheckpointedBlock(
  l1: ethers.providers.JsonRpcProvider,
  rootChain: string
): Promise<number | undefined> {
  const ret = await ethCall(l1, rootChain, ethers.utils.id("getLastChildBlock()").slice(0, 10));
  return ret === undefined ? undefined : Number(BigInt(ret));
}

export async function assertPolygonDiscriminates(
  l1: ethers.providers.JsonRpcProvider,
  rootChainManager: string,
  knownProcessed: { block: number; txIndex: number; logIndex: number }
): Promise<Control> {
  const neg = (await polygonExitProcessed(l1, rootChainManager, ethers.constants.HashZero)) ? "fail" : "pass";
  const pos = (await polygonExitProcessed(
    l1,
    rootChainManager,
    polygonExitHash(knownProcessed.block, knownProcessed.txIndex, knownProcessed.logIndex)
  ))
    ? "pass"
    : "fail";
  return { ok: neg === "pass" && pos === "pass", positive: pos, negative: neg, detail: "processedExits round trip" };
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

/** Scroll L2->L1 message key: keccak(relayMessage selector ++ abi.encode(sender,target,value,nonce,message)). */
export function scrollMessageHash(
  sender: string,
  target: string,
  value: ethers.BigNumberish,
  messageNonce: ethers.BigNumberish,
  message: string
): string {
  const iface = new ethers.utils.Interface([
    "function relayMessage(address from, address to, uint256 value, uint256 nonce, bytes message)",
  ]);
  return ethers.utils.keccak256(
    iface.encodeFunctionData("relayMessage", [sender, target, value, messageNonce, message])
  );
}

export async function scrollExecuted(
  l1: ethers.providers.JsonRpcProvider,
  l1Messenger: string,
  messageHash: string
): Promise<boolean> {
  const sel = ethers.utils.id("isL2MessageExecuted(bytes32)").slice(0, 10);
  return isTrue(await ethCall(l1, l1Messenger, sel + pad32(messageHash)));
}

/**
 * Linea claim check.
 *
 * DO NOT USE inboxL2L1MessageStatus(bytes32). It exists and is callable but returns 0 for every
 * real message, including confirmed-claimed ones — it is the dead pre-Merkle-proof path, and its
 * output is indistinguishable from a random hash. That is a silent all-stuck oracle.
 *
 * The live oracle is a nonce-keyed bitmap: isMessageClaimed(uint256 _messageNumber), keyed on the
 * `_nonce` field of the L2 MessageSent event. Verified: 108140 = true, 108139 = true,
 * 108141 = false, 99999999 = false.
 */
export async function lineaMessageClaimed(
  l1: ethers.providers.JsonRpcProvider,
  lineaRollup: string,
  messageNumber: ethers.BigNumberish
): Promise<boolean> {
  const sel = ethers.utils.id("isMessageClaimed(uint256)").slice(0, 10);
  return isTrue(
    await ethCall(l1, lineaRollup, sel + pad32(ethers.utils.hexlify(ethers.BigNumber.from(messageNumber))))
  );
}

/** Linea message hash, verified byte-identical to the on-chain MessageClaimed topic1. */
export function lineaMessageHash(
  from: string,
  to: string,
  fee: ethers.BigNumberish,
  value: ethers.BigNumberish,
  nonce: ethers.BigNumberish,
  calldata: string
): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["address", "address", "uint256", "uint256", "uint256", "bytes"],
      [from, to, fee, value, nonce, calldata]
    )
  );
}

export const extractWithdrawalHash = (log: Log): string => {
  const [a, b] = EVENTS.messagePassed.withdrawalHashSlice;
  return "0x" + log.data.slice(2).slice(a, b);
};
