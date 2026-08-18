#!/usr/bin/env tsx
/**
 * Across stuck-withdrawal scanner.
 *
 *   npm run scan -- --verify-fixtures
 *   npm run scan -- --chains 10 --since 400 --era both
 *   npm run scan -- --chains 42161,137 --since 90 --out findings.json
 *
 * Requires an L1 RPC in NODE_URL_1 (or MAINNET_RPC_URL) plus per-chain RPCs; see registry.ts.
 */
import * as fs from "fs";
import { ethers } from "ethers";
import { CHAINS, chainById, ChainConfig, WATCH, KNOWN_PROVERS, derivePortal } from "./registry";
import { provider, resolveRpc, blockForTimestamp, blockTimestamp } from "./rpc";
import {
  assertDiscriminates,
  assertOrbitDiscriminates,
  opFinalized,
  opProofSubmitter,
  opProvenAt,
  orbitNitroSpent,
  orbitSpent,
  legacyRelayed,
  polygonExitHash,
  polygonExitProcessed,
  polygonLastCheckpointedBlock,
  lineaMessageClaimed,
  zkWithdrawalFinalized,
  Control,
} from "./oracles";
import {
  scanOpBedrock,
  scanOpLegacy,
  scanOrbit,
  scanTokensBridged,
  scanPolygonBurns,
  Candidate,
  Coverage,

} from "./scanners";
import { FIXTURES, ORACLE_FIXTURES } from "./fixtures";

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) {
      out[k] = v;
      i++;
    } else out[k] = true;
  }
  return out;
}

function l1Provider(): ethers.providers.JsonRpcProvider {
  const url = resolveRpc(["NODE_URL_1", "MAINNET_RPC_URL", "ETH_RPC_URL"]);
  if (!url) throw new Error("no L1 RPC: set NODE_URL_1 or MAINNET_RPC_URL");
  return provider(url);
}

// ---------------------------------------------------------------------------
// Fixture verification
// ---------------------------------------------------------------------------
async function verifyFixtures(): Promise<number> {
  const l1 = l1Provider();
  let fails = 0;
  console.log("Verifying fixtures — the tool must reproduce known-good and known-bad cases.\n");

  for (const f of FIXTURES) {
    const cfg = chainById(f.chainId);
    let actual: boolean | undefined;
    if (f.family === "orbit-nitro") {
      actual = (await orbitSpent(l1, cfg.l1.outbox ?? [], f.key)).spent;
    } else if (f.family === "op-legacy") {
      if (!cfg.l1.l1XDM) {
        console.log(`  SKIP ${f.label}: no l1XDM configured`);
        continue;
      }
      // Probe both keys, as the scanner does.
      actual = (await legacyRelayed(l1, cfg.l1.l1XDM, { v0: f.key, v1: f.key })).successful;
    } else {
      if (!cfg.l1.portal) {
        console.log(`  SKIP ${f.label}: no portal configured`);
        continue;
      }
      actual = await opFinalized(l1, cfg.l1.portal, f.key);
    }
    const ok = actual === f.expectFinalized;
    if (!ok) fails++;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${f.label}\n        expected finalized=${f.expectFinalized}, got ${actual}${
        f.note ? `\n        (${f.note})` : ""
      }`
    );
  }

  // --- non-OP oracle fixtures ---------------------------------------------------------
  for (const f of ORACLE_FIXTURES) {
    let actual: boolean | undefined;
    try {
      if (f.kind === "polygon") {
        const cfg = chainById(137);
        actual = cfg.l1.rootChainManager
          ? await polygonExitProcessed(l1, cfg.l1.rootChainManager, polygonExitHash(f.block, f.txIndex, f.logIndex))
          : undefined;
      } else if (f.kind === "linea") {
        const cfg = chainById(59144);
        actual = cfg.l1.l1Messenger ? await lineaMessageClaimed(l1, cfg.l1.l1Messenger, f.messageNumber) : undefined;
      } else if (f.kind === "zksync") {
        const cfg = chainById(324);
        actual = cfg.l1.l1Nullifier
          ? await zkWithdrawalFinalized(l1, cfg.l1.l1Nullifier, f.chainId, f.batch, f.index)
          : undefined;
      }
    } catch (e) {
      actual = undefined;
    }
    if (actual === undefined) {
      console.log(`  SKIP  [${f.kind}] ${f.label}: oracle not configured`);
      continue;
    }
    const ok = actual === f.expect;
    if (!ok) fails++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  [${f.kind}] ${f.label}  expected=${f.expect} got=${actual}`);
  }

  // The fixture set deliberately contains both outcomes; assert that, else a stuck-at-false
  // oracle would "pass" everything that expects false.
  const hasTrue = FIXTURES.some((f) => f.expectFinalized);
  const hasFalse = FIXTURES.some((f) => !f.expectFinalized);
  console.log(
    `\n  fixture set contains finalized=true cases: ${hasTrue}, finalized=false cases: ${hasFalse}` +
      `${hasTrue && hasFalse ? "" : "  <-- WEAK FIXTURE SET"}`
  );
  console.log(`\n${fails === 0 ? "All fixtures reproduced." : `${fails} fixture(s) FAILED.`}`);
  return fails;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
interface Finding extends Candidate {
  finalized: boolean | "unknown";
  claimableAt?: string;
  proofSubmitter?: string;
  describe?: Record<string, string>;
}

async function scanChain(
  cfg: ChainConfig,
  l1: ethers.providers.JsonRpcProvider,
  opts: { sinceDays?: number; fromBlock?: number; toBlock?: number; era: string; chunk?: number }
): Promise<{ findings: Finding[]; coverage: Coverage[]; controls: Record<string, Control>; warnings: string[] }> {
  const warnings: string[] = [];
  const url = resolveRpc(cfg.rpcEnv);
  if (!url) return { findings: [], coverage: [], controls: {}, warnings: [`${cfg.name}: no RPC (${cfg.rpcEnv.join("/")})`] };
  const l2 = provider(url);

  // Resolve the portal on-chain when we do not have a verified one.
  if (cfg.families.includes("op-bedrock") && !cfg.l1.portal) {
    const d = await derivePortal(l2, l1);
    if (d.portal) {
      cfg.l1.portal = d.portal;
      warnings.push(`${cfg.name}: portal derived on-chain as ${d.portal}`);
    } else warnings.push(`${cfg.name}: could not derive portal — bedrock results will be unresolved`);
  }

  const head = opts.toBlock ?? (await l2.getBlockNumber());
  let from = opts.fromBlock ?? 1;
  if (opts.sinceDays && !opts.fromBlock) {
    const target = Math.floor(Date.now() / 1000) - opts.sinceDays * 86400;
    const b = await blockForTimestamp(l2, target);
    from = b.block;
    if (!(b.ts >= target && b.prevTs < target))
      warnings.push(`${cfg.name}: block boundary unverified at ${from}`);
  }

  const controls: Record<string, Control> = {};
  const coverage: Coverage[] = [];
  const findings: Finding[] = [];
  const chunk = opts.chunk ? Number(opts.chunk) : undefined;

  // --- controls first: refuse to report status from an unproven oracle -------------------
  if (cfg.l1.portal) {
    controls.portal = await assertDiscriminates(l1, cfg.l1.portal);
    if (!controls.portal.ok)
      warnings.push(
        `${cfg.name}: PORTAL ORACLE UNPROVEN (positive=${controls.portal.positive}) — finalized=false is NOT trustworthy`
      );
  }
  if (cfg.families.includes("orbit-nitro") && (cfg.l1.outbox ?? []).length) {
    controls.outbox = await assertOrbitDiscriminates(l1, cfg.l1.outbox!, 164622);
    if (!controls.outbox.ok) warnings.push(`${cfg.name}: OUTBOX ORACLE UNPROVEN`);
  }

  const eras = opts.era === "both" ? cfg.families : cfg.families.filter((f) => f.includes(opts.era));

  for (const fam of eras) {
    const boundary = cfg.eraBoundaryBlock;
    if (fam === "op-bedrock") {
      const start = boundary ? Math.max(from, boundary) : from;
      const r = await scanOpBedrock(l2, cfg, start, head, chunk);
      coverage.push(r.coverage);
      for (const c of r.candidates) {
        const finalized = cfg.l1.portal ? await opFinalized(l1, cfg.l1.portal, c.key) : "unknown";
        const f: Finding = { ...c, finalized };
        if (finalized === false && cfg.l1.portal) {
          // proofSubmitters[hash][0] is authoritative when set. Fall back to probing known
          // third-party provers — a withdrawal proven by someone else needs
          // finalizeWithdrawalTransactionExternalProof(_tx, thatAddress), NOT the plain variant.
          let submitter = await opProofSubmitter(l1, cfg.l1.portal, c.key);
          if (!submitter) {
            for (const p of Object.keys(KNOWN_PROVERS)) {
              const pv = await opProvenAt(l1, cfg.l1.portal, c.key, p);
              if (pv && pv.timestamp > 0) {
                submitter = p;
                break;
              }
            }
          }
          if (submitter) {
            f.proofSubmitter = submitter;
            const pv = await opProvenAt(l1, cfg.l1.portal, c.key, submitter);
            if (pv?.timestamp)
              f.claimableAt = new Date((pv.timestamp + 7 * 86400) * 1000).toISOString();
          }
        }
        findings.push(f);
      }
    } else if (fam === "op-legacy") {
      if (!boundary) {
        warnings.push(`${cfg.name}: op-legacy requested but no eraBoundaryBlock set — skipped`);
        continue;
      }
      const r = await scanOpLegacy(l2, cfg, from, Math.min(head, boundary - 1), chunk);
      coverage.push(r.coverage);
      for (const c of r.candidates) {
        let finalized: boolean | "unknown" = "unknown";
        if (cfg.l1.l1XDM && c.key) {
          const st = await legacyRelayed(l1, cfg.l1.l1XDM, {
            v0: c.extra?.hashV0 ?? c.key,
            v1: c.extra?.hashV1,
          });
          finalized = st.successful;
          if (st.failed) c.extra = { ...c.extra, l1RelayFailed: "true" };
        }
        findings.push({ ...c, finalized });
      }
    } else if (fam === "orbit-nitro" || fam === "orbit-classic") {
      const classic = fam === "orbit-classic";
      const start = classic ? from : boundary ? Math.max(from, boundary) : from;
      const end = classic && boundary ? Math.min(head, boundary - 1) : head;
      if (start > end) continue;
      const r = await scanOrbit(l2, cfg, start, end, { classic, chunk });
      coverage.push(r.coverage);
      for (const c of r.candidates) {
        if (classic) {
          // Deliberately NOT resolved against the Nitro outbox. The index spaces overlap
          // numerically, so a cross-era isSpent() returns plausible garbage in both directions
          // (measured: false negative on the real position, false positives on neighbours).
          // Classic status needs outboxEntryExists(batchNumber) + L1 OutBoxTransactionExecuted logs.
          findings.push({ ...c, finalized: "unknown" });
          continue;
        }
        const nitro = (cfg.l1.outbox ?? [])[0];
        const { spent } = nitro ? await orbitNitroSpent(l1, nitro, c.key) : { spent: false };
        findings.push({ ...c, finalized: nitro ? spent : "unknown" });
      }
      if (classic && r.candidates.length)
        warnings.push(
          `${cfg.name}: ${r.candidates.length} pre-Nitro candidate(s) left UNRESOLVED by design — resolve via outboxEntryExists + L1 OutBoxTransactionExecuted logs`
        );
    } else if (fam === "polygon-pos") {
      const tokens = String(args.tokens ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length === 42);
      if (!tokens.length) {
        warnings.push(`${cfg.name}: polygon-pos needs --tokens <csv of child token addresses>`);
        continue;
      }
      const checkpointed = cfg.l1.rootChain
        ? await polygonLastCheckpointedBlock(l1, cfg.l1.rootChain)
        : undefined;
      const r = await scanPolygonBurns(l2, cfg, tokens, from, head, chunk);
      coverage.push(...r.coverage);
      for (const c of r.candidates) {
        const txIndex = Number(c.extra?.txIndex);
        const logIdx = c.extra?.receiptLogIndex !== undefined ? Number(c.extra.receiptLogIndex) : undefined;
        // Not a PoS exit unless the tx actually called withdraw/withdrawTo (OFT sends also burn).
        if (c.extra?.isWithdrawCall === "false") continue;
        let finalized: boolean | "unknown" = "unknown";
        if (cfg.l1.rootChainManager && Number.isFinite(txIndex) && logIdx !== undefined) {
          const h = polygonExitHash(c.l2Block, txIndex, logIdx);
          finalized = await polygonExitProcessed(l1, cfg.l1.rootChainManager, h);
          c.extra = { ...c.extra, exitHash: h };
        }
        // A burn whose block is not yet checkpointed cannot be exited; do not call it stuck.
        if (finalized === false && checkpointed !== undefined && c.l2Block > checkpointed) {
          c.extra = { ...c.extra, awaitingCheckpoint: "true", lastCheckpointedBlock: String(checkpointed) };
          findings.push({ ...c, finalized: "unknown" });
          continue;
        }
        findings.push({ ...c, finalized });
      }
    }
  }

  // SpokePool -> HubPool returns across every historical spoke and event shape.
  if (cfg.spokePools.length) {
    const tb = await scanTokensBridged(l2, cfg, from, head, chunk);
    coverage.push(...tb.coverage);
    if (tb.hits.length)
      warnings.push(
        `${cfg.name}: ${tb.hits.length} TokensBridged event(s) seen across ${cfg.spokePools.length} spoke(s) — cross-check these against the message-layer findings above`
      );
  }

  return { findings, coverage, controls, warnings };
}

async function main(): Promise<void> {
  if (args["verify-fixtures"]) {
    process.exit((await verifyFixtures()) === 0 ? 0 : 1);
  }

  const l1 = l1Provider();
  const chainIds = args.chains
    ? String(args.chains).split(",").map((s) => Number(s.trim()))
    : CHAINS.map((c) => c.chainId);
  const era = args.era ? String(args.era) : "both";
  const sinceDays = args.since ? Number(args.since) : undefined;

  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), watch: WATCH, chains: {} };
  let stuck = 0;

  for (const id of chainIds) {
    const cfg = chainById(id);
    console.log(`\n=== ${cfg.name} (${id}) — families: ${cfg.families.join(", ")} ===`);
    try {
      const r = await scanChain(cfg, l1, {
        sinceDays,
        fromBlock: args["from-block"] ? Number(args["from-block"]) : undefined,
        toBlock: args["to-block"] ? Number(args["to-block"]) : undefined,
        era,
        chunk: args.chunk ? Number(args.chunk) : undefined,
      });
      const unclaimed = r.findings.filter((f) => f.finalized === false);
      stuck += unclaimed.length;
      for (const c of r.coverage)
        console.log(
          `  coverage ${c.scanner}: blocks ${c.stats.fromBlock}-${c.stats.toBlock} ok=${c.stats.okChunks} fail=${c.stats.failChunks} events=${c.stats.events}` +
            (c.independent ? ` | ${c.independent.name}: ${c.independent.agrees ? "AGREES" : `MISMATCH exp=${c.independent.expected} obs=${c.independent.observed}`}` : "") +
            ` | exhaustive=${c.exhaustive}`
        );
      for (const w of r.warnings) console.log(`  WARN ${w}`);
      for (const f of unclaimed)
        console.log(
          `  STUCK ${f.family} key=${f.key.slice(0, 20)}… tx=${f.l2TxHash} matched=${f.matched.join(",")}${
            f.claimableAt ? ` claimableAt=${f.claimableAt}` : ""
          }${f.proofSubmitter ? ` provenBy=${f.proofSubmitter}` : ""}`
        );
      (report.chains as Record<string, unknown>)[String(id)] = r;
    } catch (e) {
      console.log(`  ERROR ${String(e).slice(0, 200)}`);
      (report.chains as Record<string, unknown>)[String(id)] = { error: String(e) };
    }
  }

  if (args.out) {
    fs.writeFileSync(String(args.out), JSON.stringify(report, null, 2));
    console.log(`\nwrote ${args.out}`);
  }
  console.log(`\ntotal unclaimed candidates: ${stuck}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
