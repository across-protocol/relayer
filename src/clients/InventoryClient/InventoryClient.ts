import { BigNumber, winston, assign, toBN, getNetworkName, createFormatFunction } from "../../utils";
import { HubPoolClient, TokenClient } from "..";
import { InventoryConfig } from "../../interfaces";
import { AdapterManager } from "./AdapterManager";
import { Deposit } from "../../interfaces/SpokePool";

const scalar = toBN(10).pow(18);
const formatWei = createFormatFunction(2, 4, false, 18);

export class InventoryClient {
  private outstandingCrossChainTransfers: { [chainId: number]: { [l1Token: string]: BigNumber } } = {};
  private logDisabledManagement = false;

  constructor(
    readonly logger: winston.Logger,
    readonly inventoryConfig: InventoryConfig,
    readonly tokenClient: TokenClient,
    readonly chainIdList: number[],
    readonly hubPoolClient: HubPoolClient,
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

  // Get the allocation of a given token, considering the shortfall. This number will be negative if there is a shortfall!
  // A shortfall, by definition, is the amount of tokens that are needed to to fill a given outstanding relay that the
  // relayer could not fill. For example of the relayer has 10 WETH and needs to fill a relay of size 18 WETH then the
  // shortfall will be 18. If there are 140 WETH across the whole ecosystem then this method will return (10-18)/140=-0.057
  // This number is then used to inform how many tokens need to be sent to the chain to: a) cover the shortfall and
  // b bring the balance back over the defined target.
  getCurrentAllocationPctConsideringShortfall(l1Token: string, chainId: number): BigNumber {
    const currentBalanceConsideringTransfers = this.getBalanceOnChainForL1Token(chainId, l1Token);
    const shortfall = this.getTokenShortFall(l1Token, chainId) || toBN(0);
    const cumulativeBalance = this.getCumulativeBalance(l1Token);
    const numerator = currentBalanceConsideringTransfers.sub(shortfall).mul(scalar);
    return numerator.div(cumulativeBalance);
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
    return this.inventoryConfig.managedL1Tokens || this.hubPoolClient.getL1Tokens().map((l1Token) => l1Token.address);
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

  // Work out where a relay should be refunded to optimally manage the bots inventory. Use the following algorithm:
  // a) Compute the virtual balance on the destination chain. This is current liquidity + any pending cross-chain transfers.
  // b) Compute the virtual balance post relay on destination chain. i.e the size of the relay in question.
  // c) Find the post relay virtual allocation by taking b and dividing it by the cumulative virtual balance. This number
  // represents the share of the total liquidity if the current transfers conclude and the relay is filled (i.e forward looking)
  // e) Decide on what chain to repay on: If this number of more than the target for the designation chain + the rebalance overshoot // then refund on L1. Else, the post fill amount is within the target, so refund on the destination chain.
  determineRefundChainId(deposit: Deposit): number {
    const l1Token = this.hubPoolClient.getL1TokenForDeposit(deposit);
    const chainShortfall = this.getTokenShortFall(l1Token, deposit.destinationChainId);
    const chainVirtualBalance = this.getBalanceOnChainForL1Token(deposit.destinationChainId, l1Token);
    const chainVirtualBalanceWithShortfall = chainVirtualBalance.sub(chainShortfall);
    const chainVirtualBalanceWithShortfallPostRelay = chainVirtualBalanceWithShortfall.sub(deposit.amount);
    const cumulativeVirtualBalance = this.getCumulativeBalance(l1Token);
    const cumulativeVirtualBalanceWithShortfall = cumulativeVirtualBalance.sub(chainShortfall);

    const cumulativeVirtualBalanceWithShortfallPostRelay = cumulativeVirtualBalanceWithShortfall.sub(deposit.amount);
    // Compute what the balance will be on the target chain, considering this relay and the finalization of the
    // transfers that are currently flowing through the canonical bridge.
    const expectedPostRelayAllocation = chainVirtualBalanceWithShortfallPostRelay
      .mul(scalar)
      .div(cumulativeVirtualBalanceWithShortfallPostRelay);

    const allocationThreshold = this.inventoryConfig.targetL2PctOfTotal[deposit.destinationChainId];
    this.log("Evaluated refund Chain", {
      chainShortfall,
      chainVirtualBalance,
      chainVirtualBalanceWithShortfall,
      chainVirtualBalanceWithShortfallPostRelay,
      cumulativeVirtualBalance,
      cumulativeVirtualBalanceWithShortfall,
      cumulativeVirtualBalanceWithShortfallPostRelay,
      allocationThreshold,
      expectedPostRelayAllocation,
    });
    // If the allocation is greater than the target then refund on L1. Else, refund on destination chain.
    if (expectedPostRelayAllocation.gt(allocationThreshold)) return 1;
    else return deposit.destinationChainId;
  }

  async rebalanceInventoryIfNeeded() {
    if (!this.isfInventoryManagementEnabled()) return;
    const tokenDistributionPerL1Token = this.getTokenDistributionPerL1Token();
    this.constructConsideringRebalanceDebugLog(tokenDistributionPerL1Token);

    // First, compute the rebalances that we would do assuming we have sufficient tokens on L1.
    const rebalancesRequired: { [chainId: number]: { [l1Token: string]: BigNumber } } = {};
    for (const l1Token of Object.keys(tokenDistributionPerL1Token)) {
      const cumulativeBalance = this.getCumulativeBalance(l1Token);
      for (const chainId of this.getEnabledL2Chains()) {
        const currentAllocationPct = this.getCurrentAllocationPctConsideringShortfall(l1Token, chainId);
        const targetAllocationPct = toBN(this.inventoryConfig.targetL2PctOfTotal[chainId]);
        if (currentAllocationPct.lt(targetAllocationPct)) {
          if (!rebalancesRequired[chainId]) rebalancesRequired[chainId] = {};
          const deltaPct = targetAllocationPct.add(this.inventoryConfig.rebalanceOvershoot).sub(currentAllocationPct);

          rebalancesRequired[chainId][l1Token] = deltaPct.mul(cumulativeBalance).div(scalar);
        }
      }
    }
    if (Object.keys(rebalancesRequired).length == 0) {
      this.log("No rebalances required");
      return;
    }

    // Next, evaluate if we have enough tokens on L1 to actually do these rebalances.
    const possibleRebalances: { [chainId: number]: { [l1Token: string]: BigNumber } } = {};
    for (const chainId of Object.keys(rebalancesRequired)) {
      for (const l1Token of Object.keys(rebalancesRequired[chainId])) {
        const requiredRebalance = rebalancesRequired[chainId][l1Token];
        // If the amount required in the rebalance is less than the total amount of this token on L1 then we can execute
        // the rebalance to this particular chain. Note that if the sum of all rebalances required exceeds the l1
        // balance then this logic ensures that we only fill the first n number of chains where we can.
        if (requiredRebalance.lt(this.tokenClient.getBalance(1, l1Token))) {
          if (!possibleRebalances[chainId]) possibleRebalances[chainId] = {};
          possibleRebalances[chainId][l1Token] = requiredRebalance;

          // Decrement token balance in client for this chain and increment cross chain counter.
          this.trackCrossChainTransfer(l1Token, requiredRebalance, chainId);
        }
      }
    }

    // Extract unexecutable rebalances for logging.
    const unexecutedRebalances: { [chainId: number]: { [l1Token: string]: BigNumber } } = {};
    for (const chainId of Object.keys(rebalancesRequired)) {
      for (const l1Token of Object.keys(rebalancesRequired[chainId])) {
        if (!possibleRebalances[chainId] || !possibleRebalances[chainId][l1Token]) {
          if (!unexecutedRebalances[chainId]) unexecutedRebalances[chainId] = {};
          unexecutedRebalances[chainId][l1Token] = rebalancesRequired[chainId][l1Token];
        }
      }
    }

    // Finally, execute the rebalances.
    // TODO: The logic below is slow as it waits for each transaction to be included before sending the next one. This
    // should be refactored to enable us to pass an array of transaction objects to the transaction util that then
    // sends each transaction one after the other with incrementing nonce. this will be left for a follow on PR as this
    // is already complex logic and most of the time we'll not be sending batches of rebalance transactions.
    const executedTransactions: { [chainId: number]: { [l1Token: string]: string } } = {};
    for (const chainId of Object.keys(possibleRebalances)) {
      for (const l1Token of Object.keys(possibleRebalances[chainId])) {
        const receipt = await this.sendTokenCrossChain(chainId, l1Token, possibleRebalances[chainId][l1Token]);
        if (!executedTransactions[chainId]) executedTransactions[chainId] = {};
        executedTransactions[chainId][l1Token] = receipt.transactionHash;
      }
    }

    // Construct logs on the cross-chain actions executed.
    this.log("Considered inventory rebalances", { rebalancesRequired, possibleRebalances });
    let mrkdwn = "";

    if (possibleRebalances != {}) {
      for (const chainId of Object.keys(possibleRebalances)) {
        mrkdwn += `*Rebalances sent to ${getNetworkName(chainId)}:*\n`;
        for (const l1Token of Object.keys(possibleRebalances[chainId])) {
          const { symbol, decimals } = this.hubPoolClient.getTokenInfoForL1Token(l1Token);
          const formatter = createFormatFunction(2, 4, false, decimals);
          mrkdwn +=
            `${formatter(possibleRebalances[chainId][l1Token])} ${symbol} rebalanced. This represents the target` +
            ` allocation of ${formatWei(this.inventoryConfig.targetL2PctOfTotal[chainId].mul(100).toString())}% ` +
            `(plus the overshoot of ${formatWei(this.inventoryConfig.rebalanceOvershoot.mul(100).toString())}%) ` +
            `of the total ${formatter(this.getCumulativeBalance(l1Token).toString())} ${symbol} over all chains. ` +
            `tx: ${executedTransactions[chainId][l1Token]}\n`;
        }
      }
    }
    if (unexecutedRebalances != {}) {
      for (const chainId of Object.keys(unexecutedRebalances)) {
        mrkdwn += `*Insufficient amount to rebalance to ${getNetworkName(chainId)}:*\n`;
        for (const l1Token of Object.keys(unexecutedRebalances[chainId])) {
          const { symbol, decimals } = this.hubPoolClient.getTokenInfoForL1Token(l1Token);
          const formatter = createFormatFunction(2, 4, false, decimals);
          mrkdwn +=
            `- ${symbol} transfer blocked. Required to send ` +
            `${formatter(unexecutedRebalances[chainId][l1Token])} but relayer has ` +
            `${formatter(this.tokenClient.getBalance(1, l1Token))} on L1. There is currently ` +
            `${formatter(this.getBalanceOnChainForL1Token(chainId, l1Token).toString())} ${symbol} on ` +
            `${getNetworkName(chainId)} which is ` +
            `${formatWei(tokenDistributionPerL1Token[l1Token][chainId].mul(100))}% of the total ${symbol}.` +
            ` There is currently a pending L1->L2 transfer amount of ` +
            `${this.getOutstandingCrossChainTransferAmount(chainId, l1Token).toString()}.\n`;
        }
      }
    }

    if (mrkdwn) this.log("Executed Inventory rebalances 📒", { mrkdwn }, "info");
  }

  constructConsideringRebalanceDebugLog(tokenDistributionPerL1Token: {
    [l1Token: string]: { [chainId: number]: BigNumber };
  }) {
    let tokenDistribution = {};
    Object.keys(tokenDistributionPerL1Token).forEach((l1Token) => {
      const { symbol, decimals } = this.hubPoolClient.getTokenInfoForL1Token(l1Token);
      if (!tokenDistribution[symbol]) tokenDistribution[symbol] = {};
      const formatter = createFormatFunction(2, 4, false, decimals);
      tokenDistribution[symbol]["cumulativeBalance"] = formatter(this.getCumulativeBalance(l1Token).toString());
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

    let prettyConfig = { managedL1Tokens: [], targetL2PctOfTotal: {} };
    this.inventoryConfig.managedL1Tokens.forEach((l1Token) => {
      const { symbol } = this.hubPoolClient.getTokenInfoForL1Token(l1Token);
      prettyConfig.managedL1Tokens.push(symbol);
    });
    Object.keys(this.inventoryConfig.targetL2PctOfTotal).forEach((chainId) => {
      prettyConfig.targetL2PctOfTotal[chainId] =
        formatWei(toBN(this.inventoryConfig.targetL2PctOfTotal[chainId]).mul(100).toString()) + "%";
    });
    prettyConfig["rebalanceOvershoot"] =
      formatWei(toBN(this.inventoryConfig.rebalanceOvershoot).mul(100).toString()) + "%";
    prettyConfig["wrapEtherThreshold"] = formatWei(this.inventoryConfig.wrapEtherThreshold.toString()).toString();

    this.log("Considering rebalance", { tokenDistribution, inventoryConfig: prettyConfig });
  }

  async sendTokenCrossChain(chainId: number | string, l1Token: string, amount: BigNumber) {
    return await this.adapterManager.sendTokenCrossChain(Number(chainId), l1Token, amount);
  }

  async setL1TokenApprovals() {
    if (!this.isfInventoryManagementEnabled()) return;
    const l1Tokens = this.getL1Tokens();
    this.log("Checking token approvals", { l1Tokens });
    await this.adapterManager.setL1TokenApprovals(l1Tokens);
  }

  async wrapL2EthIfAboveThreshold() {
    if (!this.isfInventoryManagementEnabled()) return;
    this.log("Checking ETH->WETH Wrap status");
    await this.adapterManager.wrapEthIfAboveThreshold(this.inventoryConfig.wrapEtherThreshold);
  }

  async update() {
    if (!this.isfInventoryManagementEnabled()) return;
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

  isfInventoryManagementEnabled() {
    if (this.inventoryConfig.managedL1Tokens) return true;
    // Use logDisabledManagement to avoid spamming the logs on every check if this module is enabled.
    else if ((this.logDisabledManagement = false)) this.log("Inventory Management Disabled");
    this.logDisabledManagement = true;
    return false;
  }

  log(message: string, data?: any, level: string = "debug") {
    this.logger[level]({ at: "InventoryClient", message, ...data });
  }
}
