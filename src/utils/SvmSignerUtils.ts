import { createKeyPairSignerFromPrivateKeyBytes, type KeyPairSigner } from "@solana/kit";
import { isSignerWallet, Signer } from "./";
import assert from "assert";

export async function getKitKeypairFromEvmSigner(evmSigner: Signer): Promise<KeyPairSigner> {
  assert(isSignerWallet(evmSigner), "Signer is not a Wallet");
  return getKitKeypairFromPrivateKey(evmSigner._signingKey().privateKey);
}

export function getKitKeypairFromPrivateKey(privateKey: string): Promise<KeyPairSigner> {
  const privateKeyAsBytes = Uint8Array.from(Buffer.from(privateKey.slice(2), "hex"));
  return createKeyPairSignerFromPrivateKeyBytes(privateKeyAsBytes);
}
