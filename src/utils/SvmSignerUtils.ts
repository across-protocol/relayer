import { web3 } from "@coral-xyz/anchor";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { Wallet } from "./";

export function getSvmSignerFromEvmSigner(evmSigner: Wallet): web3.Keypair {
  // Extract the private key from the evm signer and use it to create a svm signer.
  const evmPrivateKey = evmSigner._signingKey().privateKey;
  return getSvmSignerFromPrivateKey(evmPrivateKey);
}

export function getSvmSignerFromPrivateKey(privateKey: string): web3.Keypair {
  const privateKeyAsBytes = Uint8Array.from(Buffer.from(privateKey.slice(2), "hex"));
  return web3.Keypair.fromSeed(privateKeyAsBytes);
}

export async function getKitKeypairFromEvmSigner(evmSigner: Wallet): Promise<KeyPairSigner> {
  const web3Signer = getSvmSignerFromEvmSigner(evmSigner);
  return createKeyPairSignerFromBytes(web3Signer.secretKey);
}
