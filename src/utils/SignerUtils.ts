import { Wallet, retrieveGckmsKeys, getGckmsConfig } from "./";
import minimist from "minimist";
const args = minimist(process.argv.slice(2));

export async function getSigner(): Promise<Wallet> {
  if (!Object.keys(args).includes("wallet")) {
    throw new Error("Must define mnemonic, privatekey or gckms for wallet");
  }
  if (args.wallet === "mnemonic") {
    return getMnemonicSigner();
  }
  if (args.wallet === "privateKey") {
    return getPrivateKeySigner();
  }
  if (args.wallet === "gckms") {
    return await getGckmsSigner();
  }
}

function getPrivateKeySigner() {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("Wallet private key selected but no PRIVATE_KEY env set!");
  }
  return new Wallet(process.env.PRIVATE_KEY);
}

async function getGckmsSigner() {
  if (!args.keys) {
    throw new Error("Wallet GCKSM selected but no keys parameter set! Set GCKMS key to use");
  }
  const privateKeys = await retrieveGckmsKeys(getGckmsConfig([args.keys]));
  return new Wallet(privateKeys[0]); // GCKMS retrieveGckmsKeys returns multiple keys. For now we only support 1.
}

function getMnemonicSigner() {
  if (!process.env.MNEMONIC) {
    throw new Error("Wallet mnemonic selected but no MNEMONIC env set!");
  }
  return Wallet.fromMnemonic(process.env.MNEMONIC);
}
