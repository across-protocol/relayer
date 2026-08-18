/**
 * L2-side discovery, one scanner per era/family.
 *
 * Design rule: discover at the CANONICAL MESSAGE LAYER, never at the token layer.
 * Token-level scans (ERC20 burns, standard-bridge events) are defeated by token-specific
 * bridges — Maker's DAI bridge on Optimism and the bridged-USDC bridge on Lisk each hid real
 * withdrawals from exactly that approach. The message layer is common to every bridge on a
 * given chain, so it cannot be dodged by a bridge we have not heard of.
 *
 * The one thing the message layer does NOT survive is a change of message layer itself, i.e.
 * an era boundary (Bedrock, Nitro). Hence one scanner per era.
 */
import { ethers } from "ethers";
import { ChainConfig, EVENTS, WATCH, TOKENS_BRIDGED_VARIANTS } from "./registry";
import { getLogsChunked, payloadMatches, ChunkStats, Log, hex } from "./rpc";
import { extractWithdrawalHash, legacyXDomainCalldataHash, legacyVersionedHash } from "./oracles";

export interface Candidate {
  chainId: number;
  family: string;
  l2TxHash: string;
  l2Block: number;
  /** Family-specific claim key: withdrawalHash | outbox position | xDomainCalldata hash. */
  key: string;
  matched: string[];
  extra?: Record<string, string>;
}

export interface Coverage {
  scanner: string;
  stats: ChunkStats;
  /** Independent cross-check of the log count, where the chain exposes a monotonic counter. */
  independent?: { name: string; expected: number; observed: number; agrees: boolean };
  exhaustive: boolean;
  note?: string;
}

const watchNeedles = () => Object.keys(WATCH).map((a) => a.slice(2).toLowerCase());

// ---------------------------------------------------------------------------
// OP-Stack, Bedrock era
// ---------------------------------------------------------------------------
export async function scanOpBedrock(
  l2: ethers.providers.JsonRpcProvider,
  cfg: ChainConfig,
  fromBlock: number,
  toBlock: number,
  chunk?: number
): Promise<{ candidates: Candidate[]; coverage: Coverage }> {
  const needles = watchNeedles();
  const candidates: Candidate[] = [];
  const { logs, stats } = await getLogsChunked(
    l2,
    { address: EVENTS.messagePassed.address, topics: [EVENTS.messagePassed.topic0] },
    fromBlock,
    toBlock,
    { chunk: chunk ?? 20_000 }
  );
  for (const l of logs) {
    const matched = payloadMatches(l, needles);
    if (matched.length === 0) continue;
    candidates.push({
      chainId: cfg.chainId,
      family: "op-bedrock",
      l2TxHash: l.transactionHash,
      l2Block: Number(l.blockNumber),
      key: extractWithdrawalHash(l),
      matched: matched.map((m) => "0x" + m),
      // Best-effort token/amount decode from the real log, for reporting only.
      extra: describeOpWithdrawal(l),
    });
  }

  // Independent coverage oracle: the L2CrossDomainMessenger nonce is monotonic, so the
  // number of messages sent in the window must equal the number of MessagePassed events.
  const nonceAt = async (b: number): Promise<number | undefined> => {
    const r = await l2
      .send("eth_call", [
        { to: EVENTS.sentMessageLegacy.address, data: ethers.utils.id("messageNonce()").slice(0, 10) },
        hex(b),
      ])
      .catch(() => undefined);
    if (!r) return undefined;
    const MASK = (1n << 240n) - 1n;
    return Number(BigInt(r) & MASK);
  };
  const [n0, n1] = await Promise.all([nonceAt(Math.max(1, fromBlock - 1)), nonceAt(toBlock)]);
  /**
   * The messenger nonce is a LOWER BOUND on MessagePassed events, not an equality: a contract can
   * call L2ToL1MessagePasser.initiateWithdrawal directly, emitting MessagePassed without touching
   * the CrossDomainMessenger. So `observed >= expected` is the correct assertion. It still catches
   * the failure we care about — silent truncation or a swallowed error drops observed BELOW the
   * nonce delta, which no legitimate withdrawal pattern can do.
   */
  const independent =
    n0 !== undefined && n1 !== undefined
      ? {
          name: "L2CrossDomainMessenger.messageNonce() delta (lower bound)",
          expected: n1 - n0,
          observed: stats.events,
          agrees: stats.events >= n1 - n0,
        }
      : undefined;

  return {
    candidates,
    coverage: {
      scanner: "op-bedrock/MessagePassed",
      stats,
      independent,
      exhaustive: stats.gaps.length === 0 && (independent?.agrees ?? false),
      note: independent ? undefined : "no nonce oracle available; exhaustiveness rests on zero failed chunks alone",
    },
  };
}

// ---------------------------------------------------------------------------
// OP-Stack, pre-Bedrock (legacy) era
// ---------------------------------------------------------------------------
/**
 * The scanner that found the 344 SNX. Pre-Bedrock withdrawals do not emit MessagePassed at
 * any block depth, so no amount of history on the Bedrock scanner reaches them.
 */
export async function scanOpLegacy(
  l2: ethers.providers.JsonRpcProvider,
  cfg: ChainConfig,
  fromBlock: number,
  toBlock: number,
  chunk?: number
): Promise<{ candidates: Candidate[]; coverage: Coverage }> {
  const needles = watchNeedles();
  const candidates: Candidate[] = [];
  const coder = ethers.utils.defaultAbiCoder;

  const { logs, stats } = await getLogsChunked(
    l2,
    { address: EVENTS.sentMessageLegacy.address, topics: [EVENTS.sentMessageLegacy.topic0] },
    fromBlock,
    toBlock,
    { chunk: chunk ?? 20_000 }
  );

  for (const l of logs) {
    const matched = payloadMatches(l, needles);
    if (matched.length === 0) continue;
    let key = "";
    const extra: Record<string, string> = {};
    try {
      // SentMessage(address indexed target, address sender, bytes message, uint256 nonce, uint256 gasLimit)
      const target = ethers.utils.getAddress("0x" + l.topics[1].slice(26));
      const [sender, message, nonce, gasLimit] = coder.decode(["address", "bytes", "uint256", "uint256"], l.data);
      // Both keys: v0 is what the pre-Bedrock messenger recorded, v1 is what the
      // post-Bedrock messenger records when it relays a legacy message. See oracles.ts.
      const v0 = legacyXDomainCalldataHash(target, sender, message, nonce);
      const v1 = legacyVersionedHash(nonce, sender, target, message);
      key = v0;
      extra.hashV0 = v0;
      extra.hashV1 = v1;
      extra.target = target;
      extra.sender = sender;
      extra.messageNonce = nonce.toString();
      extra.gasLimit = gasLimit.toString();
      extra.nonceVersion = String(BigInt(nonce.toString()) >> 240n);
    } catch (e) {
      extra.decodeError = String(e).slice(0, 120);
    }
    candidates.push({
      chainId: cfg.chainId,
      family: "op-legacy",
      l2TxHash: l.transactionHash,
      l2Block: Number(l.blockNumber),
      key,
      matched: matched.map((m) => "0x" + m),
      extra,
    });
  }

  return {
    candidates,
    coverage: {
      scanner: "op-legacy/SentMessage",
      stats,
      exhaustive: stats.gaps.length === 0,
      note: "legacy era; claim status resolved via L1CrossDomainMessenger.successfulMessages",
    },
  };
}

// ---------------------------------------------------------------------------
// Orbit
// ---------------------------------------------------------------------------
export async function scanOrbit(
  l2: ethers.providers.JsonRpcProvider,
  cfg: ChainConfig,
  fromBlock: number,
  toBlock: number,
  opts: { classic?: boolean; chunk?: number } = {}
): Promise<{ candidates: Candidate[]; coverage: Coverage }> {
  const needles = watchNeedles();
  const ev = opts.classic ? EVENTS.l2ToL1TransactionClassic : EVENTS.l2ToL1Tx;
  const candidates: Candidate[] = [];
  const positions: number[] = [];

  const { logs, stats } = await getLogsChunked(l2, { address: ev.address, topics: [ev.topic0] }, fromBlock, toBlock, {
    chunk: opts.chunk ?? 50_000,
  });

  for (const l of logs) {
    const matched = payloadMatches(l, needles);
    /**
     * THE TWO ERAS DO NOT SHARE A CLAIM KEY, and topic3 means different things in each.
     *
     *   Nitro   L2ToL1Tx(...):           topic3 = position   (global, monotonic)
     *   Classic L2ToL1Transaction(...):  topic2 = uniqueId,
     *                                    topic3 = batchNumber,
     *                                    data word 0 = indexInBatch
     *
     * Classic identifies a message by the PAIR (batchNumber, indexInBatch); batchNumber alone is
     * not a message id. Reading it as a Nitro position and handing it to isSpent(uint256) reads
     * unrelated state and answers confidently in both directions (measured: batchNumber 15531 for
     * classic uniqueId 81359 returns isSpent = true). Only `positions` below feeds the Nitro
     * contiguity oracle — classic batch numbers repeat across messages and are not a counter.
     */
    if (opts.classic) {
      const batchNumber = l.topics[3] ? BigInt(l.topics[3]).toString() : "";
      const uniqueId = l.topics[2] ? Number(BigInt(l.topics[2])) : NaN;
      /**
       * indexInBatch is data WORD 1, not word 0. `caller` is the first non-indexed parameter and
       * occupies word 0, so reading word 0 yields the caller address reinterpreted as an integer.
       * Verified against a real classic log: data = [caller, indexInBatch=2, arbBlockNum,
       * ethBlockNum, timestamp, callvalue, dataOffset], topic2 = uniqueId, topic3 = batchNumber.
       */
      const indexInBatch = l.data && l.data.length >= 130 ? BigInt("0x" + l.data.slice(66, 130)).toString() : "";
      // uniqueId is classic's global monotonic counter (verified: 83530, 83531 adjacent), so it
      // supports the same contiguity cross-check that `position` does for Nitro.
      if (!Number.isNaN(uniqueId)) positions.push(uniqueId);
      if (matched.length === 0) continue;
      candidates.push({
        chainId: cfg.chainId,
        family: "orbit-classic",
        l2TxHash: l.transactionHash,
        l2Block: Number(l.blockNumber),
        // Composite key, so nothing downstream can mistake it for a Nitro position.
        key: `${batchNumber}:${indexInBatch}`,
        matched: matched.map((m) => "0x" + m),
        extra: {
          batchNumber,
          indexInBatch,
          uniqueId: String(uniqueId),
          destination: l.topics[1] ? "0x" + l.topics[1].slice(26) : "",
        },
      });
      continue;
    }

    const pos = l.topics[3] ? Number(BigInt(l.topics[3])) : NaN;
    if (!Number.isNaN(pos)) positions.push(pos);
    if (matched.length === 0) continue;
    candidates.push({
      chainId: cfg.chainId,
      family: "orbit-nitro",
      l2TxHash: l.transactionHash,
      l2Block: Number(l.blockNumber),
      key: String(pos),
      matched: matched.map((m) => "0x" + m),
      extra: { position: String(pos), destination: l.topics[1] ? "0x" + l.topics[1].slice(26) : "" },
    });
  }

  /**
   * Coverage oracle: Orbit assigns every Nitro L2->L1 message a monotonic `position`, so a
   * contiguous run proves we saw every message in the range — stronger than chunk accounting,
   * because a silently truncated result set cannot satisfy it.
   *
   * AN EMPTY SEQUENCE PROVES NOTHING. The previous version set contiguous = true for zero
   * positions, so a wrong event address, a wrong topic0, or an endpoint that answered `[]` to
   * everything satisfied the cross-check vacuously and the scan was labelled exhaustive on the
   * strength of a zero corroborating itself. Contiguity needs at least two observations; below
   * that the independent check is reported as unavailable and exhaustiveness is NOT claimed.
   */
  positions.sort((a, b) => a - b);
  const contiguous = positions.every((p, i) => i === 0 || p === positions[i - 1] + 1 || p === positions[i - 1]);
  const proven = positions.length >= 2 && contiguous;
  const scanner = `${opts.classic ? "orbit-classic" : "orbit-nitro"}/${ev.signature.split("(")[0]}`;
  const counter = opts.classic ? "uniqueId" : "position";

  return {
    candidates,
    coverage: {
      scanner,
      stats,
      independent: proven
        ? {
            name: `L2ToL1 ${counter} contiguity`,
            expected: positions[positions.length - 1] - positions[0] + 1,
            observed: positions.length,
            agrees: true,
          }
        : undefined,
      exhaustive: stats.gaps.length === 0 && proven,
      note: proven
        ? undefined
        : positions.length === 0
          ? `no L2ToL1 ${counter}s observed — the contiguity cross-check is UNAVAILABLE, so this zero is not independently corroborated. Widen the range, or confirm the surrounding ${counter}s are adjacent by hand, before reading it as 'nothing pending'.`
          : positions.length === 1
            ? `only one ${counter} observed — contiguity is not testable with a single sample`
            : `${counter}s are NOT contiguous — messages are missing from this range`,
    },
  };
}

// ---------------------------------------------------------------------------
// TokensBridged sweep (SpokePool -> HubPool returns), all spokes x all event shapes
// ---------------------------------------------------------------------------
/**
 * Covers both augmentations Paul asked for:
 *   1. every historical SpokePool deployment, not just the current one
 *   2. every historical TokensBridged shape (the address -> bytes32 widening)
 * A SpokePool return that predates either change is invisible to a current-shape scan.
 */
export async function scanTokensBridged(
  l2: ethers.providers.JsonRpcProvider,
  cfg: ChainConfig,
  fromBlock: number,
  toBlock: number,
  chunk?: number
): Promise<{ hits: Array<{ spoke: string; variant: string; log: Log }>; coverage: Coverage[] }> {
  const hits: Array<{ spoke: string; variant: string; log: Log }> = [];
  const coverage: Coverage[] = [];
  for (const spoke of cfg.spokePools) {
    for (const v of TOKENS_BRIDGED_VARIANTS) {
      const start = Math.max(fromBlock, spoke.fromBlock ?? fromBlock);
      const { logs, stats } = await getLogsChunked(l2, { address: spoke.address, topics: [v.topic0] }, start, toBlock, {
        chunk: chunk ?? 50_000,
      });
      logs.forEach((log) => hits.push({ spoke: spoke.address, variant: v.signature, log }));
      /**
       * `verified: false` means the address itself was never confirmed to emit logs on-chain —
       * Redstone and Aleph Zero, whose L2 RPCs are dead. A zero-log result from an address we
       * cannot prove is the right address is not evidence of anything, so it must not be labelled
       * exhaustive: doing so turns "we never checked" into a clean bill of health the moment an
       * archive RPC becomes reachable. Any HIT, by contrast, proves the address is real.
       */
      const addressProven = spoke.verified !== false || logs.length > 0;
      coverage.push({
        scanner: `tokensBridged/${spoke.label}/${v.era}`,
        stats,
        exhaustive: stats.gaps.length === 0 && addressProven,
        note: addressProven
          ? undefined
          : `SpokePool ${spoke.address} is UNVERIFIED (${spoke.label}) — a zero here is unproven, not clean`,
      });
    }
  }
  return { hits, coverage };
}

// ---------------------------------------------------------------------------
// Polygon PoS burns
// ---------------------------------------------------------------------------
export async function scanPolygonBurns(
  l2: ethers.providers.JsonRpcProvider,
  cfg: ChainConfig,
  tokens: string[],
  fromBlock: number,
  toBlock: number,
  chunk?: number
): Promise<{ candidates: Candidate[]; coverage: Coverage[] }> {
  const candidates: Candidate[] = [];
  const coverage: Coverage[] = [];
  const zero = ethers.utils.hexZeroPad(ethers.constants.AddressZero, 32);
  const senders = [...Object.keys(WATCH), ...cfg.spokePools.map((s) => s.address)];

  for (const token of tokens) {
    for (const from of senders) {
      const { logs, stats } = await getLogsChunked(
        l2,
        {
          address: token,
          topics: [EVENTS.erc20Transfer.topic0, ethers.utils.hexZeroPad(from, 32), zero],
        },
        fromBlock,
        toBlock,
        { chunk: chunk ?? 100_000 }
      );
      for (const l of logs) {
        // The exit key needs txIndex and the RECEIPT-LOCAL log index (not the block-global
        // logIndex), so pull the receipt for candidates only — the set is small.
        let receiptLogIndex: number | undefined;
        let isWithdrawCall: boolean | undefined;
        try {
          const rc = await l2.send("eth_getTransactionReceipt", [l.transactionHash]);
          const idx = (rc?.logs ?? []).findIndex((x: Log) => Number(x.logIndex) === Number(l.logIndex));
          if (idx >= 0) receiptLogIndex = idx;
          const tx = await l2.send("eth_getTransactionByHash", [l.transactionHash]);
          // Burn->0x0 is necessary but NOT sufficient: LayerZero OFT sends also burn. Require the
          // tx to have called withdraw(uint256)=0x2e1a7d4d or withdrawTo.
          const inp = String(tx?.input ?? "").toLowerCase();
          isWithdrawCall = inp.startsWith("0x2e1a7d4d") || inp.startsWith("0x205c2878");
        } catch {
          /* leave undefined; index.ts treats missing pieces as unresolved rather than claimed */
        }
        candidates.push({
          chainId: cfg.chainId,
          family: "polygon-pos",
          l2TxHash: l.transactionHash,
          l2Block: Number(l.blockNumber),
          key: `${token}:${BigInt(l.data).toString()}`,
          matched: [from],
          extra: {
            token,
            amount: BigInt(l.data).toString(),
            txIndex: String(Number(l.transactionIndex)),
            ...(receiptLogIndex !== undefined ? { receiptLogIndex: String(receiptLogIndex) } : {}),
            ...(isWithdrawCall !== undefined ? { isWithdrawCall: String(isWithdrawCall) } : {}),
          },
        });
      }
      coverage.push({
        scanner: `polygon-burn/${token.slice(0, 10)}/${from.slice(0, 10)}`,
        stats,
        exhaustive: stats.gaps.length === 0,
      });
    }
  }
  return { candidates, coverage };
}

/** Best-effort token/amount decode for reporting. Never load-bearing for correctness. */
export function describeOpWithdrawal(log: Log): Record<string, string> {
  const out: Record<string, string> = {};
  const data = log.data.toLowerCase();
  const known: Record<string, string> = {
    a9f9e675: "finalizeERC20Withdrawal(address,address,address,address,uint256,bytes)",
    "0166a07a": "finalizeBridgeERC20(address,address,address,address,uint256,bytes)",
    "1532ec34": "finalizeBridgeETH(address,address,uint256,bytes)",
    "32b3a987": "bridged-USDC finalizeDeposit",
  };
  for (const [sel, name] of Object.entries(known)) {
    const i = data.indexOf(sel);
    if (i < 0) continue;
    out.innerCall = name;
    const s = data.slice(i + 8);
    try {
      if (sel === "a9f9e675" || sel === "0166a07a") {
        out.l1Token = "0x" + s.slice(24, 64);
        out.l2Token = "0x" + s.slice(64 + 24, 128);
        out.from = "0x" + s.slice(128 + 24, 192);
        out.to = "0x" + s.slice(192 + 24, 256);
        out.amount = BigInt("0x" + s.slice(256, 320)).toString();
      }
    } catch {
      /* reporting only */
    }
    break;
  }
  return out;
}
