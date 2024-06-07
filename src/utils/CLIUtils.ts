import minimist from "minimist";
import { Signer } from "ethers";
import { constants as sdkConsts } from "@across-protocol/sdk";
import { SignerOptions, getSigner } from "./SignerUtils";
import { isDefined } from "./TypeGuards";

const keyTypes = ["secret", "mnemonic", "privateKey", "gckms", "void"];

/**
 * Retrieves a signer based on both the CLI args and the env.
 * @returns A signer based on the CLI args.
 */
export function retrieveSignerFromCLIArgs(): Promise<Signer> {
  const opts = {
    string: ["wallet", "keys", "address"],
    default: {
      wallet: "secret",
      address: sdkConsts.DEFAULT_SIMULATED_RELAYER_ADDRESS,
    },
  };

  // Call into the process' argv to retrieve the CLI args.
  const args = minimist(process.argv.slice(2), opts);

  // Resolve the wallet type & verify that it is valid.
  const keyType = args.wallet ?? "secret";
  if (!isValidKeyType(keyType)) {
    throw new Error(`Unsupported key type (${keyType}); expected one of: ${keyTypes.join(", ")}.`);
  }

  // Build out the signer options to pass to the signer utils.
  const signerOptions: SignerOptions = {
    keyType,
    gckmsKeys: isDefined(args.keys) ? [args.keys] : [],
    roAddress: args.address,
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
function isValidKeyType(keyType: string): keyType is "secret" | "mnemonic" | "privateKey" | "gckms" | "void" {
  return keyTypes.includes(keyType);
}
