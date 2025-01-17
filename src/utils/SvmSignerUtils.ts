import {
  createKeyPairSignerFromPrivateKeyBytes,
  KeyPairSigner,
  createKeyPairFromBytes,
  createSignerFromKeyPair,
  Wallet,
} from "./";
import fs from "fs";

export async function getSvmSignerFromEvmSigner(evmSigner: Wallet): Promise<KeyPairSigner> {
  // Extract the private key from the evm signer and use it to create a svm signer.
  const evmPrivateKey = evmSigner._signingKey().privateKey;
  return await getSvmSignerFromPrivateKey(evmPrivateKey);
}

export async function getSvmSignerFromFile(filePath: string): Promise<KeyPairSigner> {
  const keypairFile = fs.readFileSync(filePath);
  const keypairBytes = new Uint8Array(JSON.parse(keypairFile.toString()));

  // Create a KeyPairSigner from the bytes.
  const keys = await createKeyPairFromBytes(keypairBytes);
  return await createSignerFromKeyPair(keys);
}

export async function getSvmSignerFromPrivateKey(privateKey: string): Promise<KeyPairSigner> {
  const privateKeyAsBytes = Uint8Array.from(Buffer.from(privateKey.slice(2), "hex"));
  return await createKeyPairSignerFromPrivateKeyBytes(privateKeyAsBytes);
}
