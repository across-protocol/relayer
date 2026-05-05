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
  from: string;
  to: string;
  amount: string;
  contractAddress: string;
  transactionHash: string;
  transferClassification: DepositAddressTransferClassification;
}
export interface DepositAddressMessage {
  depositAddress: string;
  paramsHash: string;
  routeParams: RouteParams;
  erc20Transfer: Erc20Transfer;
  salt: string;
  counterfactualDepositContractAddress: string;
  counterfactualFactoryContractAddress: string;
  shouldSponsorAccountCreation: boolean;
}

// TODO: Add schema for SwapAPI response.
export interface DepositSignApiResponse {
  signature: string;
}
