import { Contract, BigNumber, utils } from "ethers";
import { AugmentedTransaction } from "../clients";
import { DepositAddressMessage, RouteParams, Erc20Transfer } from "../interfaces/DepositAddress";

/**
 * Computes paramsHash as keccak256(abi.encode(routeParams)).
 * Encoding order and types must match the contract's RouteParams struct.
 */
export function computeParamsHash(routeParams: RouteParams): string {
  // TODO: Is this good? Or should we use the same as the SwapAPI??
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
 * Encodes Erc20Transfer as ABI-encoded bytes for use as executeCalldata.
 * Encoding order and types must match the contract's Erc20Transfer struct.
 */
export function encodeExecuteCalldata(erc20Transfer: Erc20Transfer): string {
  return utils.defaultAbiCoder.encode(
    ["uint256", "address", "address", "uint256", "address"],
    [erc20Transfer.chainId, erc20Transfer.from, erc20Transfer.to, erc20Transfer.amount, erc20Transfer.contractAddress]
  );
}

/**
 * Builds an AugmentedTransaction that calls CounterfactualDepositFactory.deployIfNeededAndExecute.
 * Constructs params from depositMessage: paramsHash from routeParams, and uses
 * counterfactualDepositImplementation, salt, executeCalldata from the message (optional fields).
 *
 * @param factoryContract Connected CounterfactualDepositFactory contract (signer must be connected for submission).
 * @param chainId Chain id for the transaction.
 * @param depositMessage Full message; must include counterfactualDepositImplementation, salt, executeCalldata for the deploy call.
 * @param value Optional value to send (method is payable).
 * @returns AugmentedTransaction ready for submitTransaction().
 * @throws If depositMessage is missing counterfactualDepositImplementation, salt, or executeCalldata.
 */
export function buildDeployIfNeededAndExecuteTx(
  factoryContract: Contract,
  chainId: number,
  depositMessage: DepositAddressMessage,
  value?: BigNumber
): AugmentedTransaction {
  const paramsHash = computeParamsHash(depositMessage.routeParams);
  const counterfactualDepositImplementation = depositMessage.depositAddress;
  const salt = ""; // TODO: Are we getting salt from SwapAPI/Indexer??
  const executeCalldata = encodeExecuteCalldata(depositMessage.erc20Transfer); // Should we get these info from SwapAPI instead??

  const args = [counterfactualDepositImplementation, paramsHash, salt, executeCalldata];

  return {
    contract: factoryContract,
    chainId,
    method: "deployIfNeededAndExecute", // Should we always use this method or can we deduct if the address is already deployed so we can use `execute` directly??
    args,
    value,
    ensureConfirmation: true,
  };
}
