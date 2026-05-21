import { Contract } from "ethers";
import { AugmentedTransaction } from "../clients";
import { DepositAddressMessage } from "../interfaces/DepositAddress";
import { chainIsTvm, TvmAddress } from "./SDKUtils";
import { getEthersCompatibleAddress } from "./ContractUtils";

/**
 * Converts indexer deposit-address payloads so on-chain calls use ethers-compatible `0x`
 * addresses on TVM chains (Tron returns base58 in API fields).
 */
export function normalizeDepositAddressMessage(message: DepositAddressMessage): DepositAddressMessage {
  const { routeParams, erc20Transfer } = message;
  const originChainId = Number(routeParams.originChainId);
  const destinationChainId = Number(routeParams.destinationChainId);
  const transferChainId = Number(erc20Transfer.chainId);

  return {
    ...message,
    depositAddress: getEthersCompatibleAddress(transferChainId, message.depositAddress),
    routeParams: {
      ...routeParams,
      inputToken: getEthersCompatibleAddress(originChainId, routeParams.inputToken),
      outputToken: getEthersCompatibleAddress(destinationChainId, routeParams.outputToken),
      recipient: getEthersCompatibleAddress(destinationChainId, routeParams.recipient),
      refundAddress: getEthersCompatibleAddress(originChainId, routeParams.refundAddress),
    },
    erc20Transfer: {
      ...erc20Transfer,
      from: getEthersCompatibleAddress(transferChainId, erc20Transfer.from),
      to: getEthersCompatibleAddress(transferChainId, erc20Transfer.to),
      contractAddress: getEthersCompatibleAddress(transferChainId, erc20Transfer.contractAddress),
    },
    counterfactualDepositContractAddress: getEthersCompatibleAddress(
      originChainId,
      message.counterfactualDepositContractAddress
    ),
    counterfactualFactoryContractAddress: getEthersCompatibleAddress(
      originChainId,
      message.counterfactualFactoryContractAddress
    ),
    adminWithdrawManagerContractAddress: getEthersCompatibleAddress(
      originChainId,
      message.adminWithdrawManagerContractAddress
    ),
    counterfactualMaterials: {
      withdrawLeaf: {
        ...message.counterfactualMaterials.withdrawLeaf,
        implementationAddress: getEthersCompatibleAddress(
          originChainId,
          message.counterfactualMaterials.withdrawLeaf.implementationAddress
        ),
      },
    },
  };
}

/**
 * Returns the chain-native address string. TVM (Tron) uses Base58Check (`T...`); EVM chains keep `0x`.
 * Accepts either form as input (e.g. after {@link normalizeDepositAddressMessage}).
 */
export function toChainNativeAddress(chainId: number, address: string): string {
  if (!chainIsTvm(chainId)) {
    return address;
  }
  return TvmAddress.from(address).toNative();
}

/**
 * Returns a unique key for a deposit so we can track if it was already executed (e.g. in observedExecutedDeposits).
 */
export function getDepositKey(depositMessage: DepositAddressMessage): string {
  return `${depositMessage.depositAddress}:${depositMessage.erc20Transfer.transactionHash}`;
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
