import { CumulativeBalanceRebalancerClient, RebalancerAdapter, RebalanceRoute } from "../src/rebalancer/rebalancer";
import {
  CumulativeTargetBalanceConfig,
  MaxAmountToTransferConfig,
  MaxPendingOrdersConfig,
  RebalancerConfig,
} from "../src/rebalancer/RebalancerConfig";
import { bnZero, toBNWei } from "../src/utils";
import { BigNumber, createSpyLogger, ethers, expect } from "./utils";

// Note: We use real token symbols in this test in order to avoid throwing errors when getTokenInfoFromSymbol
// is called. This is probably not a good idea in the long run but if we use symbols like USDC or WBTC
// that are unlikely to get deleted from the token symbol map then we should be OK.
describe("RebalancerClient.cumulativeRebalancing", () => {
  const hubPoolChainId = 1;

  it("Caps rebalance amount at lesser of deficit and excess remaining", async function () {
    const deficitToken = "USDC";
    const excessToken = "USDT";
    const cumulativeDeficitAmount = toBNWei("100", 6);
    const cumulativeExcessAmount = toBNWei("50", 6);
    const cumulativeBalances: { [token: string]: BigNumber } = {
      [deficitToken]: bnZero,
      [excessToken]: cumulativeExcessAmount,
    };
    const currentBalances: { [chainId: number]: { [token: string]: BigNumber } } = {
      [hubPoolChainId]: {
        [deficitToken]: bnZero,
        [excessToken]: toBNWei("100", 6), // This is a nonsensical test but we set the
        // current balance higher than the excess amount of 50 set above just in order to test
        // that the limiting factor on the amount to rebalance is the excess amount, not the current
        // balance, max amount to transfer, or deficit.
      },
    };
    const cumulativeTargetBalances: CumulativeTargetBalanceConfig = {
      [deficitToken]: {
        targetBalance: cumulativeDeficitAmount,
        thresholdBalance: cumulativeDeficitAmount.sub(toBNWei("10", 6)),
        priorityTier: 0,
        chains: {
          [hubPoolChainId]: 0,
        },
      },
      [excessToken]: {
        targetBalance: bnZero,
        thresholdBalance: bnZero,
        priorityTier: 0,
        chains: {
          [hubPoolChainId]: 0,
        },
      },
    };
    const maxAmountsToTransfer: MaxAmountToTransferConfig = {
      [deficitToken]: {
        [hubPoolChainId]: toBNWei("1000000", 6),
      },
      [excessToken]: {
        [hubPoolChainId]: toBNWei("1000000", 6),
      },
    };
    const maxPendingOrders: MaxPendingOrdersConfig = {
      adapter1: 1,
    };
    const config = new MockRebalancerConfig(
      cumulativeTargetBalances,
      maxAmountsToTransfer,
      maxPendingOrders,
      hubPoolChainId
    );
    const adapter1 = new MockRebalancerAdapter();
    const adapters: { [name: string]: RebalancerAdapter } = {
      adapter1: adapter1,
    };
    const rebalanceRoutes: RebalanceRoute[] = [
      {
        sourceChain: hubPoolChainId,
        destinationChain: hubPoolChainId,
        sourceToken: excessToken,
        destinationToken: deficitToken,
        adapter: "adapter1",
      },
    ];
    const baseSigner = ethers.Wallet.createRandom();

    const { spyLogger } = createSpyLogger();
    const rebalancerClient = new CumulativeBalanceRebalancerClient(
      spyLogger,
      config,
      adapters,
      rebalanceRoutes,
      baseSigner
    );
    const maxFeePct = toBNWei("1", 6);
    await rebalancerClient.rebalanceInventory(cumulativeBalances, currentBalances, maxFeePct);

    const rebalances = adapter1.rebalances;
    expect(rebalances.length).to.equal(1);
    expect(rebalances[0].route.sourceToken).to.equal(excessToken);
    expect(rebalances[0].route.destinationToken).to.equal(deficitToken);
    // The amount to rebalance should be capped at the lesser of deficit (100) and excess (50).
    expect(rebalances[0].amount).to.equal(cumulativeExcessAmount);
  });
  // it("Depletes excess and deficit remaining with each rebalance", async function() {

  // })
  // it("Caps rebalance amount at configured max amount per rebalance", async function() {

  // })
  // it("Iterates through deficits in sorted order", async function() {

  // })
  // it("Iterates through excesses in sorted order", async function() {

  // })
  // it("For a given excess token, source chains are iterated through in sorted order", async function() {

  // })
  // it("For a given excess token and source chain, rebalance route is chosen using cheapest expected cost", async function() {

  // })
  // it("Respects max pending orders per adapter limit", async function() {

  // })
});

class MockRebalancerAdapter implements RebalancerAdapter {
  public rebalances: { route: RebalanceRoute; amount: BigNumber }[] = [];
  public estimatedCostMapping: { [route: string]: BigNumber } = {};
  initialize(): Promise<void> {
    return Promise.resolve();
  }
  initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<void> {
    this.rebalances.push({ route: rebalanceRoute, amount: amountToTransfer });
    return Promise.resolve();
  }
  updateRebalanceStatuses(): Promise<void> {
    return Promise.resolve();
  }
  sweepIntermediateBalances(): Promise<void> {
    return Promise.resolve();
  }

  getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    // This function is only used in external clients so its not really necessary to implement here.
    return Promise.resolve({});
  }
  getPendingOrders(): Promise<string[]> {
    // This is important to align with this.rebalances so that we can test that maxPendingOrders
    // is respected.
    return Promise.resolve(this.rebalances.map((x, i) => i.toString()));
  }
  setEstimatedCost(route: RebalanceRoute, cost: BigNumber): void {
    this.estimatedCostMapping[JSON.stringify(route)] = cost;
  }
  getEstimatedCost(rebalanceRoute: RebalanceRoute): Promise<BigNumber> {
    return Promise.resolve(this.estimatedCostMapping[JSON.stringify(rebalanceRoute)] ?? bnZero);
  }
}

class MockRebalancerConfig extends RebalancerConfig {
  public cumulativeTargetBalances: CumulativeTargetBalanceConfig;
  public maxAmountsToTransfer: MaxAmountToTransferConfig;
  public maxPendingOrders: MaxPendingOrdersConfig;
  public hubPoolChainId: number;
  public sendingTransactionsEnabled: boolean;

  constructor(
    cumulativeBalanceTargets: CumulativeTargetBalanceConfig,
    maxAmountsToTransfer: MaxAmountToTransferConfig,
    maxPendingOrders: MaxPendingOrdersConfig,
    hubPoolChainId: number
  ) {
    super({});
    this.cumulativeTargetBalances = cumulativeBalanceTargets;
    this.maxAmountsToTransfer = maxAmountsToTransfer;
    this.maxPendingOrders = maxPendingOrders;
    this.hubPoolChainId = hubPoolChainId;

    // Required in order to call adapter.initializeRebalance().
    this.sendingTransactionsEnabled = true;
  }
}
