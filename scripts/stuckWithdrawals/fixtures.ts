/**
 * Regression fixtures: cases established by hand during the 2026-08 investigation.
 *
 * `npm run scan -- --verify-fixtures` must reproduce every expectation below. If it does not,
 * the tool is wrong — not the fixtures. These exist because a scanner that returns a clean
 * "nothing stuck" is indistinguishable from a broken one unless it can also correctly identify
 * things that ARE stuck and things that are NOT.
 *
 * ON PINNING LIVE STATE: claim status is MONOTONIC — unclaimed can become claimed, never the
 * reverse. So an `expectFinalized: true` fixture is permanent and any regression to false is a real
 * failure, while an `expectFinalized: false` fixture pinned to a live withdrawal is only valid
 * until somebody claims it. Those carry `mutable: true` and a false -> true observation is reported
 * as DRIFT rather than FAIL; see verifyFixtures() in index.ts. Mark a negative `mutable` only when
 * it pins live state — the permanent negatives are what actually guard against a stuck-at-true
 * oracle, so never weaken those.
 */
export interface Fixture {
  label: string;
  chainId: number;
  family: "op-bedrock" | "op-legacy" | "orbit-nitro";
  /** withdrawalHash (bedrock) or outbox position (orbit). Unused when `keys` is set. */
  key?: string;
  /**
   * Legacy fixtures MUST declare v0 and v1 separately. Passing one hash as both (which this
   * harness used to do) means an implementation regressed to checking only v0 still passes, which
   * is precisely the bug the legacy fixture exists to catch.
   */
  keys?: { v0?: string; v1?: string };
  expectFinalized: boolean;
  asOf: string;
  /** Pins live chain state that is allowed to flip false -> true. Only valid on negatives. */
  mutable?: boolean;
  note?: string;
}

export const FIXTURES: Fixture[] = [
  // --- pre-Bedrock legacy SNX: the case a Bedrock-only scan structurally cannot see -------
  {
    label: "SNX 55.000000 (legacy, nonce 137125)",
    chainId: 10,
    family: "op-bedrock", // proven+claimable through the Bedrock portal after migration
    key: "0x5feb61e9ab99747c1b11e9490f3206e08a59838c96c2c813689b0ced78b88a3b",
    expectFinalized: true,
    asOf: "2026-08-18T12:35Z",
    note:
      "CONFIRMED STUCK for 3+ years (verified unfinalized 2026-08-17/18), then claimed by keeper " +
      "0x9a8f92a8 at 2026-08-18 12:03Z. Retained as a fixture because the stuck->claimed transition " +
      "is exactly what the scanner must track; 344.224522 SNX landed at 0x428ab.",
  },
  {
    label: "SNX 72.306130 (legacy, nonce 137155)",
    chainId: 10,
    family: "op-bedrock",
    key: "0x0e0986752bbc27816014bab609ad026c9f93c8e2f36ebf644c3b6153b12ebd42",
    expectFinalized: true,
    asOf: "2026-08-18T12:35Z",
  },
  {
    label: "SNX 72.306130 (legacy, nonce 137156)",
    chainId: 10,
    family: "op-bedrock",
    key: "0x0ed0190bdc2ad7a353b2afe597dc7b59aaa53a4ac42b5c1df509872515057905",
    expectFinalized: true,
    asOf: "2026-08-18T12:35Z",
  },
  {
    label: "SNX 72.306130 (legacy, nonce 137157)",
    chainId: 10,
    family: "op-bedrock",
    key: "0xa6f55bd64225c84da0c300cac9ef2e2d602622393d17945ff6a3e40f1139b21b",
    expectFinalized: true,
    asOf: "2026-08-18T12:35Z",
  },
  {
    label: "SNX 72.306130 (legacy, nonce 137158)",
    chainId: 10,
    family: "op-bedrock",
    key: "0x3441a085a82dfb11f95727b314bc8599e72c114ee85c12fc80823b47df48c0c4",
    expectFinalized: true,
    asOf: "2026-08-18T12:35Z",
  },

  // --- Maker-bridge DAI: the case a standard-bridge scan cannot see. Since claimed. -------
  {
    label: "DAI 14,699.87 via Maker bridge",
    chainId: 10,
    family: "op-bedrock",
    key: "0xbdceab08442853a6c6b5ec49945446a367dcf0705b8b4dc82aa7808b299fd098",
    expectFinalized: true,
    asOf: "2026-08-18T11:52Z",
    note: "claimed by keeper 2026-08-14 21:11Z — proves the oracle returns true, not just false",
  },
  {
    label: "DAI 4,984.94 via Maker bridge",
    chainId: 10,
    family: "op-bedrock",
    key: "0x4543984dbd2e73d9e139b13d2a9b83254342762de2d69a67a8029a1dc3412bad",
    expectFinalized: true,
    asOf: "2026-08-18T11:52Z",
  },
  {
    label: "USDC.e 15,000 (standard bridge)",
    chainId: 10,
    family: "op-bedrock",
    key: "0x899cf9ed6baebde576b965c5e512ddb82e2cfb35e83c4ab88f024623e99ba333",
    expectFinalized: true,
    asOf: "2026-08-18T11:52Z",
  },
  {
    // PERMANENT negative for the portal oracle: a hash no portal has ever seen.
    label: "unknown withdrawal hash (portal negative control)",
    chainId: 10,
    family: "op-bedrock",
    key: "0x" + "ab".repeat(32),
    expectFinalized: false,
    asOf: "2026-08-18T12:35Z",
    note: "permanent — this preimage is not a real withdrawal, so it can never become finalized",
  },

  // --- legacy-oracle regression: guards the v0-vs-v1 successfulMessages bug --------------
  // The v0 and v1 keys of legacy SNX message nonce 137125, relayed 2026-08-18. Both are real and
  // they DISAGREE on-chain: v1 reads true, v0 reads false forever, because the post-Bedrock
  // messenger writes the versioned key while only *reading* the legacy one. Supplying both is what
  // makes this fixture bite — an implementation that checks only v0 reports this claimed
  // withdrawal as stuck, and every legacy withdrawal with it.
  {
    label: "legacy SNX nonce 137125 — relayed, recorded under the V1 key only",
    chainId: 10,
    family: "op-legacy",
    keys: {
      v0: "0xc14724b19f1e506f34573656ccc22516561fcd4d16d89a250d340d2a2db30aca",
      v1: "0xdde3a671b7d7e655befb274151d1f9e393cf356229afc4c361ec9327115eeaa1",
    },
    expectFinalized: true,
    asOf: "2026-08-18T12:35Z",
    note: "v0 alone reads false; a v0-only implementation fails here. src: verified both keys",
  },
  {
    // PERMANENT negative: the v0 key on its own must NOT read as relayed.
    label: "legacy SNX nonce 137125 — V0 key alone (must read false)",
    chainId: 10,
    family: "op-legacy",
    keys: { v0: "0xc14724b19f1e506f34573656ccc22516561fcd4d16d89a250d340d2a2db30aca" },
    expectFinalized: false,
    asOf: "2026-08-18T12:35Z",
    note:
      "permanent — the pre-Bedrock messenger never recorded this key and the post-Bedrock one " +
      "never will. Catches an oracle that returns true unconditionally.",
  },

  /**
   * Legacy ETH regression. Both SNX fixtures above are ERC20, so they pin the value = 0 branch
   * only, and the scanner shipped with 0 hardcoded for every legacy message. That reported five
   * genuinely-claimed pre-Bedrock ETH withdrawals — 1,552.38 ETH, SpokePool -> HubPool, all
   * relayed 2023-06-14 — as stuck, because an ETH message hashes with value = amount.
   *
   * v1 is the correct key (reads true). v1Zero is what the old derivation produced and must stay
   * false, so this one fixture pins both directions of the fix. src: verified — v1 equals the
   * RelayedMessage topic emitted by L1 tx 0x9bc7b3a1…, and the ETH is on L1.
   */
  {
    label: "legacy ETH nonce 139216 (640.83 ETH -> HubPool) — value=amount key is the real one",
    chainId: 10,
    family: "op-legacy",
    keys: { v1: "0x0b00674fc3966044dff9b9461aa3a9846b87151eb6cb0f6974294504df0c5cff" },
    expectFinalized: true,
    asOf: "2026-08-20T12:40Z",
    note: "relayed 2023-06-14 as a migrated withdrawal; permanent, since claiming is irreversible",
  },
  {
    // PERMANENT negative: the value=0 mis-derivation for that same ETH message.
    label: "legacy ETH nonce 139216 — value=0 mis-derivation (must read false)",
    chainId: 10,
    family: "op-legacy",
    keys: { v0: "0x0aedec62946ee398090b717fbe554228dd00d66c6ef6ea605ff746afb1f1aa37" },
    expectFinalized: false,
    asOf: "2026-08-20T12:40Z",
    note:
      "permanent — the messenger has never written this key and never will. This is the exact " +
      "hash that produced the 1,552 ETH false positive; if it ever reads true the derivation moved.",
  },

  // --- Orbit ------------------------------------------------------------------------------
  {
    // PERMANENT negative: an outbox index that cannot plausibly be assigned for decades.
    label: "Arbitrum outbox position 999999999999 (never assigned)",
    chainId: 42161,
    family: "orbit-nitro",
    key: "999999999999",
    expectFinalized: false,
    asOf: "2026-08-18T11:52Z",
    note: "permanent negative — guards against a stuck-at-true isSpent()",
  },
  {
    label: "Arbitrum WBTC 4.6256 -> HubPool (outbox position 164622)",
    chainId: 42161,
    family: "orbit-nitro",
    key: "164622",
    expectFinalized: false,
    asOf: "2026-08-18T11:52Z",
    mutable: true,
    note:
      "LIVE state: unclaimed only because it was still inside its 7-day window when recorded. " +
      "Once somebody claims it this reads true, which is DRIFT, not a failure — the permanent " +
      "negative above is what actually holds the negative side of this oracle.",
  },
];

/**
 * Oracle fixtures for the non-OP families. Each pins a value that was verified on-chain, and each
 * pair deliberately includes a true AND a false case so a stuck-at-one-value oracle cannot pass.
 */
export type OracleFixture = { label: string; expect: boolean; mutable?: boolean; note?: string } & (
  | { kind: "polygon"; block: number; txIndex: number; logIndex: number }
  | { kind: "linea"; messageNumber: number }
  | { kind: "zksync"; chainId: number; batch: number; index: number }
  | { kind: "orbit-classic"; batchNumber: number }
);

export const ORACLE_FIXTURES: OracleFixture[] = [
  // Polygon: proves the exit key is derivable offline from (block, txIndex, receiptLogIndex).
  {
    kind: "polygon",
    label: "processed exit (block 92225980, tx 0, log 0)",
    block: 92225980,
    txIndex: 0,
    logIndex: 0,
    expect: true,
  },
  { kind: "polygon", label: "bogus exit (block 1, tx 0, log 0)", block: 1, txIndex: 0, logIndex: 0, expect: false },

  // Linea: guards against reverting to inboxL2L1MessageStatus, which returns 0 for everything.
  { kind: "linea", label: "message 108140 claimed", messageNumber: 108140, expect: true },
  { kind: "linea", label: "message 108139 claimed", messageNumber: 108139, expect: true },
  {
    kind: "linea",
    label: "message 108141 unclaimed",
    messageNumber: 108141,
    expect: false,
    // Pinned to live state, so a later claim is legal drift rather than a broken oracle. It was in
    // fact claimed between 2026-08-17 and 2026-08-20, which failed the suite for the wrong reason.
    mutable: true,
  },
  {
    // PERMANENT negative: a message number the bitmap cannot reach for years.
    kind: "linea",
    label: "message 99999999 (never assigned)",
    messageNumber: 99_999_999,
    expect: false,
    note: "permanent — holds the negative side of isMessageClaimed once 108141 drifts to claimed",
  },

  // zkSync: chainId is part of the key, so a wrong chainId must read false.
  { kind: "zksync", label: "(324, 514000, 5) finalized", chainId: 324, batch: 514000, index: 5, expect: true },
  { kind: "zksync", label: "(324, 514000, 4) not finalized", chainId: 324, batch: 514000, index: 4, expect: false },
  { kind: "zksync", label: "(300, 514000, 5) wrong chain", chainId: 300, batch: 514000, index: 5, expect: false },
];

/**
 * Offline hash-DERIVATION fixtures.
 *
 * The claim-key fixtures above prove the L1 oracles discriminate. These prove the other half: that
 * we compute the keys we hand them correctly. Without this, a regression in
 * legacyXDomainCalldataHash()/legacyVersionedHash() produces a hash no messenger has ever heard of,
 * which reads as "not relayed" — a mass false positive that every oracle-side fixture still passes.
 *
 * Inputs are the exact relayMessage arguments the keeper submitted in L1 tx
 * 0x0a2992eecf4af772f93bbe44b64beedf9a968fb50d1b456bd479c7ad1f6dfa1a
 * (finalizeWithdrawalTransactionExternalProof, OP portal, 2026-08-18), decoded from its calldata.
 * The expectations are keccak256 of that calldata, so they are checkable with no RPC at all.
 */
export interface DerivationFixture {
  label: string;
  messageNonce: string;
  sender: string;
  target: string;
  message: string;
  expectV0: string;
  expectV1: string;
}

export const DERIVATION_FIXTURES: DerivationFixture[] = [
  {
    label: "legacy SNX 55.0 (message nonce 137125)",
    messageNonce: "137125",
    sender: "0x4200000000000000000000000000000000000010", // L2StandardBridge
    target: "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1", // L1StandardBridge
    message:
      "0xa9f9e675000000000000000000000000c011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f0000000000000000000000008700daec35af8ff88c16bdf0418774cb3d7599b4000000000000000000000000428ab2ba90eba0a4be7af34c9ac451ab061ac010000000000000000000000000428ab2ba90eba0a4be7af34c9ac451ab061ac010000000000000000000000000000000000000000000000002fb474098f67c008c00000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000",
    // successfulMessages[expectV1] == true, successfulMessages[expectV0] == false. src: verified
    expectV0: "0xc14724b19f1e506f34573656ccc22516561fcd4d16d89a250d340d2a2db30aca",
    expectV1: "0xdde3a671b7d7e655befb274151d1f9e393cf356229afc4c361ec9327115eeaa1",
  },
];
