import { Contract, BigNumber, utils } from "ethers";
import { AugmentedTransaction } from "../clients";
import { DepositAddressMessage, RouteParams } from "../interfaces/DepositAddress";

/**
 * Computes paramsHash as keccak256(abi.encode(routeParams)).
 * Encoding order and types must match the contract's RouteParams struct.
 */
export function computeParamsHash(routeParams: RouteParams): string {
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
  return utils.keccak256(encoded);
}

/**
 * Returns a unique key for a deposit so we can track if it was already executed (e.g. in observedExecutedDeposits).
 */
export function getDepositKey(depositMessage: DepositAddressMessage): string {
  const paramsHash = computeParamsHash(depositMessage.routeParams);
  return `${depositMessage.depositAddress}:${paramsHash}:${depositMessage.salt}`;
}

/**
 * Builds an AugmentedTransaction that calls CounterfactualDepositFactory.execute.
 * Use when the deposit contract is already deployed and you only need to run executeCalldata.
 *
 * @param factoryContract Connected CounterfactualDepositFactory contract (signer must be connected for submission).
 * @param chainId Chain id for the transaction.
 * @param depositAddress The counterfactual deposit contract address.
 * @param executeCalldata ABI-encoded bytes to execute on the deposit contract.
 * @param value Optional value to send (method is payable).
 * @returns AugmentedTransaction ready for submitTransaction().
 */
export function buildExecuteTx(
  factoryContract: Contract,
  chainId: number,
  depositAddress: string,
  executeCalldata: string,
  value?: BigNumber
): AugmentedTransaction {
  return {
    contract: factoryContract,
    chainId,
    method: "execute",
    args: [depositAddress, executeCalldata],
    value,
    ensureConfirmation: true,
  };
}

/**
 * Builds an AugmentedTransaction that calls CounterfactualDepositFactory.deployIfNeededAndExecute.
 * Constructs params from depositMessage: paramsHash from routeParams; salt and executeCalldata from the message (Indexer/SwapAPI).
 *
 * @param factoryContract Connected CounterfactualDepositFactory contract (signer must be connected for submission).
 * @param chainId Chain id for the transaction.
 * @param depositMessage Full message; must include salt and executeCalldata (from Indexer and SwapAPI responses).
 * @param value Optional value to send (method is payable).
 * @returns AugmentedTransaction ready for submitTransaction().
 * @throws If depositMessage is missing salt or executeCalldata.
 */
export function buildDeployIfNeededAndExecuteTx(
  factoryContract: Contract,
  chainId: number,
  depositMessage: DepositAddressMessage,
  executeCalldata: string,
  value?: BigNumber
): AugmentedTransaction {
  const paramsHash = computeParamsHash(depositMessage.routeParams);
  const counterfactualDepositImplementation = depositMessage.depositAddress;
  const { salt } = depositMessage;

  if (!salt) {
    throw new Error("buildDeployIfNeededAndExecuteTx: depositMessage.salt is required (from Indexer API)");
  }
  if (!executeCalldata) {
    throw new Error(
      "buildDeployIfNeededAndExecuteTx: depositMessage.executeCalldata is required (from SwapAPI response)"
    );
  }

  const args = [counterfactualDepositImplementation, paramsHash, salt, executeCalldata];

  return {
    contract: factoryContract,
    chainId,
    method: "deployIfNeededAndExecute",
    args,
    value,
    ensureConfirmation: true,
  };
}
