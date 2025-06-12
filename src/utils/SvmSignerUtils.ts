import { web3 } from "@coral-xyz/anchor";
import { isSignerWallet, Signer } from "./";
import assert from "assert";

export function getSvmSignerFromEvmSigner(evmSigner: Signer): web3.Keypair {
  assert(isSignerWallet(evmSigner), "Signer is not a Wallet");

  // Extract the private key from the evm signer and use it to create a svm signer.
  const evmPrivateKey = evmSigner._signingKey().privateKey;
  return getSvmSignerFromPrivateKey(evmPrivateKey);
}

export function getSvmSignerFromPrivateKey(privateKey: string): web3.Keypair {
  const privateKeyAsBytes = Uint8Array.from(Buffer.from(privateKey.slice(2), "hex"));
  return web3.Keypair.fromSeed(privateKeyAsBytes);
}
