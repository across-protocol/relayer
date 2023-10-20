import { assert } from "chai";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import {
  ConfigStoreClient,
  FillProfit,
  GAS_TOKEN_BY_CHAIN_ID,
  MATIC,
  SpokePoolClient,
  USDC,
  WBTC,
  WETH,
} from "../src/clients";
import { Deposit, DepositWithBlock, L1Token } from "../src/interfaces";
import { BigNumber, formatFeePct, toBN, toBNWei } from "../src/utils";
import { MockHubPoolClient, MockProfitClient } from "./mocks";
import {
  createSpyLogger,
  deployConfigStore,
  deploySpokePoolWithToken,
  destinationChainId,
  ethers,
  expect,
  hubPoolFixture,
  originChainId,
  randomAddress,
  winston,
} from "./utils";

const { bnZero, fixedPointAdjustment: fixedPoint, toGWei } = sdkUtils;
const { formatEther } = ethers.utils;

const chainIds = [originChainId, destinationChainId];
const zeroRefundFee = bnZero;

const minRelayerFeeBps = 3;
const minRelayerFeePct = toBNWei(minRelayerFeeBps).div(1e4);

// relayerFeePct clamped at 50 bps by each SpokePool.
const maxRelayerFeeBps = 50;
const maxRelayerFeePct = toBNWei(maxRelayerFeeBps).div(1e4);

const tokens: { [symbol: string]: L1Token } = {
  MATIC: { address: MATIC, decimals: 18, symbol: "MATIC" },
  USDC: { address: USDC, decimals: 6, symbol: "USDC" },
  WBTC: { address: WBTC, decimals: 8, symbol: "WBTC" },
  WETH: { address: WETH, decimals: 18, symbol: "WETH" },
};

const tokenPrices: { [symbol: string]: BigNumber } = {
  MATIC: toBNWei("0.4"),
  USDC: toBNWei(1),
  WBTC: toBNWei(21000),
  WETH: toBNWei(3000),
};

// Quirk: Use the chainId as the gas price in Gwei. This gives a range of
// gas prices to test with, since there's a spread in the chainId numbers.
const gasCost: { [chainId: number]: BigNumber } = Object.fromEntries(
  chainIds.map((chainId) => {
    const nativeGasPrice = toGWei(chainId);
    const gasConsumed = toBN(100_000); // Assume 100k gas for a single fill
    return [chainId, gasConsumed.mul(nativeGasPrice)];
  })
);

function setDefaultTokenPrices(profitClient: MockProfitClient): void {
  // Load ERC20 token prices in USD.
  profitClient.setTokenPrices(
    Object.fromEntries(Object.entries(tokenPrices).map(([symbol, price]) => [tokens[symbol].address, price]))
  );
}

function testProfitability(
  deposit: Deposit,
  fillAmountUsd: BigNumber,
  gasCostUsd: BigNumber,
  refundFeeUsd: BigNumber
): FillProfit {
  const { relayerFeePct } = deposit;

  const grossRelayerFeeUsd = fillAmountUsd.mul(relayerFeePct).div(fixedPoint);
  const relayerCapitalUsd = fillAmountUsd.sub(grossRelayerFeeUsd);

  const minRelayerFeeUsd = relayerCapitalUsd.mul(minRelayerFeePct).div(fixedPoint);
  const netRelayerFeeUsd = grossRelayerFeeUsd.sub(gasCostUsd.add(refundFeeUsd));
  const netRelayerFeePct = netRelayerFeeUsd.mul(fixedPoint).div(relayerCapitalUsd);

  const profitable = netRelayerFeeUsd.gte(minRelayerFeeUsd);

  return {
    grossRelayerFeeUsd,
    netRelayerFeePct,
    relayerCapitalUsd,
    netRelayerFeeUsd,
    profitable,
  } as FillProfit;
}

describe("ProfitClient: Consider relay profit", () => {
  // Define LOG_IN_TEST for logging to console.
  const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
  let hubPoolClient: MockHubPoolClient, profitClient: MockProfitClient;
  const message = "0x"; // Empty message by default.

  beforeEach(async () => {
    const [owner] = await ethers.getSigners();
    const logger = createSpyLogger().spyLogger;

    const { configStore } = await deployConfigStore(owner, []);
    const configStoreClient = new ConfigStoreClient(logger, configStore);

    await configStoreClient.update();

    const { hubPool } = await hubPoolFixture();
    hubPoolClient = new MockHubPoolClient(logger, hubPool, configStoreClient);

    await hubPoolClient.update();

    const chainIds = [originChainId, destinationChainId];
    assert(chainIds.length === 2, "SpokePool deployment requires only 2 chainIds");
    const spokePoolClients = Object.fromEntries(
      await sdkUtils.mapAsync(chainIds, async (spokeChainId, idx) => {
        const { spokePool, deploymentBlock } = await deploySpokePoolWithToken(
          spokeChainId,
          chainIds[(idx + 1) % 2] // @dev Only works for 2 chainIds.
        );
        const spokePoolClient = new SpokePoolClient(
          spyLogger,
          spokePool.connect(owner),
          null,
          spokeChainId,
          deploymentBlock
        );

        return [spokeChainId, spokePoolClient];
      })
    );

    const debugProfitability = true;
    profitClient = new MockProfitClient(
      spyLogger,
      hubPoolClient,
      spokePoolClients,
      [],
      randomAddress(),
      minRelayerFeePct,
      debugProfitability
    );

    // Load per-chain gas cost (gas consumed * gas price in Wei), in native gas token.
    profitClient.setGasCosts(gasCost);
    setDefaultTokenPrices(profitClient);
  });

  // Verify gas cost calculation first, so we can leverage it in all subsequent tests.
  it("Verify gas cost estimation", () => {
    chainIds.forEach((destinationChainId) => {
      spyLogger.debug({ message: `Verifying USD fill cost calculation for chain ${destinationChainId}.` });
      const deposit = { destinationChainId, message } as Deposit;

      const nativeGasCost = profitClient.getTotalGasCost(deposit);
      expect(nativeGasCost.eq(0)).to.be.false;
      expect(nativeGasCost.eq(gasCost[destinationChainId])).to.be.true;

      const gasTokenAddr = GAS_TOKEN_BY_CHAIN_ID[destinationChainId];
      let gasToken = Object.values(tokens).find((token) => gasTokenAddr === token.address);
      expect(gasToken).to.not.be.undefined;
      gasToken = gasToken as L1Token;

      const gasPriceUsd = tokenPrices[gasToken.symbol];
      expect(gasPriceUsd.eq(tokenPrices[gasToken.symbol])).to.be.true;

      const estimate = profitClient.estimateFillCost(deposit);
      expect(estimate.nativeGasCost.eq(gasCost[destinationChainId])).to.be.true;
      expect(estimate.gasPriceUsd.eq(tokenPrices[gasToken.symbol])).to.be.true;
      expect(estimate.gasCostUsd.eq(gasPriceUsd.mul(nativeGasCost).div(toBN(10).pow(gasToken.decimals)))).to.be.true;
    });
  });

  it("Verify gas multiplier", () => {
    chainIds.forEach((destinationChainId) => {
      spyLogger.debug({ message: `Verifying gas multiplier for chainId ${destinationChainId}.` });
      const deposit = { destinationChainId, message } as Deposit;

      const nativeGasCost = profitClient.getTotalGasCost(deposit);
      expect(nativeGasCost.gt(0)).to.be.true;

      const gasMultipliers = [0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
      gasMultipliers.forEach((gasMultiplier) => {
        profitClient.setGasMultiplier(toBNWei(gasMultiplier));

        const gasTokenAddr = GAS_TOKEN_BY_CHAIN_ID[destinationChainId];
        let gasToken = Object.values(tokens).find((token) => gasTokenAddr === token.address);
        expect(gasToken).to.not.be.undefined;
        gasToken = gasToken as L1Token;

        const expectedFillCostUsd = nativeGasCost
          .mul(tokenPrices[gasToken.symbol])
          .mul(toBNWei(gasMultiplier))
          .div(fixedPoint)
          .div(fixedPoint);
        const { gasCostUsd } = profitClient.estimateFillCost(deposit);
        expect(expectedFillCostUsd.eq(gasCostUsd)).to.be.true;
      });
    });
  });

  it("Return 0 when gas cost fails to be fetched", () => {
    const destinationChainId = 137;
    profitClient.setGasCost(destinationChainId, undefined);
    const deposit = { destinationChainId, message } as Deposit;
    expect(profitClient.getTotalGasCost(deposit)).to.equal(bnZero);
  });

  it("Verify token price and gas cost lookup failures", () => {
    const fillAmount = toBNWei(1);
    const l1Token = tokens["WETH"];
    const relayerFeePct = toBNWei("0.0003");
    hubPoolClient.setTokenInfoToReturn(l1Token);

    chainIds.forEach((destinationChainId) => {
      const deposit = { destinationChainId, message, relayerFeePct } as Deposit;

      // Verify that it works before we break it.
      expect(() =>
        profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct)
      ).to.not.throw();

      spyLogger.debug({ message: `Verify exception on chain ${destinationChainId} gas cost estimation failure.` });
      const destinationGasCost = profitClient.getTotalGasCost(deposit);
      profitClient.setGasCost(destinationChainId, undefined);
      expect(() =>
        profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct)
      ).to.throw();
      profitClient.setGasCost(destinationChainId, destinationGasCost);

      spyLogger.debug({ message: `Verifying exception on chain ${destinationChainId} token price lookup failure.` });
      const l1TokenPrice = profitClient.getPriceOfToken(l1Token.address);
      profitClient.setTokenPrice(l1Token.address, undefined);

      // Setting price to 0 causes a downstream error in calculateFillProfitability.
      expect(() =>
        profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct)
      ).to.throw();
      profitClient.setTokenPrice(l1Token.address, l1TokenPrice);

      // Verify we left everything as we found it.
      expect(() =>
        profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct)
      ).to.not.throw();
    });
  });

  /**
   * Note: This test is a bit of a monster. It iterates over all combinations of:
   * - Configured destination chains.
   * - Configured L1 tokens.
   * - A range of fill amounts.
   * - A range of relayerFeePct values (sane and insane).
   *
   * The utility of this test is also _somewhat_ debatable, since it implements
   * quite similar logic to the ProfitClient itself. A logic error in both
   * implementations is certainly possible. However, relay pricing is quite
   * dynamic, and the development of this test _did_ catch a few unexpected
   * corner cases. This approach does however require fairly careful analysis of
   * the test results to make sure that they are sane. Sampling is recommended.
   */
  it("Considers gas cost when computing profitability", () => {
    const fillAmounts = [".001", "0.1", 1, 10, 100, 1_000, 100_000];

    chainIds.forEach((destinationChainId) => {
      const deposit = { destinationChainId, message } as Deposit;
      const { gasCostUsd } = profitClient.estimateFillCost(deposit);

      Object.values(tokens).forEach((l1Token) => {
        const tokenPriceUsd = profitClient.getPriceOfToken(l1Token.address);
        hubPoolClient.setTokenInfoToReturn(l1Token);

        fillAmounts.forEach((_fillAmount) => {
          const fillAmount = toBNWei(_fillAmount);
          const nativeFillAmount = toBNWei(_fillAmount, l1Token.decimals);
          spyLogger.debug({ message: `Testing fillAmount ${formatEther(fillAmount)}.` });

          const fillAmountUsd = fillAmount.mul(tokenPriceUsd).div(fixedPoint);
          const gasCostPct = gasCostUsd.mul(fixedPoint).div(fillAmountUsd);

          const relayerFeePcts = [
            toBNWei(-1),
            bnZero,
            minRelayerFeePct.div(4),
            minRelayerFeePct.div(2),
            minRelayerFeePct,
            minRelayerFeePct.add(gasCostPct),
            minRelayerFeePct.add(gasCostPct).add(1),
            minRelayerFeePct.add(gasCostPct).add(toBNWei(1)),
          ];

          relayerFeePcts.forEach((_relayerFeePct) => {
            const relayerFeePct = _relayerFeePct.gt(maxRelayerFeePct) ? maxRelayerFeePct : _relayerFeePct;
            deposit.relayerFeePct = relayerFeePct;

            const expected = testProfitability(deposit, fillAmountUsd, gasCostUsd, zeroRefundFee);
            spyLogger.debug({
              message: `Expect ${l1Token.symbol} deposit is ${expected.profitable ? "" : "un"}profitable:`,
              fillAmount,
              fillAmountUsd,
              gasCostUsd,
              grossRelayerFeePct: `${formatFeePct(relayerFeePct)} %`,
              gasCostPct: `${formatFeePct(gasCostPct)} %`,
              relayerCapitalUsd: expected.relayerCapitalUsd,
              minRelayerFeePct: `${formatFeePct(minRelayerFeePct)} %`,
              minRelayerFeeUsd: minRelayerFeePct.mul(fillAmountUsd).div(fixedPoint),
              netRelayerFeePct: `${formatFeePct(expected.netRelayerFeePct)} %`,
              netRelayerFeeUsd: expected.netRelayerFeeUsd,
            });

            const profitable = profitClient.isFillProfitable(deposit, nativeFillAmount, zeroRefundFee, l1Token);
            expect(profitable).to.equal(expected.profitable);
          });
        });
      });
    });
  });

  it("Considers refund fees when computing profitability", () => {
    const fillAmounts = [".001", "0.1", 1, 10, 100, 1_000, 100_000];
    const refundFeeMultipliers = ["-0.1", "-0.01", "-0.001", "-0.0001", 0.0001, 0.001, 0.01, 0.1, 1];
    const relayerFeePct = toBN(0.0001);

    chainIds.forEach((destinationChainId) => {
      const deposit = { destinationChainId, relayerFeePct, message } as Deposit;
      const { gasCostUsd } = profitClient.estimateFillCost(deposit);

      Object.values(tokens).forEach((l1Token) => {
        const tokenPriceUsd = profitClient.getPriceOfToken(l1Token.address);
        hubPoolClient.setTokenInfoToReturn(l1Token);

        fillAmounts.forEach((_fillAmount) => {
          const fillAmount = toBNWei(_fillAmount);
          const nativeFillAmount = toBNWei(_fillAmount, l1Token.decimals);
          spyLogger.debug({ message: `Testing fillAmount ${formatEther(fillAmount)}.` });

          const fillAmountUsd = fillAmount.mul(tokenPriceUsd).div(fixedPoint);
          const gasCostPct = gasCostUsd.mul(fixedPoint).div(fillAmountUsd);

          refundFeeMultipliers.forEach((_multiplier) => {
            const feeMultiplier = toBNWei(_multiplier);
            const refundFee = fillAmount.mul(feeMultiplier).div(fixedPoint);
            const nativeRefundFee = nativeFillAmount.mul(feeMultiplier).div(fixedPoint);
            const refundFeeUsd = refundFee.mul(tokenPriceUsd).div(fixedPoint);
            const expected = testProfitability(deposit, fillAmountUsd, gasCostUsd, refundFeeUsd);
            spyLogger.debug({
              message: `Expect ${l1Token.symbol} deposit is ${expected.profitable ? "" : "un"}profitable:`,
              tokenPrice: formatEther(tokenPriceUsd),
              fillAmount: formatEther(fillAmount),
              fillAmountUsd: formatEther(fillAmountUsd),
              gasCostUsd: formatEther(gasCostUsd),
              refundFee: formatEther(refundFee),
              feeMultiplier: formatEther(feeMultiplier),
              refundFeeUsd: formatEther(refundFeeUsd),
              grossRelayerFeePct: `${formatFeePct(relayerFeePct)} %`,
              gasCostPct: `${formatFeePct(gasCostPct)} %`,
              relayerCapitalUsd: formatEther(expected.relayerCapitalUsd),
              minRelayerFeePct: `${formatFeePct(minRelayerFeePct)} %`,
              minRelayerFeeUsd: formatEther(minRelayerFeePct.mul(fillAmountUsd).div(fixedPoint)),
              netRelayerFeePct: `${formatFeePct(expected.netRelayerFeePct)} %`,
              netRelayerFeeUsd: formatEther(expected.netRelayerFeeUsd),
            });

            const profitable = profitClient.isFillProfitable(deposit, nativeFillAmount, nativeRefundFee, l1Token);
            expect(profitable).to.equal(expected.profitable);
          });
        });
      });
    });
  });

  it("Allows per-route and per-token fee configuration", () => {
    // Setup custom USDC pricing to Optimism.
    chainIds.forEach((srcChainId) => {
      process.env[`MIN_RELAYER_FEE_PCT_USDC_${srcChainId}_10`] = Math.random().toPrecision(10).toString();
      process.env[`MIN_RELAYER_FEE_PCT_USDC_${srcChainId}_42161`] = "0.00005";
    });

    const envPrefix = "MIN_RELAYER_FEE_PCT";
    ["USDC", "DAI", "WETH", "WBTC"].forEach((symbol) => {
      chainIds.forEach((srcChainId) => {
        chainIds
          .filter((chainId) => chainId !== srcChainId)
          .forEach((dstChainId) => {
            const envVar = `${envPrefix}_${symbol}_${srcChainId}_${dstChainId}`;
            const routeFee = process.env[envVar];
            const routeMinRelayerFeePct = routeFee ? toBNWei(routeFee) : minRelayerFeePct;
            const computedMinRelayerFeePct = profitClient.minRelayerFeePct(symbol, srcChainId, dstChainId);
            spyLogger.debug({
              message: `Expect relayerFeePct === ${routeMinRelayerFeePct}`,
              routeFee,
              symbol,
              srcChainId,
              dstChainId,
              computedMinRelayerFeePct,
            });

            // Cleanup env as we go.
            if (routeFee) {
              process.env[envVar] = undefined;
            }

            expect(computedMinRelayerFeePct.eq(routeMinRelayerFeePct)).to.be.true;
          });
      });
    });
  });

  it("Considers deposits with newRelayerFeePct", async () => {
    const l1Token = tokens["WETH"];
    hubPoolClient.setTokenInfoToReturn(l1Token);

    const fillAmount = toBNWei(1);
    const relayerFeePct = toBNWei("0.001");
    const deposit = { destinationChainId, message, relayerFeePct } as Deposit;

    let fill: FillProfit;
    fill = profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct);
    expect(fill.grossRelayerFeePct.eq(deposit.relayerFeePct)).to.be.true;

    deposit.newRelayerFeePct = deposit.relayerFeePct.mul(10);
    fill = profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct);
    expect(fill.grossRelayerFeePct.eq(deposit.newRelayerFeePct)).to.be.true;
  });

  it("Ignores newRelayerFeePct if it's lower than original relayerFeePct", async () => {
    const l1Token = tokens["WETH"];
    hubPoolClient.setTokenInfoToReturn(l1Token);

    const deposit = {
      destinationChainId,
      message,
      relayerFeePct: toBNWei("0.1"),
      newRelayerFeePct: toBNWei("0.01"),
    } as Deposit;
    const fillAmount = toBNWei(1);

    let fill: FillProfit;
    fill = profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct);
    expect(fill.grossRelayerFeePct.eq(deposit.relayerFeePct)).to.be.true;

    deposit.relayerFeePct = toBNWei(".001");
    expect(deposit.relayerFeePct.lt(deposit.newRelayerFeePct as BigNumber)).to.be.true; // Sanity check
    fill = profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct);
    expect(fill.grossRelayerFeePct.eq(deposit.newRelayerFeePct as BigNumber)).to.be.true;
  });

  it("Captures unprofitable fills", () => {
    const deposit = { relayerFeePct: toBNWei("0.003"), originChainId: 1, depositId: 42 } as DepositWithBlock;
    profitClient.captureUnprofitableFill(deposit, toBNWei(1));
    expect(profitClient.getUnprofitableFills()).to.deep.equal({ 1: [{ deposit, fillAmount: toBNWei(1) }] });
  });
});
