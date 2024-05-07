import { BigNumber, bnZero, winston, assign, toBN, DefaultLogLevels, AnyObject } from "../../utils";
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
  getOutstandingCrossChainTransferAmount(address: string, chainId: number | string, l1Token: string): BigNumber {
    const amount = this.outstandingCrossChainTransfers[Number(chainId)]?.[address]?.[l1Token]?.totalAmount;
    return amount ? toBN(amount) : bnZero;
  }

  getOutstandingCrossChainTransferTxs(address: string, chainId: number | string, l1Token: string): string[] {
    const txHashes = this.outstandingCrossChainTransfers[Number(chainId)]?.[address]?.[l1Token]?.depositTxHashes;
    return txHashes ? txHashes : [];
  }

  getEnabledChains(): number[] {
    return this.chainIdList;
  }

  getEnabledL2Chains(): number[] {
    return this.getEnabledChains().filter((chainId) => chainId !== 1);
  }

  increaseOutstandingTransfer(address: string, l1Token: string, rebalance: BigNumber, chainId: number): void {
    if (!this.outstandingCrossChainTransfers[chainId]) {
      this.outstandingCrossChainTransfers[chainId] = {};
    }
    const transfers = this.outstandingCrossChainTransfers[chainId];
    if (transfers[address] === undefined) {
      transfers[address] = {};
    }
    if (transfers[address][l1Token] === undefined) {
      transfers[address][l1Token] = {
        totalAmount: bnZero,
        depositTxHashes: [],
      };
    }

    // TODO: Require a tx hash here so we can track it as well.
    transfers[address][l1Token].totalAmount = this.getOutstandingCrossChainTransferAmount(
      address,
      chainId,
      l1Token
    ).add(rebalance);
  }

  async update(l1Tokens: string[]): Promise<void> {
    const monitoredChains = this.getEnabledL2Chains().filter((chainId) => chainId === 137); // Use all chainIds except L1.
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

  log(message: string, data?: AnyObject, level: DefaultLogLevels = "debug"): void {
    if (this.logger) {
      this.logger[level]({ at: "CrossChainTransferClient", message, ...data });
    }
  }
}
