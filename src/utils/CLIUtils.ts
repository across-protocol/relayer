import minimist from "minimist";
import { Signer } from "ethers";
import { SignerOptions, getSigner } from "./SignerUtils";
import { isDefined } from "./TypeGuards";

const keyTypes = ["secret", "mnemonic", "privateKey", "gckms", "void"];

/**
 * Retrieves a signer based on both the CLI args and the env.
 * @returns A signer based on the CLI args.
 */
export function retrieveSignerFromCLIArgs(): Promise<Signer> {
  // Call into the process' argv to retrieve the CLI args.
  const args = minimist(process.argv.slice(2));
  // Resolve the wallet type & verify that it is valid.
  const keyType = (args.wallet as string) ?? "mnemonic";
  if (!isValidKeyType(keyType)) {
    throw new Error(`Unsupported key type (${keyType}); expected one of: ${keyTypes.join(", ")}.`);
  }

  // Build out the signer options to pass to the signer utils.
  const signerOptions: SignerOptions = {
    keyType,
    gckmsKeys: isDefined(args.keys) ? [args.keys] : [],
    cleanEnv: false, // TODO: We don't want to clean the env for now. This will be changed in the future.
  };
  // Return the signer.
  return getSigner(signerOptions);
}

/**
 * Checks if the key type is valid for being passed as input to the CLI
 * @param keyType The key type to check.
 * @returns True if the key type is valid, false otherwise.
 */
function isValidKeyType(keyType: unknown): keyType is "secret" | "mnemonic" | "privateKey" | "gckms" | "void" {
  return keyTypes.includes(keyType as string);
}
