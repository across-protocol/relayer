// @TODO: Check if this is the correct schema for deposit addresses message.
// Add schema for SwapAPI response.

export interface RouteParams {
  inputToken: string;
  outputToken: string;
  originChainId: string;
  destinationChainId: string;
  recipient: string;
  refundAddress: string;
}

export interface Erc20Transfer {
  chainId: string;
  from: string;
  to: string;
  amount: string;
  contractAddress: string;
}
export interface DepositAddressMessage {
  depositAddress: string;
  routeParams: RouteParams;
  erc20Transfer: Erc20Transfer;
}
