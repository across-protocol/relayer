#!/usr/bin/env tsx
/**
 * Across stuck-withdrawal scanner.
 *
 *   npm run scan -- --verify-fixtures
 *   npm run scan -- --chains 10 --since 400 --era both
 *   npm run scan -- --chains 42161,137 --since 90 --out findings.json
 *
 * Requires an L1 RPC in NODE_URL_1 (or MAINNET_RPC_URL) plus per-chain RPCs; see registry.ts.
 *
 * EXIT CODES — the whole point of separating 2 from 0:
 *   0  scan complete, every oracle proven, nothing unclaimed
 *   1  scan complete, unclaimed withdrawals found (actionable)
 *   2  scan INCOMPLETE or UNPROVEN — a requested chain was unreachable, a log range could not be
 *      read, or an oracle failed its control. "We do not know" must never look like "all clear",
 *      so this outranks 1: never let automation read a chain it never contacted as clean.
 */
import * as fs from "fs";
import { ethers } from "ethers";
import { CHAINS, chainById, ChainConfig, WATCH, KNOWN_PROVERS, derivePortal } from "./registry";
import { provider, resolveRpc, blockForTimestamp } from "./rpc";
import {
  assertDiscriminates,
  assertOrbitDiscriminates,
  assertLegacyDiscriminates,
  assertPolygonDiscriminates,
  assertOrbitClassicDiscriminates,
  opFinalized,
  opClaimability,
  opProofSubmitters,
  opProvenAt,
  orbitNitroSpent,
  orbitSpent,
  orbitClassicExecuted,
  legacyRelayed,
  legacyXDomainCalldataHash,
  legacyVersionedHash,
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
import { FIXTURES, ORACLE_FIXTURES, DERIVATION_FIXTURES } from "./fixtures";
import { selfTestChunking } from "./selfTest";

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
  let fails = 0;

  console.log("RPC plumbing self-tests (offline — no RPC):\n");
  for (const t of await selfTestChunking()) {
    if (!t.ok) fails++;
    console.log(`  ${t.ok ? "PASS" : "FAIL"}  ${t.label}  [${t.detail}]`);
  }

  /**
   * Offline half first: it needs no RPC and it covers the derivations the on-chain fixtures
   * cannot. A key computed wrongly reads "not relayed" against a perfectly healthy oracle.
   */
  console.log("\nDerivation fixtures (offline — no RPC):\n");
  for (const d of DERIVATION_FIXTURES) {
    const v0 = legacyXDomainCalldataHash(d.target, d.sender, d.message, d.messageNonce);
    const v1 = legacyVersionedHash(d.messageNonce, d.sender, d.target, d.message);
    for (const [which, got, want] of [
      ["v0 xDomainCalldata", v0, d.expectV0],
      ["v1 versioned", v1, d.expectV1],
    ] as const) {
      const ok = got.toLowerCase() === want.toLowerCase();
      if (!ok) fails++;
      console.log(
        `  ${ok ? "PASS" : "FAIL"}  ${d.label} / ${which}${ok ? "" : `\n        want ${want}\n        got  ${got}`}`
      );
    }
  }

  const l1 = l1Provider();
  console.log("\nClaim-key fixtures (on-chain):\n");

  for (const f of FIXTURES) {
    const cfg = chainById(f.chainId);
    let actual: boolean | undefined;
    try {
      if (f.family === "orbit-nitro") {
        actual = (await orbitSpent(l1, cfg.l1.outbox ?? [], f.key ?? "0")).spent;
      } else if (f.family === "op-legacy") {
        if (!cfg.l1.l1XDM) {
          console.log(`  SKIP ${f.label}: no l1XDM configured`);
          continue;
        }
        // Probe exactly the keys the fixture declares — see Fixture.keys in fixtures.ts.
        const keys = f.keys ?? { v0: f.key };
        actual = (await legacyRelayed(l1, cfg.l1.l1XDM, keys)).successful;
      } else {
        if (!cfg.l1.portal) {
          console.log(`  SKIP ${f.label}: no portal configured`);
          continue;
        }
        actual = await opFinalized(l1, cfg.l1.portal, f.key ?? "");
      }
    } catch (e) {
      // An RPC that cannot answer is not a fixture failure, but it IS an unverified run.
      fails++;
      console.log(`  ERROR ${f.label}: ${String(e).slice(0, 140)}`);
      continue;
    }

    // Claim status is monotonic: false -> true is legal drift on a fixture that pins live state.
    const drifted = f.mutable === true && f.expectFinalized === false && actual === true;
    const ok = actual === f.expectFinalized || drifted;
    if (!ok) fails++;
    const verdict = drifted ? "DRIFT" : ok ? "PASS" : "FAIL";
    console.log(
      `  ${verdict}  ${f.label}\n        expected finalized=${f.expectFinalized}, got ${actual}${
        drifted ? "\n        (claimed since the fixture was recorded — expected, not a failure)" : ""
      }${f.note ? `\n        (${f.note})` : ""}`
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
      fails++;
      console.log(`  ERROR [${f.kind}] ${f.label}: ${String(e).slice(0, 140)}`);
      continue;
    }
    if (actual === undefined) {
      console.log(`  SKIP  [${f.kind}] ${f.label}: oracle not configured`);
      continue;
    }
    // Same monotonic-drift rule as the OP fixtures: a live negative that has since been claimed is
    // expected, not a regression. Only fixtures marked mutable get that latitude.
    const drifted = f.mutable === true && f.expect === false && actual === true;
    const ok = actual === f.expect || drifted;
    if (!ok) fails++;
    console.log(
      `  ${drifted ? "DRIFT" : ok ? "PASS" : "FAIL"}  [${f.kind}] ${f.label}  expected=${f.expect} got=${actual}` +
        `${drifted ? " (claimed since the fixture was recorded — expected)" : ""}`
    );
  }

  /**
   * The fixture set must contain both outcomes, and the negatives must include at least one that
   * can never legally flip — otherwise a stuck-at-false oracle "passes" every negative and a
   * stuck-at-true one is caught by nothing.
   */
  const hasTrue = FIXTURES.some((f) => f.expectFinalized);
  const permanentFalse = FIXTURES.filter((f) => !f.expectFinalized && !f.mutable).length;
  console.log(
    `\n  fixture set: finalized=true cases: ${hasTrue}, permanent finalized=false cases: ${permanentFalse}` +
      `${hasTrue && permanentFalse > 0 ? "" : "  <-- WEAK FIXTURE SET"}`
  );
  if (!hasTrue || permanentFalse === 0) fails++;
  console.log(`\n${fails === 0 ? "All fixtures reproduced." : `${fails} fixture check(s) FAILED.`}`);
  return fails;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
interface Finding extends Candidate {
  finalized: boolean | "unknown";
  /** Why the status is `unknown`. Present iff finalized === "unknown". */
  unresolved?: string;
  claimableAt?: string;
  claimableBlockedOn?: string;
  proofSubmitter?: string;
  describe?: Record<string, string>;
}

interface ChainResult {
  findings: Finding[];
  coverage: Coverage[];
  controls: Record<string, Control>;
  warnings: string[];
  /** True only when every chain family was scanned end to end with a proven oracle. */
  complete: boolean;
}

/** Run an oracle, converting a node that could not answer into `unknown` rather than `false`. */
async function status(
  label: string,
  fn: () => Promise<boolean>,
  warnings: string[]
): Promise<{ value: boolean | "unknown"; unresolved?: string }> {
  try {
    return { value: await fn() };
  } catch (e) {
    const reason = `${label}: RPC could not answer (${String(e).slice(0, 120)})`;
    warnings.push(reason);
    return { value: "unknown", unresolved: reason };
  }
}

async function scanChain(
  cfg: ChainConfig,
  l1: ethers.providers.JsonRpcProvider,
  opts: { sinceDays?: number; fromBlock?: number; toBlock?: number; era: string; chunk?: number }
): Promise<ChainResult> {
  const warnings: string[] = [];
  const url = resolveRpc(cfg.rpcEnv);
  if (!url)
    return {
      findings: [],
      coverage: [],
      controls: {},
      // NOT complete. A chain we never contacted has to be loud, or a caller counting zero
      // findings reads "no RPC configured" as "nothing pending".
      complete: false,
      warnings: [`${cfg.name}: NOT SCANNED — no RPC configured (${cfg.rpcEnv.join("/")})`],
    };
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
    if (!(b.ts >= target && b.prevTs < target)) warnings.push(`${cfg.name}: block boundary unverified at ${from}`);
  }

  const controls: Record<string, Control> = {};
  const coverage: Coverage[] = [];
  const findings: Finding[] = [];
  const chunk = opts.chunk ? Number(opts.chunk) : undefined;

  /**
   * CONTROLS FIRST, and they are gates, not warnings.
   *
   * Every `finalized: false` below is only reported as a finding if the oracle that produced it has
   * been shown to also return true. An unproven oracle yields `unknown`. The previous version
   * warned and then reported anyway, so on a chain whose control could not pass (Blast, which has
   * no self-emitted WithdrawalFinalized topics) the console and the JSON both listed every
   * candidate as STUCK with the disclaimer buried in a separate warnings array.
   */
  if (cfg.l1.portal) {
    controls.portal = await assertDiscriminates(l1, cfg.l1.portal, cfg.controls?.finalizedWithdrawalHashes ?? []);
    if (!controls.portal.ok)
      warnings.push(
        `${cfg.name}: PORTAL ORACLE UNPROVEN (positive=${controls.portal.positive}, negative=${controls.portal.negative}) — ` +
          `bedrock statuses forced to unknown. ${controls.portal.detail}`
      );
  }
  if (cfg.families.includes("orbit-nitro") && (cfg.l1.outbox ?? []).length) {
    /**
     * The known-spent position is per chain (registry controls.spentOutboxPosition). It used to be
     * the literal 164622 for every Orbit chain — which is Arbitrum's, and which fixtures.ts
     * simultaneously pins as UNSPENT because it was inside its challenge window. So the positive
     * control asked "is this unclaimed withdrawal claimed?", got the correct `false`, and declared
     * the oracle broken on every single Arbitrum scan.
     */
    const pos = cfg.controls?.spentOutboxPosition;
    if (pos === undefined) {
      controls.outbox = {
        ok: false,
        positive: "unavailable",
        negative: "pass",
        detail: "no controls.spentOutboxPosition configured for this chain",
      };
      warnings.push(`${cfg.name}: OUTBOX ORACLE UNPROVEN — no known-spent position in registry`);
    } else {
      controls.outbox = await assertOrbitDiscriminates(l1, cfg.l1.outbox!, pos);
      if (!controls.outbox.ok)
        warnings.push(
          `${cfg.name}: OUTBOX ORACLE UNPROVEN (${controls.outbox.detail}) — orbit statuses forced to unknown`
        );
    }
  }
  if (cfg.families.includes("op-legacy") && cfg.l1.l1XDM) {
    // Was implemented but never called. Same gate as the portal: prove it, or report unknown.
    controls.legacy = await assertLegacyDiscriminates(l1, cfg.l1.l1XDM, cfg.controls?.relayedLegacyHashes ?? []);
    if (!controls.legacy.ok)
      warnings.push(
        `${cfg.name}: LEGACY ORACLE UNPROVEN (positive=${controls.legacy.positive}) — legacy statuses forced to unknown. ${controls.legacy.detail}`
      );
  }
  if (cfg.families.includes("polygon-pos") && cfg.l1.rootChainManager && cfg.controls?.processedExit) {
    controls.polygon = await assertPolygonDiscriminates(l1, cfg.l1.rootChainManager, cfg.controls.processedExit);
    if (!controls.polygon.ok) warnings.push(`${cfg.name}: POLYGON EXIT ORACLE UNPROVEN — statuses forced to unknown`);
  }

  const requested = opts.era === "both" ? cfg.families : cfg.families.filter((f) => f.includes(opts.era));
  const eras = requested;
  let familiesSkipped = 0;

  for (const fam of eras) {
    const boundary = cfg.eraBoundaryBlock;
    if (fam === "op-bedrock") {
      const start = boundary ? Math.max(from, boundary) : from;
      const r = await scanOpBedrock(l2, cfg, start, head, chunk);
      coverage.push(r.coverage);
      const proven = controls.portal?.ok === true;
      for (const c of r.candidates) {
        if (!cfg.l1.portal || !proven) {
          findings.push({
            ...c,
            finalized: "unknown",
            unresolved: !cfg.l1.portal
              ? "no portal configured"
              : `portal control not passed (positive=${controls.portal?.positive})`,
          });
          continue;
        }
        const st = await status(
          `${cfg.name}/finalizedWithdrawals`,
          () => opFinalized(l1, cfg.l1.portal!, c.key),
          warnings
        );
        const f: Finding = { ...c, finalized: st.value, unresolved: st.unresolved };
        if (st.value === false) {
          /**
           * Enumerate proof submitters rather than reading index 0. A reproven withdrawal keeps its
           * stale first proof at index 0, backed by a game that will never resolve favourably;
           * recommending that submitter sends the operator into a reverting finalization. Fall back
           * to probing known third-party provers, since a withdrawal proven by someone else needs
           * finalizeWithdrawalTransactionExternalProof(_tx, thatAddress), NOT the plain variant.
           */
          try {
            let submitters = await opProofSubmitters(l1, cfg.l1.portal, c.key);
            if (!submitters.length) {
              for (const p of Object.keys(KNOWN_PROVERS)) {
                const pv = await opProvenAt(l1, cfg.l1.portal, c.key, p);
                if (pv && pv.timestamp > 0) submitters = [p];
              }
            }
            if (submitters.length) {
              const cl = await opClaimability(l1, cfg.l1.portal, c.key, submitters);
              f.proofSubmitter = cl.proofSubmitter;
              if (cl.claimableAt) f.claimableAt = new Date(cl.claimableAt * 1000).toISOString();
              if (cl.blockedOn) f.claimableBlockedOn = cl.blockedOn;
              if (submitters.length > 1)
                f.extra = { ...f.extra, proofSubmitters: submitters.join(","), reproven: "true" };
            }
          } catch (e) {
            f.claimableBlockedOn = `could not read proof state: ${String(e).slice(0, 120)}`;
          }
        }
        findings.push(f);
      }
    } else if (fam === "op-legacy") {
      if (!boundary) {
        warnings.push(`${cfg.name}: op-legacy requested but no eraBoundaryBlock set — SKIPPED (coverage incomplete)`);
        familiesSkipped++;
        continue;
      }
      const r = await scanOpLegacy(l2, cfg, from, Math.min(head, boundary - 1), chunk);
      coverage.push(r.coverage);
      const proven = controls.legacy?.ok === true;
      for (const c of r.candidates) {
        if (!cfg.l1.l1XDM || !c.key || !proven) {
          findings.push({
            ...c,
            finalized: "unknown",
            unresolved: !cfg.l1.l1XDM
              ? "no l1XDM configured"
              : !c.key
                ? "could not derive a claim key from the SentMessage log"
                : `legacy control not passed (positive=${controls.legacy?.positive})`,
          });
          continue;
        }
        const st = await status(
          `${cfg.name}/successfulMessages`,
          async () => {
            const r2 = await legacyRelayed(l1, cfg.l1.l1XDM!, {
              v0: c.extra?.hashV0 ?? c.key,
              v1: c.extra?.hashV1,
              v1Zero: c.extra?.hashV1Zero,
            });
            if (r2.failed) c.extra = { ...c.extra, l1RelayFailed: "true" };
            return r2.successful;
          },
          warnings
        );
        findings.push({ ...c, finalized: st.value, unresolved: st.unresolved });
      }
    } else if (fam === "orbit-nitro" || fam === "orbit-classic") {
      const classic = fam === "orbit-classic";
      const start = classic ? from : boundary ? Math.max(from, boundary) : from;
      const end = classic && boundary ? Math.min(head, boundary - 1) : head;
      if (start > end) continue;
      const r = await scanOrbit(l2, cfg, start, end, { classic, chunk });
      coverage.push(r.coverage);

      // Same rule as every other oracle: the classic log scan does not get to report findings
      // until it has been shown to return true for a known-executed message.
      let classicL1Head: number | undefined;
      if (classic && args["resolve-classic"] && (cfg.l1.classicOutboxes ?? []).length) {
        classicL1Head = await l1.getBlockNumber();
        const known = cfg.controls?.executedClassic;
        controls.classicOutbox = known
          ? await assertOrbitClassicDiscriminates(
              l1,
              cfg.l1.classicOutboxes!,
              known,
              cfg.l1.classicOutboxFromBlock ?? 1,
              classicL1Head
            )
          : {
              ok: false,
              positive: "unavailable",
              negative: "pass",
              detail: "no controls.executedClassic configured for this chain",
            };
        if (!controls.classicOutbox.ok)
          warnings.push(
            `${cfg.name}: CLASSIC OUTBOX ORACLE UNPROVEN (${controls.classicOutbox.detail}) — classic statuses forced to unknown`
          );
      }

      for (const c of r.candidates) {
        if (classic) {
          /**
           * Classic is keyed on (batchNumber, indexInBatch) and is NEVER resolved against the Nitro
           * outbox — the index spaces overlap numerically, so a cross-era isSpent() returns
           * plausible garbage in both directions (measured: false negative on the real position,
           * false positives on neighbours). The only sound classic oracle is the L1
           * OutBoxTransactionExecuted log, which costs a wide L1 log scan, so it is opt-in.
           */
          const batch = c.extra?.batchNumber;
          const index = c.extra?.indexInBatch;
          const gated =
            !args["resolve-classic"] || !(cfg.l1.classicOutboxes ?? []).length || !batch || !index
              ? "classic era — pass --resolve-classic to scan L1 OutBoxTransactionExecuted logs"
              : controls.classicOutbox?.ok !== true
                ? `classic outbox control not passed (positive=${controls.classicOutbox?.positive})`
                : undefined;
          if (gated) {
            findings.push({ ...c, finalized: "unknown", unresolved: gated });
            continue;
          }
          let executed: boolean | undefined;
          try {
            executed = await orbitClassicExecuted(
              l1,
              cfg.l1.classicOutboxes!,
              batch!,
              index!,
              cfg.l1.classicOutboxFromBlock ?? 1,
              classicL1Head ?? (await l1.getBlockNumber())
            );
          } catch (e) {
            warnings.push(`${cfg.name}: classic outbox log scan failed: ${String(e).slice(0, 120)}`);
          }
          findings.push({
            ...c,
            finalized: executed ?? "unknown",
            unresolved: executed === undefined ? "L1 outbox log scan hit an unreadable range" : undefined,
          });
          continue;
        }
        const nitro = (cfg.l1.outbox ?? [])[0];
        if (!nitro || controls.outbox?.ok !== true) {
          findings.push({
            ...c,
            finalized: "unknown",
            unresolved: !nitro
              ? "no Nitro outbox configured"
              : `outbox control not passed (positive=${controls.outbox?.positive})`,
          });
          continue;
        }
        const st = await status(
          `${cfg.name}/isSpent`,
          async () => (await orbitNitroSpent(l1, nitro, c.key)).spent,
          warnings
        );
        findings.push({ ...c, finalized: st.value, unresolved: st.unresolved });
      }
      if (classic && r.candidates.length && !args["resolve-classic"])
        warnings.push(
          `${cfg.name}: ${r.candidates.length} pre-Nitro candidate(s) left UNRESOLVED — rerun with --resolve-classic, or resolve by hand via outboxEntryExists + L1 OutBoxTransactionExecuted logs`
        );
    } else if (fam === "polygon-pos") {
      const tokens = String(args.tokens ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length === 42);
      if (!tokens.length) {
        warnings.push(`${cfg.name}: polygon-pos SKIPPED — needs --tokens <csv of child token addresses>`);
        familiesSkipped++;
        continue;
      }
      const checkpointed = cfg.l1.rootChain ? await polygonLastCheckpointedBlock(l1, cfg.l1.rootChain) : undefined;
      const r = await scanPolygonBurns(l2, cfg, tokens, from, head, chunk);
      coverage.push(...r.coverage);
      const proven = controls.polygon?.ok === true;
      for (const c of r.candidates) {
        const txIndex = Number(c.extra?.txIndex);
        const logIdx = c.extra?.receiptLogIndex !== undefined ? Number(c.extra.receiptLogIndex) : undefined;
        // Not a PoS exit unless the tx actually called withdraw/withdrawTo (OFT sends also burn).
        if (c.extra?.isWithdrawCall === "false") continue;
        let finalized: boolean | "unknown" = "unknown";
        let unresolved: string | undefined = !proven
          ? `polygon exit control not passed (positive=${controls.polygon?.positive})`
          : "missing txIndex/receiptLogIndex — exit key not derivable";
        if (proven && cfg.l1.rootChainManager && Number.isFinite(txIndex) && logIdx !== undefined) {
          const h = polygonExitHash(c.l2Block, txIndex, logIdx);
          c.extra = { ...c.extra, exitHash: h };
          const st = await status(
            `${cfg.name}/processedExits`,
            () => polygonExitProcessed(l1, cfg.l1.rootChainManager!, h),
            warnings
          );
          finalized = st.value;
          unresolved = st.unresolved;
        }
        // A burn whose block is not yet checkpointed cannot be exited; do not call it stuck.
        if (finalized === false && checkpointed !== undefined && c.l2Block > checkpointed) {
          c.extra = { ...c.extra, awaitingCheckpoint: "true", lastCheckpointedBlock: String(checkpointed) };
          findings.push({ ...c, finalized: "unknown", unresolved: "burn block not yet checkpointed" });
          continue;
        }
        findings.push({ ...c, finalized, unresolved: finalized === "unknown" ? unresolved : undefined });
      }
    } else {
      /**
       * zk-stack / scroll / linea have verified L1 oracles but no L2 discovery scanner, so there is
       * nothing to feed them. Without this branch those chains ran no scan, produced no findings and
       * no skip, and `complete` stayed true — i.e. exit 0, "scan complete, nothing unclaimed", for a
       * chain whose message layer was never read. That is the precise failure the exit codes exist
       * to prevent, so an unimplemented family must count as skipped.
       */
      warnings.push(
        `${cfg.name}: family '${fam}' has no L2 discovery scanner — NOT scanned. ` +
          `Any zero for this chain is absence of evidence, not evidence of absence.`
      );
      familiesSkipped++;
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

  const complete =
    familiesSkipped === 0 &&
    eras.length > 0 &&
    coverage.every((c) => c.exhaustive) &&
    findings.every((f) => f.finalized !== "unknown");

  return { findings, coverage, controls, warnings, complete };
}

async function main(): Promise<void> {
  if (args["verify-fixtures"]) {
    process.exit((await verifyFixtures()) === 0 ? 0 : 1);
  }

  const l1 = l1Provider();
  const chainIds = args.chains
    ? String(args.chains)
        .split(",")
        .map((s) => Number(s.trim()))
    : CHAINS.map((c) => c.chainId);
  const era = args.era ? String(args.era) : "both";
  const sinceDays = args.since ? Number(args.since) : undefined;

  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), watch: WATCH, chains: {} };
  let stuck = 0;
  let unknown = 0;
  const incomplete: string[] = [];

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
      const unresolved = r.findings.filter((f) => f.finalized === "unknown");
      stuck += unclaimed.length;
      unknown += unresolved.length;
      if (!r.complete) incomplete.push(cfg.name);
      for (const c of r.coverage)
        console.log(
          `  coverage ${c.scanner}: blocks ${c.stats.fromBlock}-${c.stats.toBlock} ok=${c.stats.okChunks} fail=${c.stats.failChunks} events=${c.stats.events}` +
            (c.independent
              ? ` | ${c.independent.name}: ${c.independent.agrees ? "AGREES" : `MISMATCH exp=${c.independent.expected} obs=${c.independent.observed}`}`
              : "") +
            ` | exhaustive=${c.exhaustive}` +
            (c.note ? `\n    note: ${c.note}` : "")
        );
      for (const w of r.warnings) console.log(`  WARN ${w}`);
      for (const f of unclaimed)
        console.log(
          `  STUCK ${f.family} key=${f.key.slice(0, 20)}… tx=${f.l2TxHash} matched=${f.matched.join(",")}${
            f.claimableAt ? ` claimableAt=${f.claimableAt}` : ""
          }${f.claimableBlockedOn ? ` claimable=BLOCKED(${f.claimableBlockedOn})` : ""}${
            f.proofSubmitter ? ` provenBy=${f.proofSubmitter}` : ""
          }`
        );
      // Unknowns are reported as loudly as findings: they are the cases we could not answer.
      for (const f of unresolved)
        console.log(`  UNKNOWN ${f.family} key=${f.key.slice(0, 20)}… tx=${f.l2TxHash} — ${f.unresolved}`);
      (report.chains as Record<string, unknown>)[String(id)] = r;
    } catch (e) {
      console.log(`  ERROR ${String(e).slice(0, 200)}`);
      incomplete.push(cfg.name);
      (report.chains as Record<string, unknown>)[String(id)] = { error: String(e), complete: false };
    }
  }

  report.summary = { unclaimed: stuck, unknown, incompleteChains: incomplete };
  if (args.out) {
    fs.writeFileSync(String(args.out), JSON.stringify(report, null, 2));
    console.log(`\nwrote ${args.out}`);
  }

  console.log(`\ntotal unclaimed candidates: ${stuck}`);
  console.log(`total unresolved (status unknown): ${unknown}`);
  if (incomplete.length) {
    console.log(
      `\nSCAN INCOMPLETE for: ${incomplete.join(", ")}\n` +
        "A zero above does NOT mean nothing is pending on those chains. Exiting 2."
    );
    process.exit(2);
  }
  process.exit(stuck > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
