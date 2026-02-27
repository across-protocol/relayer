import { Contract } from "ethers";
import { AugmentedTransaction } from "../clients";
import { DepositAddressMessage } from "../interfaces/DepositAddress";

/**
 * Returns a unique key for a deposit so we can track if it was already executed (e.g. in observedExecutedDeposits).
 */
export function getDepositKey(depositMessage: DepositAddressMessage): string {
  return `${depositMessage.depositAddress}:${depositMessage.paramsHash}:${depositMessage.salt}`;
}

/**
 * Builds an AugmentedTransaction that calls CounterfactualDepositFactory.deploy.
 * Deploys the counterfactual deposit contract at a deterministic address.
 * paramsHash is computed inside as keccak256(abi.encode(routeParams)).
 *
 * @param factoryContract Connected CounterfactualDepositFactory contract (signer must be connected for submission).
 * @param chainId Chain id for the transaction.
 * @param counterfactualDepositImplementation Implementation contract address to clone.
 * @param routeParams Route params; paramsHash is derived from this.
 * @param salt bytes32 salt for CREATE2.
 * @returns AugmentedTransaction ready for submitTransaction().
 */
export function buildDeployTx(
  factoryContract: Contract,
  chainId: number,
  counterfactualDepositImplementation: string,
  paramsHash: string,
  salt: string
): AugmentedTransaction {
  return {
    contract: factoryContract,
    chainId,
    method: "deploy",
    args: [counterfactualDepositImplementation, paramsHash, salt],
    ensureConfirmation: true,
  };
}
