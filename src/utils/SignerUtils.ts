import { Wallet, retrieveGckmsKeys, getGckmsConfig } from "./";
import minimist from "minimist";
const args = minimist(process.argv.slice(2));

/**
 * Retrieves a signer based on the wallet type defined in the args.
 * @param cleanEnv If true, clears the mnemonic and private key from the env after retrieving the signer.
 * @returns A signer.
 * @throws If the wallet type is not defined or the mnemonic/private key is not set.
 * @note If cleanEnv is true, the mnemonic and private key will be cleared from the env after retrieving the signer.
 * @note This function will throw if called a second time after the first call with cleanEnv = true.
 */
export async function getSigner(cleanEnv = false): Promise<Wallet> {
  if (!Object.keys(args).includes("wallet")) {
    throw new Error("Must define mnemonic, privatekey or gckms for wallet");
  }
  let wallet: Wallet | undefined = undefined;
  switch (args.wallet) {
    case "mnemonic":
      wallet = getMnemonicSigner();
      break;
    case "privateKey":
      wallet = getPrivateKeySigner();
      break;
    case "gckms":
      wallet = await getGckmsSigner();
      break;
    default:
      throw new Error("Must define mnemonic, privatekey or gckms for wallet");
  }
  if (!wallet) {
    throw new Error("Must define mnemonic, privatekey or gckms for wallet");
  }
  if (cleanEnv) {
    cleanKeysFromEnvironment();
  }
  return wallet;
}

/**
 * Retrieves a signer based on the mnemonic set in the env.
 * @returns A signer based on the mnemonic set in the env.
 * @throws If the mnemonic is not set.
 */
function getPrivateKeySigner(): Wallet {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("Wallet private key selected but no PRIVATE_KEY env set!");
  }
  return new Wallet(process.env.PRIVATE_KEY);
}

/**
 * Retrieves a signer based on the GCKMS key set in the args.
 * @returns A signer based on the GCKMS key set in the args.
 * @throws If the GCKMS key is not set.
 */
async function getGckmsSigner(): Promise<Wallet> {
  if (!args.keys) {
    throw new Error("Wallet GCKSM selected but no keys parameter set! Set GCKMS key to use");
  }
  const privateKeys = await retrieveGckmsKeys(getGckmsConfig([args.keys]));
  return new Wallet(privateKeys[0]); // GCKMS retrieveGckmsKeys returns multiple keys. For now we only support 1.
}

/**
 * Retrieves a signer based on the mnemonic set in the env.
 * @returns A signer based on the mnemonic set in the env.
 * @throws If the mnemonic is not set.
 */
function getMnemonicSigner(): Wallet {
  if (!process.env.MNEMONIC) {
    throw new Error("Wallet mnemonic selected but no MNEMONIC env set!");
  }
  return Wallet.fromMnemonic(process.env.MNEMONIC);
}

/**
 * Clears the mnemonic and private key from the env.
 */
function cleanKeysFromEnvironment(): void {
  if (process.env.MNEMONIC) {
    delete process.env.MNEMONIC;
  }
  if (process.env.PRIVATE_KEY) {
    delete process.env.PRIVATE_KEY;
  }
}
