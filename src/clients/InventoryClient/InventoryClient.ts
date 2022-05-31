import { BigNumber, winston, assign, toBN, getNetworkName, createFormatFunction } from "../../utils";
import { HubPoolClient, TokenClient } from "..";
import { InventoryConfig } from "../../interfaces";
import { SpokePoolClient } from "../";
import { AdapterManager } from "./AdapterManager";
import { string } from "hardhat/internal/core/params/argumentTypes";

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

  getCumulativeBalance(l1Token: string): BigNumber {
    return this.getEnabledChains()
      .map((chainId) => this.getBalanceOnChainForL1Token(chainId, l1Token))
      .reduce((acc, curr) => acc.add(curr), toBN(0));
  }

  getBalanceOnChainForL1Token(chainId: number | string, l1Token: string): BigNumber {
    chainId = Number(chainId);
    const balance =
      this.tokenClient.getBalance(chainId, this.hubPoolClient.getDestinationTokenForL1Token(l1Token, chainId)) ||
      toBN(0); // If the chain does not have this token (EG BOBA on Optimism) then 0.

    // Consider any L1->L2 transfers that are currently pending in the canonical bridge.
    return balance.add(this.getOutstandingCrossChainTransferAmount(chainId, l1Token));
  }

  getOutstandingCrossChainTransferAmount(chainId: number | string, l1Token: string) {
    return this.outstandingCrossChainTransfers[chainId.toString()]?.[l1Token] || toBN(0);
  }

  getChainDistribution(l1Token: string): { [chainId: number]: BigNumber } {
    const cumulativeBalance = this.getCumulativeBalance(l1Token);
    const distribution = {};
    this.getEnabledChains().forEach((chainId) => {
      if (cumulativeBalance.gt(0))
        distribution[chainId] = this.getBalanceOnChainForL1Token(chainId, l1Token).mul(scalar).div(cumulativeBalance);
    });
    return distribution;
  }

  getTokenDistributionPerL1Token(): { [l1Token: string]: { [chainId: number]: BigNumber } } {
    const distributionPerL1Token = {};
    this.getL1Tokens().forEach((l1Token) => (distributionPerL1Token[l1Token] = this.getChainDistribution(l1Token)));
    return distributionPerL1Token;
  }

  getCurrentAllocationPctConsideringShortfall(l1Token: string, chainId: number): BigNumber {
    const currentAllocationPct = this.getTokenDistributionPerL1Token()[l1Token][chainId];
    const shortfall = this.tokenClient.getTokensNeededToCoverShortfall(
      chainId,
      this.hubPoolClient.getDestinationTokenForL1Token(l1Token, chainId)
    );
    const shortfallPct = shortfall.mul(scalar).div(this.getCumulativeBalance(l1Token));
    return currentAllocationPct.sub(shortfallPct);
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

  determineRefundChainId(deposit) {}

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
          this.tokenClient.decrementLocalBalance(1, l1Token, requiredRebalance);
        }
      }
    }

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
          balanceOnChain: formatter(this.getBalanceOnChainForL1Token(chainId, l1Token).toString()),
          proRataShare: formatWei(tokenDistributionPerL1Token[l1Token][chainId].mul(100).toString()) + "%",
          inflightTokens: formatter(this.getOutstandingCrossChainTransferAmount(l1Token, chainId)).toString(),
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
