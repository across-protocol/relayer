import { Contract, utils } from "ethers";
import { AugmentedTransaction } from "../clients";
import { DepositAddressMessage, RouteParams } from "../interfaces/DepositAddress";

/**
 * Computes paramsHash as keccak256(abi.encode(routeParams)).
 * Encoding order and types must match the contract's RouteParams struct.
 */
export function computeParamsHash(routeParams: RouteParams, implAddress: string): string {
  const encoded = utils.defaultAbiCoder.encode(
    ["address", "address", "uint256", "uint256", "address", "address"],
    [
      routeParams.inputToken,
      routeParams.outputToken,
      routeParams.originChainId,
      routeParams.destinationChainId,
      routeParams.recipient,
      routeParams.refundAddress,
    ]
  );
  const paramsHash = utils.keccak256(encoded);
  return utils.keccak256(
    utils.defaultAbiCoder.encode(
      ["address", "bytes32"],
      [implAddress, paramsHash]
    )
  );
}

/**
 * Returns a unique key for a deposit so we can track if it was already executed (e.g. in observedExecutedDeposits).
 */
export function getDepositKey(depositMessage: DepositAddressMessage): string {
  const paramsHash = computeParamsHash(depositMessage.routeParams, depositMessage.depositAddress);
  return `${depositMessage.depositAddress}:${paramsHash}:${depositMessage.salt}`;
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
  routeParams: RouteParams,
  salt: string
): AugmentedTransaction {
  const paramsHash = computeParamsHash(routeParams, counterfactualDepositImplementation);
  return {
    contract: factoryContract,
    chainId,
    method: "deploy",
    args: [counterfactualDepositImplementation, paramsHash, salt],
    ensureConfirmation: true,
  };
}
