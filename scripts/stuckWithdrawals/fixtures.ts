/**
 * Regression fixtures: cases established by hand during the 2026-08 investigation.
 *
 * `npm run scan -- --verify-fixtures` must reproduce every expectation below. If it does not,
 * the tool is wrong — not the fixtures. These exist because a scanner that returns a clean
 * "nothing stuck" is indistinguishable from a broken one unless it can also correctly identify
 * things that ARE stuck and things that are NOT.
 */
export interface Fixture {
  label: string;
  chainId: number;
  family: "op-bedrock" | "op-legacy" | "orbit-nitro";
  /** withdrawalHash (bedrock), xDomainCalldata hash (legacy) or outbox position (orbit). */
  key: string;
  expectFinalized: boolean;
  asOf: string;
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

  // --- legacy-oracle regression: guards the v0-vs-v1 successfulMessages bug --------------
  // This is the V1 versioned hash of legacy SNX message nonce 137125, relayed 2026-08-18.
  // If someone "simplifies" legacyRelayed() back to checking only the v0 xDomainCalldata hash,
  // this fixture fails — which is the entire point of it. v0 for this message reads false forever.
  {
    label: "legacy SNX nonce 137125 (V1 versioned hash) — relayed",
    chainId: 10,
    family: "op-legacy",
    key: "0xdde3a671b7d7e655befb274151d1f9e393cf356229afc4c361ec9327115eeaa1",
    expectFinalized: true,
    asOf: "2026-08-18T12:35Z",
    note: "v0 hash 0xc14724b1… reads false; only the v1 key records the relay",
  },

  // --- Orbit: HubPool-destined WBTC return, inside its 7-day window ----------------------
  {
    label: "Arbitrum WBTC 4.6256 -> HubPool (outbox position)",
    chainId: 42161,
    family: "orbit-nitro",
    key: "164622",
    expectFinalized: false,
    asOf: "2026-08-18T11:52Z",
    note: "still inside the 7-day window at time of recording",
  },
];

/**
 * Oracle fixtures for the non-OP families. Each pins a value that was verified on-chain, and each
 * pair deliberately includes a true AND a false case so a stuck-at-one-value oracle cannot pass.
 */
export type OracleFixture =
  | { kind: "polygon"; label: string; block: number; txIndex: number; logIndex: number; expect: boolean }
  | { kind: "linea"; label: string; messageNumber: number; expect: boolean }
  | { kind: "zksync"; label: string; chainId: number; batch: number; index: number; expect: boolean }
  | { kind: "orbit-classic"; label: string; batchNumber: number; expect: boolean };

export const ORACLE_FIXTURES: OracleFixture[] = [
  // Polygon: proves the exit key is derivable offline from (block, txIndex, receiptLogIndex).
  { kind: "polygon", label: "processed exit (block 92225980, tx 0, log 0)", block: 92225980, txIndex: 0, logIndex: 0, expect: true },
  { kind: "polygon", label: "bogus exit (block 1, tx 0, log 0)", block: 1, txIndex: 0, logIndex: 0, expect: false },

  // Linea: guards against reverting to inboxL2L1MessageStatus, which returns 0 for everything.
  { kind: "linea", label: "message 108140 claimed", messageNumber: 108140, expect: true },
  { kind: "linea", label: "message 108139 claimed", messageNumber: 108139, expect: true },
  { kind: "linea", label: "message 108141 unclaimed", messageNumber: 108141, expect: false },

  // zkSync: chainId is part of the key, so a wrong chainId must read false.
  { kind: "zksync", label: "(324, 514000, 5) finalized", chainId: 324, batch: 514000, index: 5, expect: true },
  { kind: "zksync", label: "(324, 514000, 4) not finalized", chainId: 324, batch: 514000, index: 4, expect: false },
  { kind: "zksync", label: "(300, 514000, 5) wrong chain", chainId: 300, batch: 514000, index: 5, expect: false },
];
