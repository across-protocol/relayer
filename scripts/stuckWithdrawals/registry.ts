/**
 * Registry: chains, contracts, event shapes, watch-list.
 *
 * This is the layer you edit. The engine in core.ts is generic; everything
 * chain-specific or historical lives here.
 *
 * `src` on each address records provenance:
 *   "verified"  - read or derived on-chain during the 2026-08 investigation
 *   "derived"   - obtained at runtime via derivePortal() / derived on demand
 *   "docs"      - taken from documentation or package source, NOT independently checked
 * Anything marked "docs" should be treated as suspect until a control passes (see oracles.ts).
 */
import { ethers } from "ethers";
import { SPOKE_POOLS, deployedTokensBridged } from "./spokePools";

export type Family =
  | "op-bedrock"
  | "op-legacy"
  | "orbit-nitro"
  | "orbit-classic"
  | "polygon-pos"
  | "zk-stack"
  | "scroll"
  | "linea";

export interface SpokeDeployment {
  address: string;
  fromBlock?: number;
  label: string;
}

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcEnv: string[];
  families: Family[];
  /** First block of the post-upgrade era. Blocks below this need the *-legacy/classic scanner. */
  eraBoundaryBlock?: number;
  l1: {
    portal?: string;
    l1XDM?: string;
    l1StandardBridge?: string;
    outbox?: string[];
    rootChainManager?: string;
    l1Nullifier?: string;
    l1Messenger?: string;
  };
  spokePools: SpokeDeployment[];
  /** Informational: token-specific bridges that a token-level scan would miss. */
  customBridges?: Array<{ address: string; note: string }>;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Watch-list. Add addresses here; the engine matches these against raw payloads.
// ---------------------------------------------------------------------------
export const WATCH: Record<string, string> = {
  "0x07aE8551Be970cB1cCa11Dd7a11F47Ae82e70E67": "primary-relayer",
  "0x428AB2BA90Eba0a4Be7aF34C9Ac451ab061AC010": "secondary-relayer",
  "0xf7bAc63fc7CEaCf0589F25454Ecf5C2ce904997c": "dataworker/finalizer-signer",
  "0xc186fA914353c44b2E33eBE05f21846F1048bEda": "hub-pool",
};

/** Third parties observed proving/finalizing our withdrawals. Needed for external-proof finalization. */
export const KNOWN_PROVERS: Record<string, string> = {
  "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D": "keeper (proved+finalized our DAI and SNX)",
};

// ---------------------------------------------------------------------------
// Event shapes.
// ---------------------------------------------------------------------------
const topic0 = (sig: string): string => ethers.utils.id(sig);

/**
 * TokensBridged has changed shape. `l2TokenAddress` widened from address to bytes32 when
 * non-EVM (Solana) support landed, which changes topic0. A scanner that knows only the
 * current shape silently misses every older SpokePool return.
 *
 * Changing which parameters are `indexed` does NOT change topic0; changing a type does.
 */
export const TOKENS_BRIDGED_VARIANTS = deployedTokensBridged();

export const EVENTS = {
  /** Bedrock-era OP-Stack. Emitted by every post-Bedrock withdrawal regardless of bridge. */
  messagePassed: {
    address: "0x4200000000000000000000000000000000000016",
    signature:
      "MessagePassed(uint256,address,address,uint256,uint256,bytes,bytes32)",
    topic0: topic0("MessagePassed(uint256,address,address,uint256,uint256,bytes,bytes32)"),
    /**
     * withdrawalHash lives at hex chars [192,256) of `data`.
     * NOT the last 32 bytes: `bytes data` is dynamic and its contents trail after the hash.
     * Getting this wrong yields a hash the portal has never heard of, which reads as
     * "not finalized" — a false positive that looks exactly like a real finding.
     */
    withdrawalHashSlice: [192, 256] as const,
  },
  /** Pre-Bedrock OP-Stack. Legacy messages never emit MessagePassed at any block depth. */
  sentMessageLegacy: {
    address: "0x4200000000000000000000000000000000000007",
    signature: "SentMessage(address,address,bytes,uint256,uint256)",
    topic0: topic0("SentMessage(address,address,bytes,uint256,uint256)"),
  },
  /** Nitro-era Orbit. `position` is topic3 and is monotonic — usable as a coverage oracle. */
  l2ToL1Tx: {
    address: "0x0000000000000000000000000000000000000064",
    signature:
      "L2ToL1Tx(address,address,uint256,uint256,uint256,uint256,uint256,uint256,bytes)",
    topic0: "0x3e7aafa77dbf186b7fd488006beff893744caa3c4f6f299e8a709fa2087374fc",
  },
  /** Classic (pre-Nitro) Arbitrum. Different shape; invisible to an L2ToL1Tx-only scan. */
  l2ToL1TransactionClassic: {
    address: "0x0000000000000000000000000000000000000064",
    signature:
      "L2ToL1Transaction(address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes)",
    topic0: topic0(
      "L2ToL1Transaction(address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes)"
    ),
  },
  erc20Transfer: {
    signature: "Transfer(address,address,uint256)",
    topic0: topic0("Transfer(address,address,uint256)"),
  },
  zkL1MessageSent: {
    address: "0x0000000000000000000000000000000000008008",
    signature: "L1MessageSent(address,bytes32,bytes)",
    topic0: topic0("L1MessageSent(address,bytes32,bytes)"),
  },
};

export const SELECTORS = {
  finalizedWithdrawals: ethers.utils.id("finalizedWithdrawals(bytes32)").slice(0, 10),
  provenWithdrawals: ethers.utils.id("provenWithdrawals(bytes32,address)").slice(0, 10),
  proofSubmitters: ethers.utils.id("proofSubmitters(bytes32,uint256)").slice(0, 10),
  isSpent: ethers.utils.id("isSpent(uint256)").slice(0, 10),
  successfulMessages: ethers.utils.id("successfulMessages(bytes32)").slice(0, 10),
  failedMessages: ethers.utils.id("failedMessages(bytes32)").slice(0, 10),
  processedExits: ethers.utils.id("processedExits(bytes32)").slice(0, 10),
  messageNonce: ethers.utils.id("messageNonce()").slice(0, 10),
  otherBridge: ethers.utils.id("otherBridge()").slice(0, 10),
  messenger: ethers.utils.id("messenger()").slice(0, 10),
  portal: ethers.utils.id("portal()").slice(0, 10),
  version: ethers.utils.id("version()").slice(0, 10),
  finalizeExternalProof: ethers.utils
    .id("finalizeWithdrawalTransactionExternalProof((uint256,address,address,uint256,uint256,bytes),address)")
    .slice(0, 10),
};

// ---------------------------------------------------------------------------
// Chains.
// ---------------------------------------------------------------------------
export const CHAINS: ChainConfig[] = [
  {
    chainId: 10,
    name: "Optimism",
    rpcEnv: ["NODE_URL_10", "OPTIMISM_RPC_URL"],
    families: ["op-bedrock", "op-legacy"],
    // Bedrock upgrade. Blocks below this are legacy-era and need the op-legacy scanner.
    eraBoundaryBlock: 105_235_063, // src: docs — verified at runtime by assertEraBoundary()
    l1: {
      portal: "0xbEb5Fc579115071764c7423A4f12eDde41f106Ed", // src: verified (v5.6.1)
      l1XDM: "0x25aCE71c97B33Cc4729CF772ae268934F7aB5fA1", // src: verified (target of legacy SNX withdrawals)
      l1StandardBridge: "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1", // src: verified (SNX finalizeERC20Withdrawal target)
    },
    spokePools: [{ address: "0x6f26Bf09B1C792e3228e5467807a900A503c0281", label: "current" }],
    customBridges: [
      { address: "0x467194771dAe2967Aef3ECbEDD3Bf9a310C76C65", note: "Maker DAI bridge — invisible to standard-bridge scans" },
    ],
    notes: "Only OP chain with a substantial pre-Bedrock history. 5 legacy SNX withdrawals found here.",
  },
  {
    chainId: 8453,
    name: "Base",
    rpcEnv: ["NODE_URL_8453", "BASE_RPC_URL"],
    families: ["op-bedrock"],
    l1: { portal: "0x49048044D57e1C92A77f79988d21Fa8fAF74E97e" }, // src: docs
    spokePools: [{ address: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", label: "current" }],
  },
  {
    chainId: 34443,
    name: "Mode",
    rpcEnv: ["NODE_URL_34443"],
    families: ["op-bedrock"],
    l1: {
      portal: "0x8b34b14c7c7123459Cf3076b8Cb929BE097d0C07", // src: verified (derived + controls)
      l1XDM: "0x95bDCA6c8EdEB69c98Bd5bd17660BaCef1298A6f",
      l1StandardBridge: "0x735aDBbE72226BD52e818E7181953f42E3b0FF21",
    },
    spokePools: [{ address: "0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96", label: "current" }],
  },
  {
    chainId: 1135,
    name: "Lisk",
    rpcEnv: ["NODE_URL_1135", "LISK_RPC_URL"],
    families: ["op-bedrock"],
    l1: {
      portal: "0x26dB93F8b8b4f7016240af62F7730979d353f9A7", // src: verified (positive control passed)
      l1XDM: "0x31B72D76FB666844C41EdF08dF0254875Dbb7edB",
      l1StandardBridge: "0x2658723Bf70c7667De6B25F99fcce13A16D25d08",
    },
    spokePools: [{ address: "0x9552a0a6624A23B848060AE5901659CDDa1f83f8", label: "current" }],
    customBridges: [
      { address: "0x3b1aC69368Eb6447F5db2D4e1641380Fa9E40d29", note: "bridged-USDC custom bridge — burns, no standard-bridge event" },
    ],
  },
  {
    chainId: 7777777,
    name: "Zora",
    rpcEnv: ["NODE_URL_7777777"],
    families: ["op-bedrock"],
    l1: {
      portal: "0x1a0ad011913A150f69f6A19DF447A0CfD9551054", // src: verified (+/- controls)
      l1XDM: "0xdC40a14d9abd6F410226f1E6de71aE03441ca506",
      l1StandardBridge: "0x3e2Ea9B92B7E48A52296fD261dc26fd995284631",
    },
    spokePools: [{ address: "0x13fDac9F9b4777705db45291bbFF3c972c6d1d97", label: "current" }],
    notes: "Public RPC rejects requests without a browser User-Agent.",
  },
  {
    chainId: 480,
    name: "World Chain",
    rpcEnv: ["NODE_URL_480", "WORLDCHAIN_RPC_URL"],
    families: ["op-bedrock"],
    l1: {
      portal: "0xd5ec14a83B7d95BE1E2Ac12523e2dEE12Cbeea6C", // src: verified (+/- controls)
      l1XDM: "0xf931a81D18B1766d15695ffc7c1920a62b7E710a",
      l1StandardBridge: "0x470458C91978D2d929704489Ad730DC3E3001113",
    },
    spokePools: [{ address: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", label: "current" }],
  },
  {
    chainId: 81457,
    name: "Blast",
    rpcEnv: ["NODE_URL_81457", "BLAST_RPC_URL"],
    families: ["op-bedrock"],
    l1: {
      portal: "0x0Ec68c5B10F21EFFb74f2A5C61DFe6b08C0Db6Cb", // src: verified
      l1XDM: "0x5D4472f31bD9385709ec61305AFc749F0fA8e9d0",
      l1StandardBridge: "0x697402166Fbf2F22E970df8a6486Ef171dbfc524",
    },
    spokePools: [{ address: "0x2D509190Ed0172ba588407D4c2df918F955Cc6E1", label: "current" }],
    notes:
      "Portal does NOT emit standard WithdrawalFinalized topics, so the usual positive control is unavailable; oracles.ts falls back to sampling old withdrawals.",
  },
  {
    chainId: 57073,
    name: "Ink",
    rpcEnv: ["NODE_URL_57073", "INK_RPC_URL"],
    families: ["op-bedrock"],
    l1: { portal: "0x5d66C1782664115999C47c9fA5cd031f495D3e4F" }, // src: derived on-chain
    spokePools: [{ address: "0xeF684C38F94F48775959ECf2012D7E864ffb9dd4", label: "current" }],
  },
  {
    chainId: 130,
    name: "Unichain",
    rpcEnv: ["NODE_URL_130"],
    families: ["op-bedrock"],
    l1: { portal: "0x0bd48f6B86a26D3a217d0Fa6FfE2B491B956A7a2" }, // src: derived on-chain
    spokePools: [{ address: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64", label: "current" }],
  },
  {
    chainId: 1868,
    name: "Soneium",
    rpcEnv: ["NODE_URL_1868"],
    families: ["op-bedrock"],
    l1: {},
    spokePools: [{ address: "0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96", label: "current" }],
  },
  {
    chainId: 690,
    name: "Redstone",
    rpcEnv: ["NODE_URL_690", "REDSTONE_RPC_URL"],
    families: ["op-bedrock"],
    l1: {},
    spokePools: [],
  },
  {
    chainId: 42161,
    name: "Arbitrum",
    rpcEnv: ["NODE_URL_42161", "ARBITRUM_RPC_URL"],
    families: ["orbit-nitro", "orbit-classic"],
    eraBoundaryBlock: 22_207_817, // Nitro migration. src: docs — verify before trusting
    l1: {
      outbox: [
        "0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840", // Nitro. src: verified (isSpent discriminates)
        "0x760723CD2e632826c38Fef8CD438A4CC7E7E1A40", // classic Outbox2. src: docs
        "0x667e23ABd27E623c11d4CC00ca3EC4d0bD63337a", // classic Outbox. src: docs
      ],
    },
    spokePools: [{ address: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A", label: "current" }],
  },
  {
    chainId: 41455,
    name: "Aleph Zero",
    rpcEnv: ["NODE_URL_41455", "ALEPHZERO_RPC_URL"],
    families: ["orbit-nitro"],
    l1: { outbox: [] },
    spokePools: [],
  },
  {
    chainId: 4663,
    name: "Robinhood",
    rpcEnv: ["NODE_URL_4663"],
    families: ["orbit-nitro"],
    l1: { outbox: [] },
    spokePools: [{ address: "0xD29C85F15DF544bA632C9E25829fd29d767d7978", label: "current" }],
    notes: "Zero withdrawals as of 2026-08: ArbSys positions 0..1161 contiguous, no TokensBridged.",
  },
  {
    chainId: 137,
    name: "Polygon",
    rpcEnv: ["NODE_URL_137", "POLYGON_RPC_URL"],
    families: ["polygon-pos"],
    l1: { rootChainManager: "0xA0c68C638235ee32657e8f720a23ceC1bFc77C77" }, // src: docs
    spokePools: [{ address: "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096", label: "current" }],
    notes:
      "PoS exits are not OP-style. Withdrawals burn the child token; the L1 exit needs a checkpoint + Merkle proof, so 'unclaimed' is ambiguous for recent burns. See oracles.ts:polygonExitStatus.",
  },
  {
    chainId: 324,
    name: "zkSync",
    rpcEnv: ["NODE_URL_324", "ZKSYNC_RPC_URL"],
    families: ["zk-stack"],
    l1: {},
    spokePools: [{ address: "0xE0B015E54d54fc84a6cB9B666099c46adE9335FF", label: "current" }],
  },
  {
    chainId: 534352,
    name: "Scroll",
    rpcEnv: ["NODE_URL_534352", "SCROLL_RPC_URL"],
    families: ["scroll"],
    l1: { l1Messenger: "0x6774Bcbd5ceCeF1336b5300fb5186a12DDD8b367" }, // src: docs
    spokePools: [],
  },
  {
    chainId: 59144,
    name: "Linea",
    rpcEnv: ["NODE_URL_59144", "LINEA_RPC_URL"],
    families: ["linea"],
    l1: { l1Messenger: "0xd19d4B5d358258f05D7B411E21A1460D11B0876F" }, // src: docs
    spokePools: [{ address: "0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75", label: "current" }],
  },
];

/**
 * Overlay the historical SpokePool registry. Doing this centrally means a chain added to
 * spokePools.ts is picked up without touching CHAINS, and guarantees the scanner never sees only
 * the current-generation address.
 */
for (const c of CHAINS) {
  const historical = SPOKE_POOLS[c.chainId];
  if (historical?.length) c.spokePools = historical;
}

export const chainById = (id: number): ChainConfig => {
  const c = CHAINS.find((c) => c.chainId === id);
  if (!c) throw new Error(`unknown chainId ${id}`);
  return c;
};

/**
 * Derive an OP-Stack chain's L1 OptimismPortal entirely on-chain:
 *   L2StandardBridge.otherBridge() -> L1StandardBridge.messenger() -> L1XDM.portal()
 * Prefer this over a hardcoded address for any chain whose portal is marked "docs".
 */
export async function derivePortal(
  l2: ethers.providers.JsonRpcProvider,
  l1: ethers.providers.JsonRpcProvider
): Promise<{ l1StandardBridge?: string; l1XDM?: string; portal?: string }> {
  const addr = (ret?: string) =>
    ret && ret.length >= 42 ? ethers.utils.getAddress("0x" + ret.slice(-40)) : undefined;
  const call = async (p: ethers.providers.JsonRpcProvider, to: string, data: string) => {
    try {
      return await p.send("eth_call", [{ to, data }, "latest"]);
    } catch {
      return undefined;
    }
  };
  const l1Bridge = addr(await call(l2, "0x4200000000000000000000000000000000000010", SELECTORS.otherBridge));
  if (!l1Bridge) return {};
  const l1XDM = addr(await call(l1, l1Bridge, SELECTORS.messenger));
  if (!l1XDM) return { l1StandardBridge: l1Bridge };
  const portal = addr(await call(l1, l1XDM, SELECTORS.portal));
  return { l1StandardBridge: l1Bridge, l1XDM, portal };
}
