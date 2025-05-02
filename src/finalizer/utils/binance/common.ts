import { type Binance } from "binance-api-node";
import { mapAsync, ethers } from "../../../utils";

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

type BinanceInteraction = {
  // The amount of `coin` transferred in this interaction.
  amount: number;
  // The external (non binance-wallet) EOA involved with this interaction.
  externalAddress: string;
  // The coin used in this interaction (i.e. the token symbol).
  coin: string;
  // The network on which this interaction took place.
  network: string;
};

type ParsedAccountCoins = Coin[];

// Returns a map of token symbol to binance finalizable amounts.
export async function getBinanceDepositsByNetwork(
  binanceApi: Binance,
  provider: ethers.providers.Provider,
  fromNetwork: string,
  startTime: number
): Promise<BinanceInteraction[]> {
  const _depositHistory = await binanceApi.depositHistory({ startTime });
  // We must filter historical deposits and withdrawals based on the starting network. Since this is a L1 to L2 finalizer, deposits should originate on Ethereum.
  // And withdrawals should end on Binance Smart Chain.
  const depositHistory = Object.values(_depositHistory).filter((deposit) => deposit.network === fromNetwork);

  // We also need to filter out deposits which are not ready to be finalized. A deposit.status of 1 means that the deposit has been fully processed and can be withdrawn on L2.
  const finalizableDeposits = depositHistory.filter((deposit) => deposit.status === 1);

  return mapAsync(finalizableDeposits, async (deposit) => {
    const depositTxnReceipt = await provider.getTransactionReceipt(deposit.txId);
    return {
      amount: Number(deposit.amount),
      externalAddress: depositTxnReceipt.from,
      coin: deposit.coin,
      network: deposit.network,
    };
  });
}

export async function getBinanceWithdrawalsByNetwork(
  binanceApi: Binance,
  toNetwork: string,
  coin: string,
  startTime: number
): Promise<BinanceInteraction[]> {
  const withdrawals = await binanceApi.withdrawHistory({ coin, startTime });

  return mapAsync(
    Object.values(withdrawals).filter((withdrawal) => withdrawal.network === toNetwork),
    async (withdrawal) => {
      return {
        amount: Number(withdrawal.amount),
        externalAddress: withdrawal.address,
        coin,
        network: toNetwork,
      };
    }
  );
}

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
