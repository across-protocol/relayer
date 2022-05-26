import { BigNumber, winston, toBNWei, toBN, EventSearchConfig, assign } from "../../utils";
import { HubPoolClient, TokenClient } from "..";
import { InventorySettings } from "../../interfaces";
import { SpokePoolClient } from "../";
import { AdapterManager } from "./AdapterManager";

const scalar = toBN(10).pow(18);

export class InventoryClient {
  adapterManager: AdapterManager;

  private outstandingCrossChainTransfers: { [chainId: number]: { [l1Token: string]: BigNumber } } = {};

  constructor(
    readonly logger: winston.Logger,
    readonly inventorySettings: InventorySettings,
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
    return (
      this.tokenClient.getBalance(chainId, this.hubPoolClient.getDestinationTokenForL1Token(l1Token, chainId)) ||
      toBN(0) // If the chain does not have this token (EG BOBA on Optimism) then return.
    );
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

  getTokenDistributionPerL1Token() {
    console.log("GETTING", this.getL1Tokens());
    const distributionPerL1Token = {};
    this.getL1Tokens().forEach((l1Token) => (distributionPerL1Token[l1Token] = this.getChainDistribution(l1Token)));
    return distributionPerL1Token;
  }

  getEnabledChains(): number[] {
    return [10, 288, 42161];
    // return Object.keys(this.spokePoolClients).map((chainId) => parseInt(chainId));
  }

  getL1Tokens(): string[] {
    return this.hubPoolClient.getL1Tokens().map((l1Token) => l1Token.address);
  }

  async rebalanceInventoryIfNeeded() {
    console.log("GETTING");
    const distributionPerL1Token = this.getTokenDistributionPerL1Token();
    console.log("distributionPerL1Token", distributionPerL1Token);
    console.log("GETTING CROSS CHAIN BALANCES");
    await this.update();

    console.log("SEND");
    const tx = await this.adapterManager.sendTokenCrossChain(
      288,
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toBN(690000)
    );
    await this.adapterManager.checkTokenApprovals(this.getL1Tokens());
    // const tx = this.adapterManager.wrapEthIfAboveThreshold();
    console.log(tx);
  }
  async update() {
    this.logger.debug({ at: "InventoryClient", message: "Updating client", monitoredChains: this.getEnabledChains() });

    const outstandingTransfersPerChain = await Promise.all(
      this.getEnabledChains().map((chainId) =>
        this.adapterManager.getOutstandingCrossChainTokenTransferAmount(chainId, this.getL1Tokens())
      )
    );
    outstandingTransfersPerChain.forEach((outstandingTransfers, index) => {
      assign(this.outstandingCrossChainTransfers, [this.getEnabledChains()[index]], outstandingTransfers);
    });
    this.logger.debug({
      at: "InventoryClient",
      message: "Updated Outstanding Cross Chain Transfers",
      outstandingCrossChainTransfers: Object.keys(this.outstandingCrossChainTransfers).map((chainId) => {
        const outstandingTransfer = { chainId };
        Object.keys(this.outstandingCrossChainTransfers[chainId]).map(
          (l1Token) => (outstandingTransfer[l1Token] = this.outstandingCrossChainTransfers[chainId][l1Token].toString())
        );
        return outstandingTransfer;
      }),
    });
  }
}
