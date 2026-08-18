/**
 * Historical SpokePool registry.
 *
 * Across has THREE generations of SpokePool on the original four chains, not two. The gen-1 set
 * (from the original deployment artifacts) is the one usually missed, and it demonstrably emitted
 * TokensBridged on-chain — so it carries real withdrawals.
 *
 * TWO TRAPS, both load-bearing:
 *
 * 1. Do NOT source addresses from `deployments/<net>/*_SpokePool.json` in across-protocol/contracts.
 *    Since 2024-02 those artifacts record the IMPLEMENTATION address, and an implementation never
 *    emits logs under its own address (delegatecall attributes logs to the proxy). Scanning them
 *    yields a confident zero. Real emitters live in `deployments/legacy-addresses.json`.
 *
 * 2. One address can emit TWO different topic0s. Every chain live before 2025-02-06 emitted
 *    `TokensBridged(...,address,...)` before its v3.5 upgrade and `TokensBridged(...,bytes32,...)`
 *    after. So filter each address on BOTH topic0s rather than partitioning by address/era.
 *
 * Deploy blocks for gen-1/gen-2 are approximate: hardhat-deploy carried stale receipts forward in
 * places. They are plausible lower bounds only — when in doubt scan from 0.
 */
export interface SpokeDeployment {
  address: string;
  fromBlock?: number;
  label: string;
  /** false => address unverified on-chain (dead RPC); treat a zero result as unproven. */
  verified?: boolean;
}

export const SPOKE_POOLS: Record<number, SpokeDeployment[]> = {
  1: [
    { address: "0x931A43528779034ac9eb77df799d133557406176", fromBlock: 14_704_425, label: "V2 gen1 (deprecated)", verified: true },
    { address: "0x4D9079Bb4165aeb4084c526a32695dCfd2F77381", fromBlock: 14_819_486, label: "V2 gen2 (deprecated)", verified: true },
    { address: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5", fromBlock: 17_117_454, label: "V2.5/V3+ proxy (current)", verified: true },
  ],
  10: [
    { address: "0x59485d57EEcc4058F7831f46eE83a7078276b4AE", fromBlock: 6_979_967, label: "V2 gen1 (deprecated)", verified: true },
    { address: "0xa420b2d1c0841415A695b81E5B867BCD07DFf8C9", fromBlock: 8_747_136, label: "V2 gen2 (deprecated)", verified: true },
    { address: "0x6f26Bf09B1C792e3228e5467807a900A503c0281", fromBlock: 93_903_076, label: "V2.5/V3+ proxy (current)", verified: true },
  ],
  137: [
    { address: "0xD3ddAcAe5aFb00F9B9cD36EF0Ed7115d7f0b584c", fromBlock: 27_875_891, label: "V2 gen1 (deprecated)", verified: true },
    { address: "0x69B5c72837769eF1e7C164Abc6515DcFf217F920", fromBlock: 28_604_263, label: "V2 gen2 (deprecated)", verified: true },
    { address: "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096", fromBlock: 41_908_657, label: "V2.5/V3+ proxy (current)", verified: true },
  ],
  42161: [
    { address: "0xe1C367e2b576Ac421a9f46C9cC624935730c36aa", fromBlock: 11_102_271, label: "V2 gen1 (deprecated)", verified: true },
    { address: "0xB88690461dDbaB6f04Dfad7df66B7725942FEb9C", fromBlock: 12_741_972, label: "V2 gen2 (deprecated)", verified: true },
    { address: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A", fromBlock: 83_868_041, label: "V2.5/V3+ proxy (current)", verified: true },
  ],
  288: [{ address: "0xBbc6009fEfFc27ce705322832Cb2068F8C1e0A58", fromBlock: 619_993, label: "Boba V2 (deprecated chain)", verified: true }],
  324: [{ address: "0xE0B015E54d54fc84a6cB9B666099c46adE9335FF", fromBlock: 10_352_565, label: "proxy (only)", verified: true }],
  480: [{ address: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", fromBlock: 4_524_742, label: "proxy (only)", verified: true }],
  690: [{ address: "0x13fDac9F9b4777705db45291bbFF3c972c6d1d97", fromBlock: 5_512_122, label: "proxy (chain sunset)", verified: false }],
  1135: [{ address: "0x9552a0a6624A23B848060AE5901659CDDa1f83f8", fromBlock: 2_602_337, label: "proxy (only)", verified: true }],
  1868: [{ address: "0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96", fromBlock: 1_709_997, label: "Cher/Soneium proxy (only)", verified: true }],
  4663: [{ address: "0xD29C85F15DF544bA632C9E25829fd29d767d7978", label: "proxy (only)", verified: true }],
  8453: [{ address: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", fromBlock: 2_164_878, label: "proxy (only)", verified: true }],
  34443: [{ address: "0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96", fromBlock: 8_043_187, label: "proxy (only)", verified: true }],
  41455: [{ address: "0x13fDac9F9b4777705db45291bbFF3c972c6d1d97", fromBlock: 4_240_318, label: "proxy (chain sunset)", verified: false }],
  57073: [{ address: "0xeF684C38F94F48775959ECf2012D7E864ffb9dd4", fromBlock: 1_139_240, label: "proxy (only)", verified: true }],
  59144: [{ address: "0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75", fromBlock: 2_721_169, label: "proxy (only)", verified: true }],
  130: [{ address: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", fromBlock: 7_915_488, label: "DoctorWho/Unichain proxy (only)", verified: true }],
  534352: [{ address: "0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96", fromBlock: 7_489_705, label: "proxy (only)", verified: true }],
  7777777: [{ address: "0x13fDac9F9b4777705db45291bbFF3c972c6d1d97", fromBlock: 18_382_867, label: "proxy (only)", verified: true }],
  81457: [{ address: "0x2D509190Ed0172ba588407D4c2df918F955Cc6E1", fromBlock: 5_574_280, label: "proxy (only)", verified: true }],
};

/**
 * Every TokensBridged shape that has existed in the contracts repo.
 *
 * Only `deployed: true` variants are scanned by default. The rest are recorded so nobody re-derives
 * them and chases a topic0 that can never appear on-chain — notably `0x61ddedf1…`, a three-day dev
 * shape from Feb 2022, two months before the first mainnet SpokePool.
 */
export interface TokensBridgedVariant {
  signature: string;
  topic0: string;
  indexed: boolean[];
  era: string;
  deployed: boolean;
}

export const TOKENS_BRIDGED: TokensBridgedVariant[] = [
  {
    signature: "TokensBridged(uint256,uint256,uint32,address,address)",
    topic0: "0x828fc203220356df8f072a91681caee7d5c75095e2a95e80ed5a14b384697f71",
    indexed: [false, true, true, true, false],
    era: "V2 -> V3.0. On-chain Apr/May-2022 until each chain's v3.5 upgrade (from 2025-02-06).",
    deployed: true,
  },
  {
    signature: "TokensBridged(uint256,uint256,uint32,bytes32,address)",
    topic0: "0xfa7fa7cf6d7dde5f9be65a67e6a1a747e7aa864dcd2d793353c722d80fbbb357",
    indexed: [false, true, true, true, false],
    era: "v3.5 Solana-ready upgrade (2025-02-06 onward). Current.",
    deployed: true,
  },
  {
    signature: "TokensBridged(uint256,uint256,uint256,address,address)",
    topic0: "0x61ddedf1d46986a83ad7b9567c366290dca9c53b863df48a51a79cef0f39b218",
    indexed: [true, true, false, true, false],
    era: "NEVER DEPLOYED — dev shape 2022-02-09..11, predates first mainnet SpokePool.",
    deployed: false,
  },
  {
    signature: "TokensBridged(uint256,uint32,uint32,address,address)",
    topic0: "0x4a8ed0d960a178974bbddce58484bc578667cea68159c4d61f0d17fb7a81b2e2",
    indexed: [false, true, true, true, false],
    era: "NEVER DEPLOYED — dev shape 2022-02-15..16 (leafId/chainId order swapped).",
    deployed: false,
  },
  {
    signature: "TokensBridged(uint256,uint256,uint32,address)",
    topic0: "0x7c3d4d7fa0beeb997103f1aeca4922365ea469a3e7e88db965a128bbe6a2f632",
    indexed: [false, true, true, true],
    era: "NEVER DEPLOYED — `caller` dropped on a feature branch, absent from all artifacts.",
    deployed: false,
  },
];

export const deployedTokensBridged = (): TokensBridgedVariant[] => TOKENS_BRIDGED.filter((v) => v.deployed);
