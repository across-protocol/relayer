import { BigNumber, bnZero, EvmAddress, ethers, isDefined } from "../../utils";
import { BaseRebalancerClient } from "./BaseRebalancerClient";

export class ReadOnlyRebalancerClient extends BaseRebalancerClient {
  override async rebalanceInventory(): Promise<void> {
    throw new Error("ReadOnlyRebalancerClient does not support rebalancing inventory");
  }

  async getPendingBinanceRebalances(recipientAddresses: string[]): Promise<{
    [chainId: number]: { [token: string]: BigNumber };
  }> {
    const binanceAdapter = this.adapters["binance"];
    if (!isDefined(binanceAdapter)) {
      return {};
    }

    const pendingRebalances = await Promise.all(
      getEvmBinanceRebalanceLookupAccounts(recipientAddresses, this.baseSignerAddress.toNative()).map((account) =>
        binanceAdapter.getPendingRebalances(account)
      )
    );
    return sumPendingRebalances(pendingRebalances);
  }
}

function sumPendingRebalances(pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } }[]): {
  [chainId: number]: { [token: string]: BigNumber };
} {
  return pendingRebalances.reduce<{ [chainId: number]: { [token: string]: BigNumber } }>((acc, pending) => {
    for (const [_chainId, tokenBalances] of Object.entries(pending)) {
      const chainId = Number(_chainId);
      acc[chainId] ??= {};
      for (const [token, amount] of Object.entries(tokenBalances)) {
        acc[chainId][token] = (acc[chainId][token] ?? bnZero).add(amount);
      }
    }
    return acc;
  }, {});
}

export function getEvmBinanceRebalanceLookupAccounts(addresses: string[], signerAddress?: string): EvmAddress[] {
  const seenAddresses = new Set<string>();
  return [...addresses, signerAddress]
    .filter(isDefined)
    .filter((address) => ethers.utils.isAddress(address))
    .map((address) => EvmAddress.from(address))
    .filter((address) => {
      const normalizedAddress = address.toNative();
      if (seenAddresses.has(normalizedAddress)) {
        return false;
      }
      seenAddresses.add(normalizedAddress);
      return true;
    });
}
