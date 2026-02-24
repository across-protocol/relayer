// @TODO: Check if this is the correct schema for deposit addresses message.
// Add schema for SwapAPI response.
export interface DepositAddressMessage {
  address: string;
  chainId: number;
  token: string;
  amount: string;
  txHash: string;
  routeParams: unknown;
}
