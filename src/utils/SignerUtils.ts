import { readFile } from "fs/promises";
import { constants as ethersConsts, VoidSigner } from "ethers";
import { typeguards } from "@across-protocol/sdk-v2";
import { Signer, Wallet, retrieveGckmsKeys, getGckmsConfig, isDefined } from "./";

/**
 * Signer options for the getSigner function.
 */
export type SignerOptions = {
  /*
   * The type of signer to use.
   * @note If using a GCKMS signer, the gckmsKeys parameter must be set.
   */
  keyType: string;
  /**
   * Whether or not to clear the mnemonic/private key from the env after retrieving the signer.
   * @note Not including this parameter or setting it to false will not clear the mnemonic/private key from the env.
   */
  cleanEnv?: boolean;
  /**
   * The GCKMS keys to use.
   * @note This parameter is only required if the keyType is set to gckms.
   */
  gckmsKeys?: string[];
  /**
   * For a void signer, the address to use.
   */
  roAddress?: string;
};

/**
 * Retrieves a signer based on the signer type defined in the args.
 * @param cleanEnv If true, clears the mnemonic and private key from the env after retrieving the signer.
 * @returns A signer.
 * @throws If the signer type is not defined or the mnemonic/private key is not set.
 * @note If cleanEnv is true, the mnemonic and private key will be cleared from the env after retrieving the signer.
 * @note This function will throw if called a second time after the first call with cleanEnv = true.
 */
export async function getSigner({ keyType, gckmsKeys, cleanEnv, roAddress }: SignerOptions): Promise<Signer> {
  let signer: Signer | undefined = undefined;
  switch (keyType) {
    case "mnemonic":
      signer = getMnemonicSigner();
      break;
    case "privateKey":
      signer = getPrivateKeySigner();
      break;
    case "gckms":
      signer = await getGckmsSigner(gckmsKeys);
      break;
    case "secret":
      signer = await getSecretSigner();
      break;
    case "void":
      signer = new VoidSigner(roAddress ?? ethersConsts.AddressZero);
      break;
    default:
      throw new Error(`getSigner: Unsupported signer key type (${keyType})`);
  }
  if (!signer) {
    throw new Error('Must specify "secret", "mnemonic", "privateKey", "gckms" or "void" for keyType');
  }
  if (cleanEnv) {
    cleanKeysFromEnvironment();
  }
  return signer;
}

/**
 * Retrieves a signer based on the mnemonic set in the env.
 * @returns A signer based on the mnemonic set in the env.
 * @throws If a valid private key is not defined in the environment.
 */
function getPrivateKeySigner(): Signer {
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
async function getGckmsSigner(keys?: string[]): Promise<Signer> {
  if (!isDefined(keys) || keys.length === 0) {
    throw new Error("Wallet GCKMS selected but no keys parameter set! Set GCKMS key (--keys <key>) to use");
  }
  const privateKeys = await retrieveGckmsKeys(getGckmsConfig(keys));
  return new Wallet(privateKeys[0]); // GCKMS retrieveGckmsKeys returns multiple keys. For now we only support 1.
}

/**
 * Retrieves a signer based on the mnemonic set in the env.
 * @returns A signer based on the mnemonic set in the env.
 * @throws If a valid mnemonic is not defined in the environment.
 */
function getMnemonicSigner(): Signer {
  if (!process.env.MNEMONIC) {
    throw new Error("Wallet mnemonic selected but no MNEMONIC env set!");
  }
  return Wallet.fromMnemonic(process.env.MNEMONIC);
}

/**
 * Retrieves a signer based on the secret stored in ./.secret.
 * @returns An ethers Signer object.
 * @throws If a valid secret could not be read.
 */
async function getSecretSigner(): Promise<Signer> {
  const { SECRET = "./.secret" } = process.env;
  let secret: string;
  try {
    secret = await readFile(SECRET, { encoding: "utf8" });
    secret = secret.trim().replace("\n", "");
    return /^0x[0-9a-f]{64}$/.test(secret) ? new Wallet(secret) : Wallet.fromMnemonic(secret);
  } catch (err) {
    const msg = typeguards.isError(err) ? err.message : "unknown error";
    throw new Error(`Unable to load secret (${SECRET}: ${msg})`);
  }
}

/**
 * Clears any instances of MNEMONIC, PRIVATE_KEY or SECRET from the env.
 */
function cleanKeysFromEnvironment(): void {
  ["MNEMONIC", "PRIVATE_KEY", "SECRET"].forEach((config) => delete process.env[config]);
}
