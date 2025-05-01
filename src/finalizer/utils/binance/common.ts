import { type Binance } from "binance-api-node";

type Coin = {
  symbol: string;
  balance: string;
  networkList: Network[];
};

type Network = {
  name: string;
  coin: string;
  withdrawMin: string;
  withdrawMax: string;
  contractAddress: string;
};

export type ParsedAccountCoins = Coin[];

// The call to accountCoins returns an opaque `unknown` object with extraneous information. This function
// parses the unknown into a readable object to be used by the finalizers.
export async function getAccountCoins(binanceApi: Binance): Promise<ParsedAccountCoins> {
  const coins = Object.values(await binanceApi["accountCoins"]());
  return coins.map((coin) => {
    const networkList = coin["networkList"]?.map((network) => {
      return {
        name: network["network"],
        coin: network["coin"],
        withdrawMin: network["withdrawMin"],
        withdrawMax: network["withdrawMax"],
        contractAddress: network["contractAddress"],
      } as Network;
    });
    return {
      symbol: coin["coin"],
      balance: coin["free"],
      networkList,
    } as Coin;
  });
}
