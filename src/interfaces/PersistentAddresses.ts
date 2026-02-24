// @TODO: Check if this is the correct schema for persistent addresses message.
// Add schema for SwapAPI response.
export interface PersistentAddressesMessage {
  address: string;
  chainId: number;
  token: string;
  amount: string;
  txHash: string;
  routeParams: unknown;
}
