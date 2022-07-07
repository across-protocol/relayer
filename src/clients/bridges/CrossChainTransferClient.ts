import { BigNumber, winston, assign, toBN } from "../../utils";
import { AdapterManager } from "./AdapterManager";

export class CrossChainTransferClient {
  private outstandingCrossChainTransfers: {
    [chainId: number]: { [address: string]: { [l1Token: string]: BigNumber } };
  } = {};

  constructor(
    readonly logger: winston.Logger,
    readonly chainIdList: number[],
    readonly adapterManager: AdapterManager
  ) {}

  // Get any funds currently in the canonical bridge.
  getOutstandingCrossChainTransferAmount(address: string, chainId: number | string, l1Token: string): BigNumber {
    const amount = this.outstandingCrossChainTransfers[Number(chainId)]?.[address]?.[l1Token];
    return amount ? toBN(amount) : toBN(0);
  }

  getEnabledChains(): number[] {
    return this.chainIdList;
  }

  getEnabledL2Chains(): number[] {
    return this.getEnabledChains().filter((chainId) => chainId !== 1);
  }

  increaseOutstandingTransfer(address: string, l1Token: string, rebalance: BigNumber, chainId: number) {
    if (!this.outstandingCrossChainTransfers[chainId]) {
      this.outstandingCrossChainTransfers[chainId] = {};
    }
    const transfers = this.outstandingCrossChainTransfers[chainId];
    if (!transfers[address]) {
      transfers[address] = {};
    }

    transfers[address][l1Token] = this.getOutstandingCrossChainTransferAmount(address, chainId, l1Token).add(rebalance);
  }

  async update(l1Tokens: string[]) {
    const monitoredChains = this.getEnabledL2Chains(); // Use all chainIds except L1.
    this.log("Updating cross chain transfers", { monitoredChains });

    const outstandingTransfersPerChain = await Promise.all(
      monitoredChains.map((chainId) =>
        this.adapterManager.getOutstandingCrossChainTokenTransferAmount(chainId, l1Tokens)
      )
    );
    outstandingTransfersPerChain.forEach((outstandingTransfers, index) => {
      assign(this.outstandingCrossChainTransfers, [monitoredChains[index]], outstandingTransfers);
    });

    this.log("Updated cross chain transfers", { outstandingCrossChainTransfers: this.outstandingCrossChainTransfers });
  }

  log(message: string, data?: any, level: string = "debug") {
    if (this.logger) this.logger[level]({ at: "CrossChainTransferClient", message, ...data });
  }
}
