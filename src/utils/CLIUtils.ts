import minimist from "minimist";
import { SignerOptions, getSigner } from "./SignerUtils";
import { Wallet } from "ethers";

/**
 * Retrieves a signer based on both the CLI args and the env.
 * @returns A signer based on the CLI args.
 */
export function retrieveSignerFromCLIArgs(): Promise<Wallet> {
  // Call into the process' argv to retrieve the CLI args.
  const args = minimist(process.argv.slice(2));
  // Build out the signer options to pass to the signer utils.
  const signerOptions: SignerOptions = {
    keyType: args.wallet,
    gckmsKeys: args.keys,
    cleanEnv: false, // TODO: We don't want to clean the env for now. This will be changed in the future.
  };
  // Return the signer.
  return getSigner(signerOptions);
}
