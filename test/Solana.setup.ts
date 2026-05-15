import { airdropFactory, createKeyPairSignerFromBytes, lamports } from "@solana/kit";
import fs from "fs/promises";
import path from "node:path";
import { createDefaultSolanaClient, generateKeyPairSignerWithSol, initializeSvmSpoke } from "./utils/svm/utils";
import { validatorSetup, validatorTeardown } from "./utils/svm/validator.setup";

export type SolanaSigner = Awaited<ReturnType<typeof generateKeyPairSignerWithSol>>;

// Invoke from a scoped `before` hook; root hooks don't fire in parallel workers.
export async function setupSolana(): Promise<SolanaSigner> {
  const keyFilePath = path.resolve(__dirname, "utils", "svm", "keys", "localnet-wallet.json");
  const fileContents = await fs.readFile(keyFilePath, "utf-8");
  const secretKey = new Uint8Array(JSON.parse(fileContents));
  const signer = await createKeyPairSignerFromBytes(secretKey);

  await validatorSetup(signer.address);

  const solanaClient = createDefaultSolanaClient();
  await airdropFactory(solanaClient)({
    recipientAddress: signer.address,
    lamports: lamports(1_000_000_000n),
    commitment: "confirmed",
  });
  await initializeSvmSpoke(signer, solanaClient, signer.address);

  return signer;
}

export function teardownSolana(): void {
  validatorTeardown();
}
