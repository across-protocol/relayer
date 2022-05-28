import { BigNumber, winston, toWei, toBN, EventSearchConfig, assign } from "../../utils";
import { HubPoolClient, TokenClient } from "..";
import { InventoryConfig } from "../../interfaces";
import { SpokePoolClient } from "../";
import { AdapterManager } from "./AdapterManager";

const scalar = toBN(10).pow(18);

export class InventoryClient {
  adapterManager: AdapterManager;
  private outstandingCrossChainTransfers: { [chainId: number]: { [l1Token: string]: BigNumber } } = {};
  private logDisabledManagement = false;

  constructor(
    readonly logger: winston.Logger,
    readonly inventoryConfig: InventoryConfig,
    readonly tokenClient: TokenClient,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient,
    readonly relayerAddress: string
  ) {
    this.adapterManager = new AdapterManager(logger, spokePoolClients, hubPoolClient, relayerAddress);
  }

  getCumulativeBalance(l1Token: string): BigNumber {
    return this.getEnabledChains()
      .map((chainId) => this.getBalanceOnChainForL1Token(chainId, l1Token))
      .reduce((acc, curr) => acc.add(curr), toBN(0));
  }

  getBalanceOnChainForL1Token(chainId: number, l1Token: string): BigNumber {
    const balance =
      this.tokenClient.getBalance(chainId, this.hubPoolClient.getDestinationTokenForL1Token(l1Token, chainId)) ||
      toBN(0); // If the chain does not have this token (EG BOBA on Optimism) then 0.

    // Consider any L1->L2 transfers that are currently pending in the canonical bridge.
    return balance.add(this.outstandingCrossChainTransfers?.[chainId]?.[l1Token] || toBN(0));
  }

  getChainDistribution(l1Token: string): { [chainId: number]: BigNumber } {
    console.log("getting", l1Token);
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

  getEnabledChains(): number[] {
    return Object.keys(this.spokePoolClients).map((chainId) => parseInt(chainId));
  }

  getEnabledL2Chains(): number[] {
    return this.getEnabledChains().filter((chainId) => chainId !== 1);
  }

  getL1Tokens(): string[] {
    return this.inventoryConfig.managedL1Tokens || this.hubPoolClient.getL1Tokens().map((l1Token) => l1Token.address);
  }

  async rebalanceInventoryIfNeeded() {
    if (!this.isfInventoryManagementEnabled()) return;
    const tokenDistributionPerL1Token = this.getTokenDistributionPerL1Token();
    this.log("Considering rebalance", { tokenDistributionPerL1Token });

    // First, compute the rebalances that we would do assuming we have sufficient tokens on L1.
    const rebalancesRequired: { [chainId: number]: { [l1Token: string]: BigNumber } } = {};
    for (const l1Token of Object.keys(tokenDistributionPerL1Token)) {
      const cumulativeBalance = this.getCumulativeBalance(l1Token);
      for (const chainId of this.getEnabledL2Chains()) {
        const currentAllocationPct = toBN(tokenDistributionPerL1Token[l1Token][chainId]);
        const targetAllocationPct = toBN(this.inventoryConfig.targetL2PctOfTotal[chainId]);
        if (currentAllocationPct.lt(targetAllocationPct)) {
          if (!rebalancesRequired[chainId]) rebalancesRequired[chainId] = {};
          const deltaPct = targetAllocationPct.add(this.inventoryConfig.rebalanceOvershoot).sub(currentAllocationPct);
          // const tokenDecimalScalar = toBN(10).pow(this.hubPoolClient.getTokenInfoForL1Token(l1Token).decimals);
          rebalancesRequired[chainId][l1Token] = deltaPct.mul(cumulativeBalance).div(scalar);
        }
      }
    }
    if (rebalancesRequired == {}) {
      this.log("No rebalances required");
      return;
    }

    // Next, evaluate if we have enough tokens on L1 to actually do these rebalances.
    // Todo: consider adding a reserve threshold wherein we keep some amount on L1.
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
    this.log("Considered inventory rebalances", { rebalancesRequired, possibleRebalances });

    // Finally, execute the rebalances.
    // TODO: The logic below is slow as it waits for each transaction to be included before sending the next one. This
    // should be refactored to enable us to pass an array of transaction objects to the transaction util that then
    // sends each transaction one after the other with incrementing nonce. this will be left for a follow on PR as this
    // is already complex logic and most of the time we'll not be sending batches of rebalance transactions.
    const executedTransactions: { [chainId: number]: { [l1Token: string]: string } } = {};
    for (const chainId of Object.keys(possibleRebalances)) {
      for (const l1Token of Object.keys(possibleRebalances[chainId])) {
        console.log("SENDING", l1Token, chainId, possibleRebalances[chainId][l1Token]);
        // const receipt = await this.sendTokenCrossChain(chainId, l1Token, possibleRebalances[chainId][l1Token]);
        // if (!executedTransactions[chainId]) executedTransactions[chainId] = {};
        // executedTransactions[chainId][l1Token] = receipt.transactionHash;
      }
    }
    console.log("Executed rebalances", { executedTransactions });
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
