import { airdropFactory, createKeyPairSignerFromBytes, lamports } from "@solana/kit";
import fs from "fs/promises";
import path from "node:path";
import { createDefaultSolanaClient, generateKeyPairSignerWithSol, initializeSvmSpoke } from "./utils/svm/utils";
import { validatorSetup, validatorTeardown } from "./utils/svm/validator.setup";

// Create the signer
let signer: Awaited<ReturnType<typeof generateKeyPairSignerWithSol>>;

before(async function () {
  /* Get test signer */
  const keyFilePath = path.resolve(__dirname, "utils", "svm", "keys", "localnet-wallet.json");
  const fileContents = await fs.readFile(keyFilePath, "utf-8");
  const secretKey = new Uint8Array(JSON.parse(fileContents));
  signer = await createKeyPairSignerFromBytes(secretKey);

  /* Local validator spin‑up can take a few seconds */
  this.timeout(60_000);
  await validatorSetup(signer.address);

  const solanaClient = createDefaultSolanaClient();

  // Airdrop SOL to the signer
  await airdropFactory(solanaClient)({
    recipientAddress: signer.address,
    lamports: lamports(1_000_000_000n),
    commitment: "confirmed",
  });

  // Initialize the program and get the state
  await initializeSvmSpoke(signer, solanaClient, signer.address);
});

after(() => {
  validatorTeardown();
});

// Export signer for use in tests
export { signer };
