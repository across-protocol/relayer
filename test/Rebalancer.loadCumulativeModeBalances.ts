import { InventoryClient } from "../src/clients";
import { loadCumulativeModeBalances } from "../src/rebalancer";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { BigNumber, bnZero, CHAIN_IDs, getTokenInfoFromSymbol, toBNWei } from "../src/utils";
import { expect } from "./utils";

describe("loadCumulativeModeBalances", function () {
  it("loads configured Tron token balances without requiring an EVM remote token address", function () {
    const config = new RebalancerConfig({
      HUB_CHAIN_ID: String(CHAIN_IDs.MAINNET),
      REBALANCER_CONFIG: JSON.stringify({
        cumulativeTargetBalances: {
          USDT: {
            targetBalance: "1000",
            thresholdBalance: "500",
            priorityTier: 0,
            chains: {
              [CHAIN_IDs.TRON]: 0,
              [CHAIN_IDs.OPTIMISM]: 0,
            },
          },
        },
        maxAmountsToTransfer: {
          USDT: "100",
        },
      }),
    });
    const tronUsdt = getTokenInfoFromSymbol("USDT", CHAIN_IDs.TRON).address;
    const optimismUsdt = getTokenInfoFromSymbol("USDT", CHAIN_IDs.OPTIMISM).address;
    const tronBalance = toBNWei("123", 6);
    const optimismBalance = toBNWei("456", 6);
    const cumulativeBalance = toBNWei("1000", 6);
    const balances: { [chainId: number]: { [token: string]: BigNumber } } = {
      [CHAIN_IDs.TRON]: { [tronUsdt.toNative()]: tronBalance },
      [CHAIN_IDs.OPTIMISM]: { [optimismUsdt.toNative()]: optimismBalance },
    };
    const inventoryClient = {
      tokenClient: {
        getBalance: (chainId: number, token: typeof tronUsdt): BigNumber =>
          balances[chainId]?.[token.toNative()] ?? bnZero,
      },
      getCumulativeBalanceWithApproximateUpcomingRefunds: () => cumulativeBalance,
    } as unknown as InventoryClient;

    expect(tronUsdt.isTVM()).to.equal(true);

    const result = loadCumulativeModeBalances(config, inventoryClient);

    expect(result.currentBalances[CHAIN_IDs.TRON].USDT).to.equal(tronBalance);
    expect(result.currentBalances[CHAIN_IDs.OPTIMISM].USDT).to.equal(optimismBalance);
    expect(result.cumulativeBalances.USDT).to.equal(cumulativeBalance);
  });
});
