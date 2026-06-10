export interface RouteParams {
  inputToken: string;
  outputToken: string;
  originChainId: string;
  destinationChainId: string;
  recipient: string;
  refundAddress: string;
}

export type DepositAddressTransferClassification = "correct_transfer" | "mis_route" | "intent_refund";

export interface Erc20Transfer {
  chainId: string;
  blockNumber: number;
  logIndex: number;
  from: string;
  to: string;
  amount: string;
  contractAddress: string;
  transactionHash: string;
  transferClassification: DepositAddressTransferClassification;
}

export interface CounterfactualLeaf {
  implementationAddress: string;
  encodedParams: string;
  leafHash: string;
  merkleProof: string[];
}

/**
 * Bridge leaf that carries the `executionFee` committed into the merkle root at deposit-address
 * creation time (decimal string, input-token base units; absent on pre-fee messages, "0" on
 * sponsored routes). The bot echoes this value back to the swap API verbatim so the rebuilt proof
 * verifies. Only `cctpLeaf`/`spokePoolLeaf` carry it; `withdrawLeaf` never does.
 */
export interface ExecutionFeeLeaf extends CounterfactualLeaf {
  params?: { executionFee: string };
}

export interface CounterfactualMaterials {
  withdrawLeaf: CounterfactualLeaf;
  cctpLeaf?: ExecutionFeeLeaf;
  spokePoolLeaf?: ExecutionFeeLeaf;
}

export interface DepositAddressMessage {
  depositAddress: string;
  paramsHash: string;
  routeParams: RouteParams;
  erc20Transfer: Erc20Transfer;
  salt: string;
  counterfactualDepositContractAddress: string;
  counterfactualFactoryContractAddress: string;
  adminWithdrawManagerContractAddress: string;
  counterfactualMaterials: CounterfactualMaterials;
  shouldSponsorAccountCreation: boolean;
  /** Indexer message version. Bot only processes v1 (or absent = legacy v1); v2/v3 are ignored. */
  version?: number;
}

// TODO: Add schema for SwapAPI response.
export interface DepositSignApiResponse {
  signature: string;
}
