/* eslint-disable no-console */
// Validates the 2026-07 Solana residual recovery leaves.json against itself and live chain state:
//   1. Rebuild the SVM leaf hash (keccak256 of 64 zero bytes || borsh-serialized leaf) and
//      confirm the single-leaf root matches `relayerRefundRoot`.
//   2. Require deposits and fills to still be paused on the SVM SpokePool (the amount
//      derivation is only sound while no user flow can move the vault).
//   3. Re-derive the payable amount from live state: vault balance − Σ USDC ClaimAccounts
//      (mint membership proven by re-deriving each claim PDA from the refund addresses in
//      leaves.json; fails on any claim account outside that set) − pending TransferLiability,
//      and confirm it equals the leaf's refunds + amountToReturn.
//   4. Print the refund address's USDC ATA (the remaining account for execute_relayer_refund_leaf).
//
// Run from the repo root (SOLANA_RPC_URL optional, defaults to the public mainnet endpoint):
//   tsx scripts/recoveries/2026-07-solana-residual/verify.ts
import { Connection, PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";

const SVM_SPOKE_PROGRAM = new PublicKey("DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru");
const VAULT = new PublicKey("HYhZwefNFmEm9sXYKkNM4QPMgGQnS9VjC6kgxwrGk3Ru");
const SPL_TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SPL_ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
// Anchor account discriminator: sha256("account:ClaimAccount")[0..8].
const CLAIM_ACCOUNT_DISCRIMINATOR = Buffer.from([113, 109, 47, 96, 242, 219, 61, 165]);
// The mainnet SvmSpoke state PDA is derived with seed 0: ["state", u64le(0)].
const STATE_SEED = Buffer.alloc(8, 0);

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(buf: Buffer): string {
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

type LeafEntry = {
  amountToReturn: string;
  chainId: string;
  refundAmounts: string[];
  leafId: number;
  mintPublicKey: string;
  refundAddresses: string[];
  proof: string[];
};

// keccak256(64 zero bytes || borsh(amountToReturn u64, chainId u64, refundAmounts Vec<u64>,
// leafId u32, mintPublicKey [32], refundAddresses Vec<[32]>)) — mirrors the svm-spoke program's
// leaf verification and @across-protocol/contracts' relayerRefundHashFn for SVM leaves.
function hashSvmRefundLeaf(leaf: LeafEntry): string {
  const u64le = (v: string) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    return b;
  };
  const u32le = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const serialized = Buffer.concat([
    u64le(leaf.amountToReturn),
    u64le(leaf.chainId),
    u32le(leaf.refundAmounts.length),
    ...leaf.refundAmounts.map(u64le),
    u32le(leaf.leafId),
    new PublicKey(leaf.mintPublicKey).toBuffer(),
    u32le(leaf.refundAddresses.length),
    ...leaf.refundAddresses.map((a) => new PublicKey(a).toBuffer()),
  ]);
  return ethers.utils.keccak256(Buffer.concat([Buffer.alloc(64, 0), serialized]));
}

async function main(): Promise<void> {
  const artifact = JSON.parse(
    fs.readFileSync(path.join(__dirname, "leaves.json"), "utf-8")
  ) as { relayerRefundRoot: string; leaves: LeafEntry[]; liveStateSnapshot: { claimAccounts: { refundAddress: string }[] } };
  if (artifact.leaves.length !== 1) throw new Error("expected exactly one leaf");
  const leaf = artifact.leaves[0];
  const mint = new PublicKey(leaf.mintPublicKey);

  // 1. Rebuild the root (single leaf => root = leaf hash, proof = []).
  const rebuiltRoot = hashSvmRefundLeaf(leaf);
  const rootsMatch = rebuiltRoot.toLowerCase() === artifact.relayerRefundRoot.toLowerCase();

  // 2 + 3. Live state.
  const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com");
  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state"), STATE_SEED], SVM_SPOKE_PROGRAM);
  const stateInfo = await connection.getAccountInfo(statePda, "finalized");
  if (stateInfo === null) throw new Error(`State account ${statePda.toString()} not found`);
  // State layout: 8-byte discriminator, then paused_deposits: bool, paused_fills: bool.
  const pausedDeposits = stateInfo.data[8] === 1;
  const pausedFills = stateInfo.data[9] === 1;

  const [transferLiabilityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("transfer_liability"), mint.toBuffer()],
    SVM_SPOKE_PROGRAM
  );
  const liabilityInfo = await connection.getAccountInfo(transferLiabilityPda, "finalized");
  // TransferLiability layout: 8-byte discriminator, then pending_to_hub_pool: u64.
  const pendingToHubPool = liabilityInfo === null ? BigInt(0) : liabilityInfo.data.readBigUInt64LE(8);

  // ClaimAccount data stores only (amount, initializer); the mint appears solely in the PDA
  // seeds ["claim_account", mint, refund_address]. Mint membership is proven by re-deriving
  // each PDA from the refund addresses recorded in leaves.json. An unknown ClaimAccount is
  // either a new deferral for this mint (must be netted out) or another mint's claim (not
  // backed by this vault) — indistinguishable on-chain, so verification fails rather than guess.
  const knownClaimPdas = new Set<string>(
    artifact.liveStateSnapshot.claimAccounts.map(
      ({ refundAddress }) =>
        PublicKey.findProgramAddressSync(
          [Buffer.from("claim_account"), mint.toBuffer(), new PublicKey(refundAddress).toBuffer()],
          SVM_SPOKE_PROGRAM
        )[0].toBase58()
    )
  );
  const vaultBalance = BigInt((await connection.getTokenAccountBalance(VAULT, "finalized")).value.amount);
  const claimAccounts = await connection.getProgramAccounts(SVM_SPOKE_PROGRAM, {
    filters: [{ dataSize: 48 }, { memcmp: { offset: 0, bytes: base58Encode(CLAIM_ACCOUNT_DISCRIMINATOR) } }],
  });
  const unknownClaims = claimAccounts.filter(({ pubkey }) => !knownClaimPdas.has(pubkey.toBase58()));
  const usdcClaims = claimAccounts.filter(({ pubkey }) => knownClaimPdas.has(pubkey.toBase58()));
  const claimTotal = usdcClaims.reduce((sum, { account }) => sum + account.data.readBigUInt64LE(8), BigInt(0));
  const payable = vaultBalance - claimTotal - pendingToHubPool;
  const leafTotal = leaf.refundAmounts.reduce((sum, a) => sum + BigInt(a), BigInt(leaf.amountToReturn));

  const amountMatches = payable === leafTotal;
  const pausesActive = pausedDeposits && pausedFills;
  const noUnknownClaims = unknownClaims.length === 0;

  console.table([
    { Check: "relayerRefundRoot (rebuilt)", Value: rebuiltRoot },
    { Check: "relayerRefundRoot (claimed)", Value: artifact.relayerRefundRoot },
    { Check: "deposits paused (live)", Value: pausedDeposits },
    { Check: "fills paused (live)", Value: pausedFills },
    { Check: "pending TransferLiability (live)", Value: pendingToHubPool.toString() },
    { Check: "vault balance (live)", Value: vaultBalance.toString() },
    { Check: `claim accounts total (live, ${usdcClaims.length} USDC accounts)`, Value: claimTotal.toString() },
    { Check: "unknown claim accounts (must be 0)", Value: unknownClaims.length },
    { Check: "payable = vault - claims - pending liability", Value: payable.toString() },
    { Check: "leaf total (refunds + amountToReturn)", Value: leafTotal.toString() },
  ]);

  console.log("Remaining account for execute_relayer_refund_leaf (refund USDC ATA):");
  for (const owner of leaf.refundAddresses) {
    const [ata] = PublicKey.findProgramAddressSync(
      [new PublicKey(owner).toBuffer(), SPL_TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
      SPL_ATA_PROGRAM
    );
    console.log(`  ${owner} -> ${ata.toBase58()}`);
  }

  if (!rootsMatch || !amountMatches || !pausesActive || !noUnknownClaims) {
    console.log("✗ Verification FAILED. Do not relay or execute this leaf without re-deriving the amounts.");
    process.exitCode = 1;
    return;
  }
  console.log("✓ Verified: leaf, root, live pause state, and live payable amount all consistent.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
