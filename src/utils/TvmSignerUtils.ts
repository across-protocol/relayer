import { TronWeb } from "tronweb";
import { arch } from "@across-protocol/sdk";
import { isSignerWallet, Signer, CHAIN_IDs, getNodeUrlList } from "./";
import assert from "assert";

type TronTransactionResult = Awaited<ReturnType<typeof arch.tvm.submitTransaction>>;

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

/**
 * Transfer native TRX to an account.
 *
 * The SDK's `arch.tvm.submitTransaction` routes through `triggerSmartContract`, which requires a
 * deployed contract at the target address and therefore cannot fund an EOA. TRX transfers consume
 * bandwidth rather than energy, so no fee limit applies.
 *
 * @param tronWeb An authenticated TronWeb instance (with private key set).
 * @param recipient Base58 recipient address.
 * @param amount Transfer amount in SUN (1 TRX = 1,000,000 SUN).
 */
export async function transferNativeTvm(
  tronWeb: TronWeb,
  recipient: string,
  amount: number
): Promise<TronTransactionResult> {
  const sender = tronWeb.defaultAddress?.base58;
  assert(sender, "transferNativeTvm: TronWeb instance must have a default address configured");

  const transaction = await tronWeb.transactionBuilder.sendTrx(recipient, amount, sender);
  const signedTransaction = await tronWeb.trx.sign(transaction);
  const broadcast = await tronWeb.trx.sendRawTransaction(signedTransaction);

  return {
    txid: broadcast.txid ?? signedTransaction.txID,
    result: broadcast.result ?? false,
  };
}
