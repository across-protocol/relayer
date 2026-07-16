import { Contract } from "ethers";
import { AugmentedTransaction } from "../clients";
import { AnyDepositAddressMessage, DepositAddressMessage } from "../interfaces/DepositAddress";
import { getEthersCompatibleAddress } from "./ContractUtils";

/**
 * Converts indexer deposit-address payloads so on-chain calls use ethers-compatible `0x`
 * addresses on TVM chains (Tron returns base58 in API fields).
 */
export function normalizeDepositAddressMessage(message: DepositAddressMessage): DepositAddressMessage {
  const { routeParams, erc20Transfer, counterfactualMaterials } = message;
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
    // Materials can be absent: deposit addresses created before the indexer's V2-materials
    // backfill are served with `counterfactualMaterials: undefined`. The withdraw path already
    // guards on the leaf (`_getSignedWithdraw`), so pass the absence through rather than throw.
    ...(counterfactualMaterials && {
      counterfactualMaterials: {
        // Spread first so the fee-bearing cctp/spokePool leaves (and their `params.executionFee`)
        // survive normalization; the explicit overrides below re-normalize the leaf addresses.
        ...counterfactualMaterials,
        ...(counterfactualMaterials.withdrawLeaf && {
          withdrawLeaf: {
            ...counterfactualMaterials.withdrawLeaf,
            implementationAddress: getEthersCompatibleAddress(
              originChainId,
              counterfactualMaterials.withdrawLeaf.implementationAddress
            ),
          },
        }),
        ...(counterfactualMaterials.cctpLeaf && {
          cctpLeaf: {
            ...counterfactualMaterials.cctpLeaf,
            implementationAddress: getEthersCompatibleAddress(
              originChainId,
              counterfactualMaterials.cctpLeaf.implementationAddress
            ),
          },
        }),
        ...(counterfactualMaterials.spokePoolLeaf && {
          spokePoolLeaf: {
            ...counterfactualMaterials.spokePoolLeaf,
            implementationAddress: getEthersCompatibleAddress(
              originChainId,
              counterfactualMaterials.spokePoolLeaf.implementationAddress
            ),
          },
        }),
      },
    }),
  };
}

/**
 * Returns a unique key for a deposit so we can track if it was already executed (e.g. in observedExecutedDeposits).
 * Accepts any message version — the key only depends on the shared deposit-address/transfer envelope.
 */
export function getDepositKey(depositMessage: AnyDepositAddressMessage): string {
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
