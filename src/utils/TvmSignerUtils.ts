import { TronWeb } from "tronweb";
import { isSignerWallet, Signer, ethers } from "./";
import assert from "assert";

export function getTronWebFromEvmSigner(evmSigner: Signer): TronWeb {
  assert(isSignerWallet(evmSigner), "Signer is not a Wallet");

  const evmPrivateKey = evmSigner._signingKey().privateKey;

  const fullHost = (evmSigner.provider as ethers.providers.StaticJsonRpcProvider).connection.url;
  return new TronWeb({
    fullHost,
    privateKey: evmPrivateKey,
  });
}
