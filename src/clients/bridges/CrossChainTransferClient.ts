import { BigNumber, bnZero, winston, DefaultLogLevels, AnyObject } from "../../utils";
import { AdapterManager } from "./AdapterManager";
import { OutstandingTransfers } from "../../interfaces";

export class CrossChainTransferClient {
  private outstandingCrossChainTransfers: { [chainId: number]: OutstandingTransfers } = {};

  constructor(
    readonly logger: winston.Logger,
    readonly chainIdList: number[],
    readonly adapterManager: AdapterManager
  ) {}

  // Get any funds currently in the canonical bridge.
  getOutstandingCrossChainTransferAmount(
    address: string,
    chainId: number | string,
    l1Token: string,
    l2Token?: string
  ): BigNumber {
    const transfers = this.outstandingCrossChainTransfers[Number(chainId)]?.[address]?.[l1Token];
    if (!transfers) {
      return bnZero;
    }

    if (l2Token) {
      return transfers[l2Token]?.totalAmount ?? bnZero;
    }

    // No specific l2Token specified; return the sum of all l1Token transfers to chainId.
    return Object.values(transfers).reduce((acc, { totalAmount }) => acc.add(totalAmount), bnZero);
  }

  getOutstandingCrossChainTransferTxs(
    address: string,
    chainId: number | string,
    l1Token: string,
    l2Token?: string
  ): string[] {
    const transfers = this.outstandingCrossChainTransfers[Number(chainId)]?.[address]?.[l1Token];
    if (!transfers) {
      return [];
    }

    if (l2Token) {
      return transfers[l2Token]?.depositTxHashes ?? [];
    }

    // No specific l2Token specified; return the set of all l1Token transfers to chainId.
    return Object.values(transfers).flatMap(({ depositTxHashes }) => depositTxHashes);
  }

  getEnabledChains(): number[] {
    return this.chainIdList;
  }

  getEnabledL2Chains(): number[] {
    return this.getEnabledChains().filter((chainId) => chainId !== 1);
  }

  increaseOutstandingTransfer(
    address: string,
    l1Token: string,
    l2Token: string,
    rebalance: BigNumber,
    chainId: number
  ): void {
    const transfers = (this.outstandingCrossChainTransfers[chainId] ??= {});
    transfers[address] ??= {};
    transfers[address][l1Token] ??= {};
    transfers[address][l1Token][l2Token] ??= { totalAmount: bnZero, depositTxHashes: [] };

    // TODO: Require a tx hash here so we can track it as well.
    transfers[address][l1Token][l2Token].totalAmount = this.getOutstandingCrossChainTransferAmount(
      address,
      chainId,
      l1Token,
      l2Token
    ).add(rebalance);
  }

  async update(l1Tokens: string[], chainIds = this.getEnabledL2Chains()): Promise<void> {
    const enabledChainIds = this.getEnabledL2Chains();
    chainIds = chainIds.filter((chainId) => enabledChainIds.includes(chainId));
    if (chainIds.length === 0) {
      return;
    }

    this.log("Updating cross chain transfers", { chainIds });

    const outstandingTransfersPerChain = await Promise.all(
      chainIds.map(async (chainId) => [
        chainId,
        await this.adapterManager.getOutstandingCrossChainTokenTransferAmount(chainId, l1Tokens),
      ])
    );
    this.outstandingCrossChainTransfers = Object.fromEntries(outstandingTransfersPerChain);
    this.log("Updated cross chain transfers", { outstandingCrossChainTransfers: this.outstandingCrossChainTransfers });
  }

  log(message: string, data?: AnyObject, level: DefaultLogLevels = "debug"): void {
    if (this.logger) {
      this.logger[level]({ at: "CrossChainTransferClient", message, ...data });
    }
  }
}
