import { TronWeb } from "tronweb";
import { isSignerWallet, Signer, CHAIN_IDs, getNodeUrlList } from "./";
import assert from "assert";

export function getTronWebFromEvmSigner(evmSigner: Signer): TronWeb {
  assert(isSignerWallet(evmSigner), "Signer is not a Wallet");

  const evmPrivateKey = evmSigner._signingKey().privateKey;

  // @Todo. There's likely a better way to do this.
  // getNodeUrlList yields the eth-JSON-RPC endpoint, which is what the ethers provider needs (see
  // src/clients/README.md). TronWeb speaks Tron's native HTTP API and resolves paths like
  // wallet/createtransaction relative to fullHost, so the JSON-RPC suffix has to come off first --
  // otherwise every native request lands on <host>/jsonrpc/wallet/... and is rejected. Providers
  // serve the native API from the same base: TronGrid at /, QuikNode at the bare token path.
  const rpcUrl = Object.values(getNodeUrlList(CHAIN_IDs.TRON, 1))[0];
  const fullHost = rpcUrl.replace(/\/jsonrpc\/*$/, "");
  return new TronWeb({
    fullHost,
    privateKey: evmPrivateKey.slice(2),
  });
}
