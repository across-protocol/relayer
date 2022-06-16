import { BigNumber, winston, assign, toBN, getNetworkName, createFormatFunction, etherscanLink } from "../../utils";
import { HubPoolClient, TokenClient, BundleDataClient } from "..";
import { InventoryConfig } from "../../interfaces";
import { AdapterManager } from "./AdapterManager";
import { Deposit } from "../../interfaces/SpokePool";

const scalar = toBN(10).pow(18);
const formatWei = createFormatFunction(2, 4, false, 18);

export class InventoryClient {
  private outstandingCrossChainTransfers: { [chainId: number]: { [l1Token: string]: BigNumber } } = {};
  private logDisabledManagement = false;

  constructor(
    readonly relayer: string,
    readonly logger: winston.Logger,
    readonly inventoryConfig: InventoryConfig,
    readonly tokenClient: TokenClient,
    readonly chainIdList: number[],
    readonly hubPoolClient: HubPoolClient,
    readonly bundleDataClient: BundleDataClient,
    readonly adapterManager: AdapterManager
  ) {}

  // Get the total balance across all chains, considering any outstanding cross chain transfers as a virtual balance on that chain.
  getCumulativeBalance(l1Token: string): BigNumber {
    return this.getEnabledChains()
      .map((chainId) => this.getBalanceOnChainForL1Token(chainId, l1Token))
      .reduce((acc, curr) => acc.add(curr), toBN(0));
  }

  // Get the balance of a given l1 token on a target chain, considering any outstanding cross chain transfers as a virtual balance on that chain.
  getBalanceOnChainForL1Token(chainId: number | string, l1Token: string): BigNumber {
    chainId = Number(chainId);
    // If the chain does not have this token (EG BOBA on Optimism) then 0.
    const balance =
      this.tokenClient.getBalance(chainId, this.getDestinationTokenForL1Token(l1Token, chainId)) || toBN(0);

    // Consider any L1->L2 transfers that are currently pending in the canonical bridge.
    return balance.add(this.getOutstandingCrossChainTransferAmount(chainId, l1Token));
  }

  // Get any funds currently in the canonical bridge.
  getOutstandingCrossChainTransferAmount(chainId: number | string, l1Token: string) {
    return this.outstandingCrossChainTransfers[chainId.toString()]?.[l1Token] || toBN(0);
  }

  // Get the fraction of funds allocated on each chain.
  getChainDistribution(l1Token: string): { [chainId: number]: BigNumber } {
    const cumulativeBalance = this.getCumulativeBalance(l1Token);
    const distribution = {};
    this.getEnabledChains().forEach((chainId) => {
      if (cumulativeBalance.gt(0))
        distribution[chainId] = this.getBalanceOnChainForL1Token(chainId, l1Token).mul(scalar).div(cumulativeBalance);
    });
    return distribution;
  }

  // Get the distribution of all tokens, spread over all chains.
  getTokenDistributionPerL1Token(): { [l1Token: string]: { [chainId: number]: BigNumber } } {
    const distributionPerL1Token = {};
    this.getL1Tokens().forEach((l1Token) => (distributionPerL1Token[l1Token] = this.getChainDistribution(l1Token)));
    return distributionPerL1Token;
  }

  // Get the balance of a given token on a given chain, including any pending cross chain transfers and upcoming refunds
  getCurrentAllocationPctConsideringRefunds(l1Token: string, chainId: number): BigNumber {
    const totalRefundsPerChain = this.getBundleRefunds(l1Token);
    const cumulativeRefunds = Object.values(totalRefundsPerChain).reduce((acc, curr) => acc.add(curr), toBN(0));
    // If there is nothing over all chains, return early.
    const cumulativeBalance = this.getCumulativeBalance(l1Token).add(cumulativeRefunds);
    if (cumulativeBalance.eq(0)) return toBN(0);

    const currentBalanceWithTransfersAndRefunds = this.getBalanceOnChainForL1Token(chainId, l1Token).add(totalRefundsPerChain[chainId]);
    // Multiply by scalar to avoid rounding errors.
    return currentBalanceWithTransfersAndRefunds.mul(scalar).div(cumulativeBalance);
  }

  // Find how short a given chain is for a desired L1Token.
  getTokenShortFall(l1Token: string, chainId: number | string): BigNumber {
    return this.tokenClient.getShortfallTotalRequirement(chainId, this.getDestinationTokenForL1Token(l1Token, chainId));
  }

  getDestinationTokenForL1Token(l1Token: string, chainId: number | string): string {
    return this.hubPoolClient.getDestinationTokenForL1Token(l1Token, Number(chainId));
  }

  getEnabledChains(): number[] {
    return this.chainIdList;
  }

  getEnabledL2Chains(): number[] {
    return this.getEnabledChains().filter((chainId) => chainId !== 1);
  }

  getL1Tokens(): string[] {
    return (
      Object.keys(this.inventoryConfig.tokenConfig) ||
      this.hubPoolClient.getL1Tokens().map((l1Token) => l1Token.address)
    );
  }

  // Decrement Tokens Balance And Increment Cross Chain Transfer
  trackCrossChainTransfer(l1Token: string, rebalance: BigNumber, chainId: number | string) {
    this.tokenClient.decrementLocalBalance(1, l1Token, rebalance);
    if (!this.outstandingCrossChainTransfers[chainId]) this.outstandingCrossChainTransfers[chainId] = {};
    const bal = this.outstandingCrossChainTransfers[chainId][l1Token];
    this.outstandingCrossChainTransfers[chainId][l1Token] = toBN(bal).gt(toBN(0))
      ? toBN(bal).sub(rebalance)
      : rebalance;
  }

  // Return the upcoming refunds (in pending and next bundles) on each chain.
  getBundleRefunds(l1Token: string) {
    const pendingBundleRefunds = this.bundleDataClient.getPendingBundleRefunds();
    const nextBundleRefunds = this.bundleDataClient.getNextBundleRefunds();
    return Object.fromEntries(
      this.getEnabledChains()
        .map((chainId) => [this.getDestinationTokenForL1Token(l1Token, chainId), chainId])
        .map(([tokenId, chainId]) => [
          chainId,
          this.bundleDataClient
            .getRefundsFor(pendingBundleRefunds, this.relayer, Number(chainId), String(tokenId))
            .add(
              this.bundleDataClient.getRefundsFor(nextBundleRefunds, this.relayer, Number(chainId), String(tokenId))
            ),
        ])
    );
  }

  // Work out where a relay should be refunded to optimally manage the bots inventory. If the inventory management logic
  // not enabled then return funds on the chain the deposit was filled on Else, use the following algorithm:
  // a) Find the chain virtual balance (current balance + pending relays + pending refunds) minus current shortfall.
  // b) Find the cumulative virtual balance, including the total refunds on all chains and excluding current shortfall.
  // c) Consider the size of a and b post relay (i.e after the relay is paid and all current transfers are settled what
  // will the balances be on the target chain and the overall cumulative balance).
  // d) Use c to compute what the post relay post current in-flight transactions allocation would be. Compare this
  // number to the target threshold and:
  //     If this number of more than the target for the designation chain + rebalance overshoot then refund on L1.
  //     Else, the post fill amount is within the target, so refund on the destination chain.
  determineRefundChainId(deposit: Deposit): number {
    const destinationChainId = deposit.destinationChainId;
    if (!this.isInventoryManagementEnabled()) return destinationChainId;
    if (destinationChainId === 1) return 1; // Always refund on L1 if the transfer is to L1.
    const l1Token = this.hubPoolClient.getL1TokenForDeposit(deposit);

    // If there is no inventory config for this token or this token and destination chain the return the destination chain.
    if (
      this.inventoryConfig.tokenConfig[l1Token] === undefined ||
      this.inventoryConfig.tokenConfig?.[l1Token]?.[destinationChainId] === undefined
    )
      return destinationChainId;
    const chainShortfall = this.getTokenShortFall(l1Token, destinationChainId);
    const chainVirtualBalance = this.getBalanceOnChainForL1Token(destinationChainId, l1Token);
    const chainVirtualBalanceWithShortfall = chainVirtualBalance.sub(chainShortfall);
    let chainVirtualBalanceWithShortfallPostRelay = chainVirtualBalanceWithShortfall.sub(deposit.amount);
    const cumulativeVirtualBalance = this.getCumulativeBalance(l1Token);
    let cumulativeVirtualBalanceWithShortfall = cumulativeVirtualBalance.sub(chainShortfall);

    // Consider any refunds from both current pending bundle (if any) and the next bundle.
    const totalRefundsPerChain = this.getBundleRefunds(l1Token);

    // Add upcoming refunds going to this destination chain.
    chainVirtualBalanceWithShortfallPostRelay = chainVirtualBalanceWithShortfallPostRelay.add(
      totalRefundsPerChain[destinationChainId]
    );
    // To correctly compute the allocation % for this destination chain, we need to add all upcoming refunds for the
    // equivalents of l1Token on all chains.
    const cumulativeRefunds = Object.values(totalRefundsPerChain).reduce((acc, curr) => acc.add(curr), toBN(0));
    cumulativeVirtualBalanceWithShortfall = cumulativeVirtualBalanceWithShortfall.add(cumulativeRefunds);

    const cumulativeVirtualBalanceWithShortfallPostRelay = cumulativeVirtualBalanceWithShortfall.sub(deposit.amount);
    // Compute what the balance will be on the target chain, considering this relay and the finalization of the
    // transfers that are currently flowing through the canonical bridge.
    const expectedPostRelayAllocation = chainVirtualBalanceWithShortfallPostRelay
      .mul(scalar)
      .div(cumulativeVirtualBalanceWithShortfallPostRelay);

    // If the post relay allocation, considering funds in transit, is larger than the target threshold then refund on L1
    // Else, refund on destination chian to keep funds within the target.
    const targetPct = toBN(this.inventoryConfig.tokenConfig[l1Token][destinationChainId].targetPct);
    const refundChainId = expectedPostRelayAllocation.gt(targetPct) ? 1 : destinationChainId;

    this.log("Evaluated refund Chain", {
      chainShortfall,
      chainVirtualBalance,
      chainVirtualBalanceWithShortfall,
      chainVirtualBalanceWithShortfallPostRelay,
      cumulativeVirtualBalance,
      cumulativeVirtualBalanceWithShortfall,
      cumulativeVirtualBalanceWithShortfallPostRelay,
      targetPct,
      expectedPostRelayAllocation,
      refundChainId,
    });
    // If the allocation is greater than the target then refund on L1. Else, refund on destination chain.
    return refundChainId;
  }

  // A rebalance is triggered in the follow 2 cases:
  // 1. The allocation is not below target when considering upcoming refunds, but there's a shortfall. We'll send the
  // entire shortfall amount to cover the deposit in timely manner. This amount likely will get refunded on L1 later on.
  // Example: Current balance on Polygon is 5 WETH, there's an unfilled deposit (shortfall) of 10 WETH. We'll send
  // 10 WETH from L1 over to cover the shortfall. This 10 WETH later will get refunded on L1 directly.
  // 2. Allocation is below target. This in theory should almost never happen unless we manually move funds away from
  // the L2 chain or if we increase the allocation targets.
  async rebalanceInventoryIfNeeded() {
    const rebalancesRequired: { [chainId: number]: { [l1Token: string]: BigNumber } } = {};
    const possibleRebalances: { [chainId: number]: { [l1Token: string]: BigNumber } } = {};
    const unexecutedRebalances: { [chainId: number]: { [l1Token: string]: BigNumber } } = {};
    const executedTransactions: { [chainId: number]: { [l1Token: string]: string } } = {};
    try {
      if (!this.isInventoryManagementEnabled()) return;
      const tokenDistributionPerL1Token = this.getTokenDistributionPerL1Token();
      this.constructConsideringRebalanceDebugLog(tokenDistributionPerL1Token);

      // First, compute the rebalances that we would do assuming we have sufficient tokens on L1.
      for (const l1Token of Object.keys(tokenDistributionPerL1Token)) {
        const cumulativeBalance = this.getCumulativeBalance(l1Token);
        if (cumulativeBalance.eq(0)) continue;

        for (const chainId of this.getEnabledL2Chains()) {
          const shortfall = this.getTokenShortFall(l1Token, chainId) || toBN(0);
          // Rebalance if there's a shortfall (for good UX) or if allocation is below target.
          if (shortfall.gt(toBN(0))) {
            assign(rebalancesRequired, [chainId, l1Token], shortfall);
          } else {
            const currentAllocPct = this.getCurrentAllocationPctConsideringRefunds(l1Token, chainId);
            const thresholdPct = toBN(this.inventoryConfig.tokenConfig[l1Token][chainId].thresholdPct);
            if (currentAllocPct.lt(thresholdPct)) {
              const deltaPct = toBN(this.inventoryConfig.tokenConfig[l1Token][chainId].targetPct).sub(currentAllocPct);
              // Divide by scalar because allocation percent was multiplied by it to avoid rounding errors.
              assign(rebalancesRequired, [chainId, l1Token], deltaPct.mul(cumulativeBalance).div(scalar));
            }
          }
        }
      }

      if (Object.keys(rebalancesRequired).length == 0) {
        this.log("No rebalances required");
        return;
      }

      // Next, evaluate if we have enough tokens on L1 to actually do these rebalances.
      for (const chainId of Object.keys(rebalancesRequired)) {
        for (const l1Token of Object.keys(rebalancesRequired[chainId])) {
          const requiredRebalance = rebalancesRequired[chainId][l1Token];
          // If the amount required in the rebalance is less than the total amount of this token on L1 then we can execute
          // the rebalance to this particular chain. Note that if the sum of all rebalances required exceeds the l1
          // balance then this logic ensures that we only fill the first n number of chains where we can.
          if (requiredRebalance.lt(this.tokenClient.getBalance(1, l1Token))) {
            assign(possibleRebalances, [chainId, l1Token], requiredRebalance);
            // Decrement token balance in client for this chain and increment cross chain counter.
            this.trackCrossChainTransfer(l1Token, requiredRebalance, chainId);
          }
        }
      }

      // Extract unexecutable rebalances for logging.
      for (const chainId of Object.keys(rebalancesRequired)) {
        for (const l1Token of Object.keys(rebalancesRequired[chainId])) {
          if (!possibleRebalances[chainId] || !possibleRebalances[chainId][l1Token]) {
            assign(unexecutedRebalances, [chainId, l1Token], rebalancesRequired[chainId][l1Token]);
          }
        }
      }
      this.log("Considered inventory rebalances", { rebalancesRequired, possibleRebalances });

      // Finally, execute the rebalances.
      // TODO: The logic below is slow as it waits for each transaction to be included before sending the next one. This
      // should be refactored to enable us to pass an array of transaction objects to the transaction util that then
      // sends each transaction one after the other with incrementing nonce. this will be left for a follow on PR as this
      // is already complex logic and most of the time we'll not be sending batches of rebalance transactions.
      for (const chainId of Object.keys(possibleRebalances)) {
        for (const l1Token of Object.keys(possibleRebalances[chainId])) {
          const receipt = await this.sendTokenCrossChain(chainId, l1Token, possibleRebalances[chainId][l1Token]);
          assign(executedTransactions, [chainId, l1Token], receipt.transactionHash);
        }
      }

      // Construct logs on the cross-chain actions executed.
      let mrkdwn = "";

      for (const chainId of Object.keys(possibleRebalances)) {
        mrkdwn += `*Rebalances sent to ${getNetworkName(chainId)}:*\n`;
        for (const l1Token of Object.keys(possibleRebalances[chainId])) {
          const { symbol, decimals } = this.hubPoolClient.getTokenInfoForL1Token(l1Token);
          const { targetPct, thresholdPct } = this.inventoryConfig.tokenConfig[l1Token][chainId];
          const formatter = createFormatFunction(2, 4, false, decimals);
          mrkdwn +=
            ` - ${formatter(
              possibleRebalances[chainId][l1Token]
            )} ${symbol} rebalanced. This meets target allocation of ` +
            `${formatWei(toBN(targetPct).mul(100).toString())}% (trigger of ` +
            `${formatWei(toBN(thresholdPct).mul(100).toString())}%) of the total ` +
            `${formatter(
              this.getCumulativeBalance(l1Token).toString()
            )} ${symbol} over all chains (ignoring hubpool repayments). This chain has a shortfall of ` +
            `${formatter(this.getTokenShortFall(l1Token, chainId).toString())} ${symbol} ` +
            `tx: ${etherscanLink(executedTransactions[chainId][l1Token], 1)}\n`;
        }
      }

      for (const chainId of Object.keys(unexecutedRebalances)) {
        mrkdwn += `*Insufficientst amount to rebalance to ${getNetworkName(chainId)}:*\n`;
        for (const l1Token of Object.keys(unexecutedRebalances[chainId])) {
          const { symbol, decimals } = this.hubPoolClient.getTokenInfoForL1Token(l1Token);
          const formatter = createFormatFunction(2, 4, false, decimals);
          mrkdwn +=
            `- ${symbol} transfer blocked. Required to send ` +
            `${formatter(unexecutedRebalances[chainId][l1Token])} but relayer has ` +
            `${formatter(this.tokenClient.getBalance(1, l1Token))} on L1. There is currently ` +
            `${formatter(this.getBalanceOnChainForL1Token(chainId, l1Token).toString())} ${symbol} on ` +
            `${getNetworkName(chainId)} which is ` +
            `${formatWei(tokenDistributionPerL1Token[l1Token][chainId].mul(100))}% of the total ` +
            `${formatter(this.getCumulativeBalance(l1Token).toString())} ${symbol}.` +
            ` This chain's pending L1->L2 transfer amount is ` +
            `${formatter(this.getOutstandingCrossChainTransferAmount(chainId, l1Token).toString())}.\n`;
        }
      }

      if (mrkdwn) this.log("Executed Inventory rebalances 📒", { mrkdwn }, "info");
    } catch (error) {
      this.log(
        "Something errored during inventory rebalance",
        { error, rebalancesRequired, possibleRebalances, unexecutedRebalances, executedTransactions }, // include all info to help debugging.
        "error"
      );
    }
  }

  constructConsideringRebalanceDebugLog(tokenDistributionPerL1Token: {
    [l1Token: string]: { [chainId: number]: BigNumber };
  }) {
    const tokenDistribution = {};
    Object.keys(tokenDistributionPerL1Token).forEach((l1Token) => {
      const { symbol, decimals } = this.hubPoolClient.getTokenInfoForL1Token(l1Token);
      if (!tokenDistribution[symbol]) tokenDistribution[symbol] = {};
      const formatter = createFormatFunction(2, 4, false, decimals);
      tokenDistribution[symbol].cumulativeBalance = formatter(this.getCumulativeBalance(l1Token).toString());
      Object.keys(tokenDistributionPerL1Token[l1Token]).forEach((chainId) => {
        if (!tokenDistribution[symbol][chainId]) tokenDistribution[symbol][chainId] = {};

        tokenDistribution[symbol][chainId] = {
          actualBalanceOnChain: formatter(
            this.getBalanceOnChainForL1Token(chainId, l1Token)
              .sub(this.getOutstandingCrossChainTransferAmount(chainId, l1Token))
              .toString()
          ),
          virtualBalanceOnChain: formatter(this.getBalanceOnChainForL1Token(chainId, l1Token).toString()),
          outstandingTransfers: formatter(this.getOutstandingCrossChainTransferAmount(chainId, l1Token)).toString(),
          tokenShortFalls: formatter(this.getTokenShortFall(l1Token, chainId).toString()),
          proRataShare: formatWei(tokenDistributionPerL1Token[l1Token][chainId].mul(100).toString()) + "%",
        };
      });
    });

    this.log("Considering rebalance", { tokenDistribution, inventoryConfig: this.inventoryConfig });
  }

  async sendTokenCrossChain(chainId: number | string, l1Token: string, amount: BigNumber) {
    return await this.adapterManager.sendTokenCrossChain(Number(chainId), l1Token, amount);
  }

  async setL1TokenApprovals() {
    if (!this.isInventoryManagementEnabled()) return;
    const l1Tokens = this.getL1Tokens();
    this.log("Checking token approvals", { l1Tokens });
    await this.adapterManager.setL1TokenApprovals(l1Tokens);
  }

  async wrapL2EthIfAboveThreshold() {
    if (!this.isInventoryManagementEnabled()) return;
    this.log("Checking ETH->WETH Wrap status");
    await this.adapterManager.wrapEthIfAboveThreshold(this.inventoryConfig.wrapEtherThreshold);
  }

  async update() {
    if (!this.isInventoryManagementEnabled()) return;
    const monitoredChains = this.getEnabledL2Chains(); // Use all chainIds except L1.
    this.log("Updating inventory information", { monitoredChains });

    const outstandingTransfersPerChain = await Promise.all(
      monitoredChains.map((chainId) =>
        this.adapterManager.getOutstandingCrossChainTokenTransferAmount(chainId, this.getL1Tokens())
      )
    );
    outstandingTransfersPerChain.forEach((outstandingTransfers, index) => {
      assign(this.outstandingCrossChainTransfers, [monitoredChains[index]], outstandingTransfers);
    });

    this.log("Updated inventory information", { outstandingCrossChainTransfers: this.outstandingCrossChainTransfers });
  }

  isInventoryManagementEnabled() {
    if (this?.inventoryConfig?.tokenConfig) return true;
    // Use logDisabledManagement to avoid spamming the logs on every check if this module is enabled.
    else if (this.logDisabledManagement == false) this.log("Inventory Management Disabled");
    this.logDisabledManagement = true;
    return false;
  }

  log(message: string, data?: any, level: string = "debug") {
    if (this.logger) this.logger[level]({ at: "InventoryClient", message, ...data });
  }
}
