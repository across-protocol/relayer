import { BigNumber, bnZero, winston, DefaultLogLevels, AnyObject, Address, EvmAddress } from "../../utils";
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
    address: Address,
    chainId: number,
    l1Token: EvmAddress,
    l2Token?: Address
  ): BigNumber {
    const transfers = this.outstandingCrossChainTransfers[chainId]?.[address.toNative()]?.[l1Token.toNative()];
    if (!transfers) {
      return bnZero;
    }

    if (l2Token) {
      return transfers[l2Token.toNative()]?.totalAmount ?? bnZero;
    }

    // No specific l2Token specified; return the sum of all l1Token transfers to chainId.
    return Object.values(transfers).reduce((acc, { totalAmount }) => acc.add(totalAmount), bnZero);
  }

  getOutstandingCrossChainTransferTxs(
    address: Address,
    chainId: number,
    l1Token: EvmAddress,
    l2Token?: Address
  ): string[] {
    const transfers = this.outstandingCrossChainTransfers[chainId]?.[address.toNative()]?.[l1Token.toEvmAddress()];
    if (!transfers) {
      return [];
    }

    if (l2Token) {
      return transfers[l2Token.toNative()]?.depositTxHashes ?? [];
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
    address: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    rebalance: BigNumber,
    chainId: number
  ): void {
    const transfers = (this.outstandingCrossChainTransfers[chainId] ??= {});
    transfers[address.toNative()] ??= {};
    transfers[address.toNative()][l1Token.toEvmAddress()] ??= {};
    transfers[address.toNative()][l1Token.toEvmAddress()][l2Token.toNative()] ??= {
      totalAmount: bnZero,
      depositTxHashes: [],
    };

    // TODO: Require a tx hash here so we can track it as well.
    transfers[address.toNative()][l1Token.toEvmAddress()][l2Token.toNative()].totalAmount =
      this.getOutstandingCrossChainTransferAmount(address, chainId, l1Token, l2Token).add(rebalance);
  }

  async update(l1Tokens: EvmAddress[], chainIds = this.getEnabledL2Chains()): Promise<void> {
    const enabledChainIds = this.getEnabledL2Chains();
    chainIds = chainIds.filter((chainId) => enabledChainIds.includes(chainId));
    if (chainIds.length === 0) {
      return;
    }

    // Per-chain isolation: a transient adapter outage must not crash the inventory update. For
    // failed chains we preserve the previously-recorded state instead of blanking it — stale state
    // biases the InventoryClient toward under-rebalancing (safer) rather than duplicate-bridging.
    // The map callback is async so that synchronous throws from getOutstandingCrossChainTransfers
    // (e.g. missing adapter, getTokenInfo failure) surface as rejected promises rather than
    // aborting the chainIds.map call before Promise.allSettled sees them. We also forward the
    // previously-recorded chain state so the adapter can preserve per-(address, l1Token) entries
    // when a single bridge read fails.
    const settled = await Promise.allSettled(
      chainIds.map(async (chainId) =>
        this.adapterManager.getOutstandingCrossChainTransfers(
          chainId,
          l1Tokens,
          this.outstandingCrossChainTransfers[chainId]
        )
      )
    );
    const failedChainIds: number[] = [];
    settled.forEach((result, i) => {
      const chainId = chainIds[i];
      if (result.status === "fulfilled") {
        this.outstandingCrossChainTransfers[chainId] = result.value;
      } else {
        failedChainIds.push(chainId);
        this.log(
          `Failed to fetch outstanding cross chain transfers for chain ${chainId}; preserving stale state`,
          { chainId, error: String(result.reason) },
          "error"
        );
      }
    });
    this.log("Updated cross chain transfers", {
      outstandingCrossChainTransfers: this.outstandingCrossChainTransfers,
      ...(failedChainIds.length > 0 ? { failedChainIds } : {}),
    });
  }

  log(message: string, data?: AnyObject, level: DefaultLogLevels = "debug"): void {
    if (this.logger) {
      this.logger[level]({ at: "CrossChainTransferClient", message, ...data });
    }
  }
}
