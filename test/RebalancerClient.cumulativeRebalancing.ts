import { RebalancerAdapter, RebalanceRoute } from "../src/rebalancer/utils/interfaces";
import { CumulativeBalanceRebalancerClient } from "../src/rebalancer/clients/CumulativeBalanceRebalancerClient";
import {
  CumulativeTargetBalanceConfig,
  MaxAmountToTransferConfig,
  MaxPendingOrdersConfig,
  RebalancerConfig,
} from "../src/rebalancer/RebalancerConfig";
import { bnZero, toBNWei } from "../src/utils";
import { BigNumber, createSpyLogger, ethers, expect } from "./utils";

describe("RebalancerClient.cumulativeRebalancing", () => {
  const HUB_POOL_CHAIN_ID = 1;
  const CHAIN_A = 1;
  const CHAIN_B = 10;
  const CHAIN_C = 137;
  const MAX_FEE_PCT = toBNWei("100");

  const USDC = "USDC";
  const USDT = "USDT";
  const DAI = "DAI";
  const WETH = "WETH";

  const TOKEN_DECIMALS: Record<string, number> = {
    [USDC]: 6,
    [USDT]: 6,
    [DAI]: 18,
    [WETH]: 18,
  };

  const amount = (token: string, humanAmount: string): BigNumber => toBNWei(humanAmount, TOKEN_DECIMALS[token]);

  function buildTarget(
    token: string,
    targetBalance: string,
    thresholdBalance: string,
    priorityTier: number,
    chains: { [chainId: number]: number }
  ): CumulativeTargetBalanceConfig[string] {
    return {
      targetBalance: amount(token, targetBalance),
      thresholdBalance: amount(token, thresholdBalance),
      priorityTier,
      chains,
    };
  }

  function makeRoute(
    sourceChain: number,
    destinationChain: number,
    sourceToken: string,
    destinationToken: string,
    adapter: string
  ): RebalanceRoute {
    return { sourceChain, destinationChain, sourceToken, destinationToken, adapter };
  }

  async function createClient(
    cumulativeTargetBalances: CumulativeTargetBalanceConfig,
    adapters: { [name: string]: RebalancerAdapter },
    rebalanceRoutes: RebalanceRoute[],
    maxAmountsToTransfer: MaxAmountToTransferConfig = {},
    maxPendingOrders: MaxPendingOrdersConfig = {}
  ): Promise<CumulativeBalanceRebalancerClient> {
    const config = new MockRebalancerConfig(
      cumulativeTargetBalances,
      maxAmountsToTransfer,
      maxPendingOrders,
      HUB_POOL_CHAIN_ID
    );
    const baseSigner = ethers.Wallet.createRandom();
    const { spyLogger } = createSpyLogger();
    const client = new CumulativeBalanceRebalancerClient(spyLogger, config, adapters, baseSigner);
    await client.initialize(rebalanceRoutes);
    return client;
  }

  it("Caps rebalance amount at lesser of deficit and excess remaining", async function () {
    const deficitToken = USDC;
    const excessToken = USDT;
    const cumulativeExcessAmount = amount(excessToken, "50");
    const cumulativeBalances: { [token: string]: BigNumber } = {
      [deficitToken]: bnZero,
      [excessToken]: cumulativeExcessAmount,
    };
    const currentBalances: { [chainId: number]: { [token: string]: BigNumber } } = {
      [HUB_POOL_CHAIN_ID]: {
        [deficitToken]: bnZero,
        // Set current balance above cumulative excess so excessRemaining is the true limiter.
        [excessToken]: amount(excessToken, "100"),
      },
    };
    const cumulativeTargetBalances: CumulativeTargetBalanceConfig = {
      [deficitToken]: buildTarget(deficitToken, "100", "90", 0, { [HUB_POOL_CHAIN_ID]: 0 }),
      [excessToken]: buildTarget(excessToken, "0", "0", 0, { [HUB_POOL_CHAIN_ID]: 0 }),
    };
    const adapter1 = new MockRebalancerAdapter();
    const rebalancerClient = await createClient(
      cumulativeTargetBalances,
      { adapter1 },
      [makeRoute(HUB_POOL_CHAIN_ID, HUB_POOL_CHAIN_ID, excessToken, deficitToken, "adapter1")],
      {
        [excessToken]: { [HUB_POOL_CHAIN_ID]: amount(excessToken, "1000000") },
        [deficitToken]: { [HUB_POOL_CHAIN_ID]: amount(deficitToken, "1000000") },
      },
      { adapter1: 10 }
    );
    await rebalancerClient.rebalanceInventory(cumulativeBalances, currentBalances, MAX_FEE_PCT);

    const rebalances = adapter1.rebalances;
    expect(rebalances.length).to.equal(1);
    expect(rebalances[0].route.sourceToken).to.equal(excessToken);
    expect(rebalances[0].route.destinationToken).to.equal(deficitToken);
    expect(rebalances[0].amount).to.equal(cumulativeExcessAmount);
  });

  it("Depletes excess and deficit remaining with each rebalance", async function () {
    const deficitToken = USDC;
    const excessToken = USDT;
    const cumulativeBalances = {
      [deficitToken]: bnZero,
      [excessToken]: amount(excessToken, "120"),
    };
    const currentBalances = {
      [CHAIN_A]: { [deficitToken]: bnZero, [excessToken]: amount(excessToken, "60") },
      [CHAIN_B]: { [deficitToken]: bnZero, [excessToken]: amount(excessToken, "60") },
    };
    const cumulativeTargetBalances: CumulativeTargetBalanceConfig = {
      [deficitToken]: buildTarget(deficitToken, "100", "90", 0, { [CHAIN_A]: 0 }),
      [excessToken]: buildTarget(excessToken, "0", "0", 0, {
        [CHAIN_A]: 0,
        [CHAIN_B]: 1,
      }),
    };
    const adapter1 = new MockRebalancerAdapter();
    const rebalancerClient = await createClient(
      cumulativeTargetBalances,
      { adapter1 },
      [
        makeRoute(CHAIN_A, CHAIN_A, excessToken, deficitToken, "adapter1"),
        makeRoute(CHAIN_B, CHAIN_A, excessToken, deficitToken, "adapter1"),
      ],
      {},
      { adapter1: 10 }
    );

    await rebalancerClient.rebalanceInventory(cumulativeBalances, currentBalances, MAX_FEE_PCT);

    expect(adapter1.rebalances.length).to.equal(2);
    expect(adapter1.rebalances[0].route.sourceChain).to.equal(CHAIN_A);
    expect(adapter1.rebalances[1].route.sourceChain).to.equal(CHAIN_B);
    expect(adapter1.rebalances[0].amount).to.equal(amount(excessToken, "60"));
    expect(adapter1.rebalances[1].amount).to.equal(amount(excessToken, "40"));
  });

  it("Caps rebalance amount at configured max amount per rebalance", async function () {
    const deficitToken = USDC;
    const excessToken = USDT;
    const cumulativeBalances = {
      [deficitToken]: bnZero,
      [excessToken]: amount(excessToken, "100"),
    };
    const currentBalances = {
      [CHAIN_A]: { [deficitToken]: bnZero, [excessToken]: amount(excessToken, "100") },
    };
    const cumulativeTargetBalances: CumulativeTargetBalanceConfig = {
      [deficitToken]: buildTarget(deficitToken, "100", "90", 0, { [CHAIN_A]: 0 }),
      [excessToken]: buildTarget(excessToken, "0", "0", 0, { [CHAIN_A]: 0 }),
    };
    const adapter1 = new MockRebalancerAdapter();
    const rebalancerClient = await createClient(
      cumulativeTargetBalances,
      { adapter1 },
      [makeRoute(CHAIN_A, CHAIN_A, excessToken, deficitToken, "adapter1")],
      {
        [excessToken]: { [CHAIN_A]: amount(excessToken, "30") },
      },
      { adapter1: 10 }
    );

    await rebalancerClient.rebalanceInventory(cumulativeBalances, currentBalances, MAX_FEE_PCT);

    expect(adapter1.rebalances.length).to.equal(1);
    expect(adapter1.rebalances[0].amount).to.equal(amount(excessToken, "30"));
  });

  it("Iterates through deficits in sorted order", async function () {
    const cumulativeBalances = {
      [USDC]: bnZero,
      [DAI]: bnZero,
      [USDT]: amount(USDT, "500"),
    };
    const currentBalances = {
      [CHAIN_A]: {
        [USDC]: bnZero,
        [DAI]: bnZero,
        [USDT]: amount(USDT, "500"),
      },
    };
    const cumulativeTargetBalances: CumulativeTargetBalanceConfig = {
      [USDC]: buildTarget(USDC, "40", "35", 2, { [CHAIN_A]: 0 }),
      [DAI]: buildTarget(DAI, "1", "0.9", 1, { [CHAIN_A]: 0 }),
      [USDT]: buildTarget(USDT, "0", "0", 0, { [CHAIN_A]: 0 }),
    };
    const adapter1 = new MockRebalancerAdapter();
    const rebalancerClient = await createClient(cumulativeTargetBalances, { adapter1 }, [
      makeRoute(CHAIN_A, CHAIN_A, USDT, USDC, "adapter1"),
      makeRoute(CHAIN_A, CHAIN_A, USDT, DAI, "adapter1"),
    ]);

    await rebalancerClient.rebalanceInventory(cumulativeBalances, currentBalances, MAX_FEE_PCT);

    expect(adapter1.rebalances.length).to.equal(2);
    expect(adapter1.rebalances[0].route.destinationToken).to.equal(USDC);
    expect(adapter1.rebalances[1].route.destinationToken).to.equal(DAI);
  });

  it("Iterates through excesses in sorted order", async function () {
    const cumulativeBalances = {
      [USDC]: bnZero,
      [USDT]: amount(USDT, "100"),
      [DAI]: amount(DAI, "100"),
    };
    const currentBalances = {
      [CHAIN_A]: {
        [USDC]: bnZero,
        [USDT]: amount(USDT, "100"),
        [DAI]: amount(DAI, "100"),
      },
    };
    const cumulativeTargetBalances: CumulativeTargetBalanceConfig = {
      [USDC]: buildTarget(USDC, "150", "140", 0, { [CHAIN_A]: 0 }),
      [USDT]: buildTarget(USDT, "0", "0", 0, { [CHAIN_A]: 0 }),
      [DAI]: buildTarget(DAI, "0", "0", 1, { [CHAIN_A]: 0 }),
    };
    const adapter1 = new MockRebalancerAdapter();
    const rebalancerClient = await createClient(cumulativeTargetBalances, { adapter1 }, [
      makeRoute(CHAIN_A, CHAIN_A, USDT, USDC, "adapter1"),
      makeRoute(CHAIN_A, CHAIN_A, DAI, USDC, "adapter1"),
    ]);

    await rebalancerClient.rebalanceInventory(cumulativeBalances, currentBalances, MAX_FEE_PCT);

    expect(adapter1.rebalances.length).to.equal(2);
    expect(adapter1.rebalances[0].route.sourceToken).to.equal(USDT);
    expect(adapter1.rebalances[1].route.sourceToken).to.equal(DAI);
  });

  it("For a given excess token, source chains are iterated through in sorted order", async function () {
    const cumulativeBalances = {
      [USDC]: bnZero,
      [USDT]: amount(USDT, "200"),
    };
    const currentBalances = {
      [CHAIN_A]: { [USDC]: bnZero, [USDT]: amount(USDT, "20") },
      [CHAIN_B]: { [USDC]: bnZero, [USDT]: amount(USDT, "60") },
      [CHAIN_C]: { [USDC]: bnZero, [USDT]: amount(USDT, "40") },
    };
    const cumulativeTargetBalances: CumulativeTargetBalanceConfig = {
      [USDC]: buildTarget(USDC, "90", "80", 0, { [CHAIN_A]: 0 }),
      [USDT]: buildTarget(USDT, "0", "0", 0, {
        [CHAIN_A]: 1,
        [CHAIN_B]: 0,
        [CHAIN_C]: 0,
      }),
    };
    const adapter1 = new MockRebalancerAdapter();
    const rebalancerClient = await createClient(cumulativeTargetBalances, { adapter1 }, [
      makeRoute(CHAIN_A, CHAIN_A, USDT, USDC, "adapter1"),
      makeRoute(CHAIN_B, CHAIN_A, USDT, USDC, "adapter1"),
      makeRoute(CHAIN_C, CHAIN_A, USDT, USDC, "adapter1"),
    ]);

    await rebalancerClient.rebalanceInventory(cumulativeBalances, currentBalances, MAX_FEE_PCT);

    expect(adapter1.rebalances.length).to.equal(2);
    expect(adapter1.rebalances[0].route.sourceChain).to.equal(CHAIN_B);
    expect(adapter1.rebalances[1].route.sourceChain).to.equal(CHAIN_C);
  });

  it("For a given excess token and source chain, rebalance route is chosen using cheapest expected cost", async function () {
    const cumulativeBalances = {
      [USDC]: bnZero,
      [USDT]: amount(USDT, "100"),
    };
    const currentBalances = {
      [CHAIN_A]: { [USDC]: bnZero, [USDT]: amount(USDT, "100") },
      [CHAIN_B]: { [USDC]: bnZero },
    };
    const cumulativeTargetBalances: CumulativeTargetBalanceConfig = {
      [USDC]: buildTarget(USDC, "50", "40", 0, { [CHAIN_A]: 0, [CHAIN_B]: 0 }),
      [USDT]: buildTarget(USDT, "0", "0", 0, { [CHAIN_A]: 0 }),
    };
    const adapter1 = new MockRebalancerAdapter();
    const adapter2 = new MockRebalancerAdapter();
    const cheapRoute = makeRoute(CHAIN_A, CHAIN_A, USDT, USDC, "adapter2");
    const expensiveRoute = makeRoute(CHAIN_A, CHAIN_A, USDT, USDC, "adapter1");
    adapter1.setEstimatedCost(expensiveRoute, amount(USDT, "5"));
    adapter2.setEstimatedCost(cheapRoute, amount(USDT, "1"));
    const rebalancerClient = await createClient(
      cumulativeTargetBalances,
      { adapter1, adapter2 },
      [expensiveRoute, cheapRoute],
      {},
      { adapter1: 10, adapter2: 10 }
    );

    await rebalancerClient.rebalanceInventory(cumulativeBalances, currentBalances, MAX_FEE_PCT);

    expect(adapter1.rebalances.length).to.equal(0);
    expect(adapter2.rebalances.length).to.equal(1);
    expect(adapter2.rebalances[0].route.destinationChain).to.equal(CHAIN_A);
  });

  it("Respects max pending orders per adapter limit", async function () {
    const cumulativeBalances = {
      [USDC]: bnZero,
      [USDT]: amount(USDT, "100"),
    };
    const currentBalances = {
      [CHAIN_A]: { [USDC]: bnZero, [USDT]: amount(USDT, "100") },
    };
    const cumulativeTargetBalances: CumulativeTargetBalanceConfig = {
      [USDC]: buildTarget(USDC, "100", "90", 0, { [CHAIN_A]: 0 }),
      [USDT]: buildTarget(USDT, "0", "0", 0, { [CHAIN_A]: 0 }),
    };
    const adapter1 = new MockRebalancerAdapter();
    adapter1.setPendingOrders(["existing-order"]);
    const rebalancerClient = await createClient(
      cumulativeTargetBalances,
      { adapter1 },
      [makeRoute(CHAIN_A, CHAIN_A, USDT, USDC, "adapter1")],
      {},
      { adapter1: 1 }
    );

    await rebalancerClient.rebalanceInventory(cumulativeBalances, currentBalances, MAX_FEE_PCT);

    expect(adapter1.rebalances.length).to.equal(0);
  });

  it("Respects maxFeePct", async function () {
    const cumulativeBalances = {
      [USDC]: bnZero,
      [USDT]: amount(USDT, "100"),
    };
    const currentBalances = {
      [CHAIN_A]: { [USDC]: bnZero, [USDT]: amount(USDT, "100") },
    };
    const cumulativeTargetBalances: CumulativeTargetBalanceConfig = {
      [USDC]: buildTarget(USDC, "50", "40", 0, { [CHAIN_A]: 0 }),
      [USDT]: buildTarget(USDT, "0", "0", 0, { [CHAIN_A]: 0 }),
    };
    const route = makeRoute(CHAIN_A, CHAIN_A, USDT, USDC, "adapter1");

    const expensiveAdapter = new MockRebalancerAdapter();
    expensiveAdapter.setEstimatedCost(route, amount(USDT, "6")); // 6 / 50 > 10%
    const expensiveClient = await createClient(
      cumulativeTargetBalances,
      { adapter1: expensiveAdapter },
      [route],
      {},
      { adapter1: 10 }
    );
    await expensiveClient.rebalanceInventory(cumulativeBalances, currentBalances, toBNWei("10"));
    expect(expensiveAdapter.rebalances.length).to.equal(0);

    const affordableAdapter = new MockRebalancerAdapter();
    affordableAdapter.setEstimatedCost(route, amount(USDT, "5")); // 5 / 50 <= 10%
    const affordableClient = await createClient(
      cumulativeTargetBalances,
      { adapter1: affordableAdapter },
      [route],
      {},
      { adapter1: 10 }
    );
    await affordableClient.rebalanceInventory(cumulativeBalances, currentBalances, toBNWei("10"));
    expect(affordableAdapter.rebalances.length).to.equal(1);
  });
});

class MockRebalancerAdapter implements RebalancerAdapter {
  public rebalances: { route: RebalanceRoute; amount: BigNumber }[] = [];
  public estimatedCostMapping: { [route: string]: BigNumber } = {};
  private pendingOrders: string[] | undefined;

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
    return Promise.resolve(this.pendingOrders ?? this.rebalances.map((x, i) => i.toString()));
  }

  setPendingOrders(pendingOrders: string[]): void {
    this.pendingOrders = pendingOrders;
  }

  setEstimatedCost(route: RebalanceRoute, cost: BigNumber): void {
    this.estimatedCostMapping[JSON.stringify(route)] = cost;
  }

  getEstimatedCost(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber, debugLog: boolean): Promise<BigNumber> {
    void amountToTransfer;
    void debugLog;
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
    maxAmountsToTransfer: MaxAmountToTransferConfig = {},
    maxPendingOrders: MaxPendingOrdersConfig = {},
    hubPoolChainId = 1
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
