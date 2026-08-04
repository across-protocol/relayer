import { TronWeb } from "tronweb";
import { isSignerWallet, Signer, CHAIN_IDs, getNodeUrlList } from "./";
import assert from "assert";

export function getTronWebFromEvmSigner(evmSigner: Signer): TronWeb {
  assert(isSignerWallet(evmSigner), "Signer is not a Wallet");

  const evmPrivateKey = evmSigner._signingKey().privateKey;

  // @Todo. There's likely a better way to do this.
  const fullHost = Object.values(getNodeUrlList(CHAIN_IDs.TRON, 1))[0];
  return new TronWeb({
    fullHost,
    privateKey: evmPrivateKey.slice(2),
  });
}
