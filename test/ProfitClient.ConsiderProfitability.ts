import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { BigNumber, formatFeePct, toBN, toBNWei } from "../src/utils";
import {
  expect,
  createSpyLogger,
  deployConfigStore,
  hubPoolFixture,
  winston,
  ethers,
  deploySpokePoolWithToken,
  originChainId,
  destinationChainId,
} from "./utils";
import { MockHubPoolClient, MockProfitClient } from "./mocks";
import { Deposit, DepositWithBlock, L1Token } from "../src/interfaces";
import { FillProfit, GAS_TOKEN_BY_CHAIN_ID, SpokePoolClient, MATIC, USDC, WBTC, WETH } from "../src/clients";
import { ConfigStoreClient } from "../src/clients";

const { fixedPointAdjustment: fixedPoint } = sdkUtils;
const { formatEther } = ethers.utils;

const chainIds: number[] = [1, 10, 137, 288, 42161];
const zeroRefundFee = toBN(0);

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
  chainIds.map((chainId: number) => {
    const nativeGasPrice = toBN(chainId).mul(1e9); // Gwei
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

const minRelayerFeeBps = 3;
const minRelayerFeePct = toBNWei(minRelayerFeeBps).div(1e4);

// relayerFeePct clamped at 50 bps by each SpokePool.
const maxRelayerFeeBps = 50;
const maxRelayerFeePct = toBNWei(maxRelayerFeeBps).div(1e4);

// Define LOG_IN_TEST for logging to console.
const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
let hubPoolClient: MockHubPoolClient, profitClient: MockProfitClient;

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

describe("ProfitClient: Consider relay profit", async function () {
  beforeEach(async function () {
    const [owner] = await ethers.getSigners();
    const logger = createSpyLogger().spyLogger;

    const { configStore } = await deployConfigStore(owner, []);
    const configStoreClient = new ConfigStoreClient(logger, configStore);

    await configStoreClient.update();

    const { hubPool } = await hubPoolFixture();
    hubPoolClient = new MockHubPoolClient(logger, hubPool, configStoreClient);

    await hubPoolClient.update();

    const { spokePool: spokePool_1, deploymentBlock: spokePool1DeploymentBlock } = await deploySpokePoolWithToken(
      originChainId,
      destinationChainId
    );
    const { spokePool: spokePool_2, deploymentBlock: spokePool2DeploymentBlock } = await deploySpokePoolWithToken(
      destinationChainId,
      originChainId
    );

    const spokePoolClient_1 = new SpokePoolClient(
      spyLogger,
      spokePool_1.connect(owner),
      null,
      originChainId,
      spokePool1DeploymentBlock
    );
    const spokePoolClient_2 = new SpokePoolClient(
      spyLogger,
      spokePool_2.connect(owner),
      null,
      destinationChainId,
      spokePool2DeploymentBlock
    );
    const spokePoolClients = { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 };

    const debugProfitability = true;

    profitClient = new MockProfitClient(
      spyLogger,
      hubPoolClient,
      spokePoolClients,
      [],
      minRelayerFeePct,
      debugProfitability
    );

    // Load per-chain gas cost (gas consumed * gas price in Wei), in native gas token.
    profitClient.setGasCosts(gasCost);

    setDefaultTokenPrices(profitClient);
  });

  // Verify gas cost calculation first, so we can leverage it in all subsequent tests.
  it("Verify gas cost estimation", function () {
    chainIds.forEach((chainId: number) => {
      spyLogger.debug({ message: `Verifying USD fill cost calculation for chain ${chainId}.` });

      const nativeGasCost = profitClient.getTotalGasCost(chainId);
      expect(nativeGasCost.eq(0)).to.be.false;
      expect(nativeGasCost.eq(gasCost[chainId])).to.be.true;

      const gasTokenAddr: string = GAS_TOKEN_BY_CHAIN_ID[chainId];
      const gasToken: L1Token = Object.values(tokens).find((token: L1Token) => gasTokenAddr === token.address);
      expect(gasToken).to.not.be.undefined;

      const gasPriceUsd = tokenPrices[gasToken.symbol];
      expect(gasPriceUsd.eq(tokenPrices[gasToken.symbol])).to.be.true;

      const estimate: { [key: string]: BigNumber } = profitClient.estimateFillCost(chainId);
      expect(estimate.nativeGasCost.eq(gasCost[chainId])).to.be.true;
      expect(estimate.gasPriceUsd.eq(tokenPrices[gasToken.symbol])).to.be.true;
      expect(estimate.gasCostUsd.eq(gasPriceUsd.mul(nativeGasCost).div(toBN(10).pow(gasToken.decimals)))).to.be.true;
    });
  });

  it("Verify gas multiplier", function () {
    chainIds.forEach((chainId: number) => {
      spyLogger.debug({ message: `Verifying gas multiplier for chainId ${chainId}.` });

      const nativeGasCost = profitClient.getTotalGasCost(chainId);
      expect(nativeGasCost.gt(0)).to.be.true;

      const gasMultipliers = [0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
      gasMultipliers.forEach((gasMultiplier) => {
        profitClient.setGasMultiplier(toBNWei(gasMultiplier));

        const gasTokenAddr = GAS_TOKEN_BY_CHAIN_ID[chainId];
        const gasToken: L1Token = Object.values(tokens).find((token: L1Token) => gasTokenAddr === token.address);

        const expectedFillCostUsd = nativeGasCost
          .mul(tokenPrices[gasToken.symbol])
          .mul(toBNWei(gasMultiplier))
          .div(fixedPoint)
          .div(fixedPoint);
        const { gasCostUsd } = profitClient.estimateFillCost(chainId);
        expect(expectedFillCostUsd.eq(gasCostUsd)).to.be.true;
      });
    });
  });

  it("Return 0 when gas cost fails to be fetched", async function () {
    profitClient.setGasCosts({ 137: undefined });
    expect(profitClient.getTotalGasCost(137)).to.equal(toBN(0));
  });

  it("Verify token price and gas cost lookup failures", function () {
    const l1Token: L1Token = tokens["WETH"];
    const fillAmount = toBNWei(1);

    hubPoolClient.setTokenInfoToReturn(l1Token);

    chainIds.forEach((_chainId: number) => {
      const chainId = Number(_chainId);
      const deposit = {
        relayerFeePct: toBNWei("0.0003"),
        destinationChainId: chainId,
      } as Deposit;

      // Verify that it works before we break it.
      expect(() =>
        profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct)
      ).to.not.throw();

      spyLogger.debug({ message: `Verifying exception on gas cost estimation lookup failure on chain ${chainId}.` });
      profitClient.setGasCosts({});
      expect(() =>
        profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct)
      ).to.throw();
      profitClient.setGasCosts(gasCost);

      spyLogger.debug({ message: `Verifying exception on token price lookup failure on chain ${chainId}.` });
      profitClient.setTokenPrices({ [l1Token.address]: toBN(0) });
      // Setting price to 0 causes a downstream error in calculateFillProfitability.
      expect(() =>
        profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct)
      ).to.throw();
      setDefaultTokenPrices(profitClient);

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
  it("Considers gas cost when computing profitability", async function () {
    const fillAmounts = [".001", "0.1", 1, 10, 100, 1_000, 100_000];

    chainIds.forEach((destinationChainId: number) => {
      const { gasCostUsd } = profitClient.estimateFillCost(destinationChainId);

      Object.values(tokens).forEach((l1Token: L1Token) => {
        const tokenPriceUsd = profitClient.getPriceOfToken(l1Token.address);
        hubPoolClient.setTokenInfoToReturn(l1Token);

        fillAmounts.forEach((_fillAmount: number | string) => {
          const fillAmount = toBNWei(_fillAmount);
          const nativeFillAmount = toBNWei(_fillAmount, l1Token.decimals);
          spyLogger.debug({ message: `Testing fillAmount ${formatEther(fillAmount)}.` });

          const fillAmountUsd = fillAmount.mul(tokenPriceUsd).div(fixedPoint);
          const gasCostPct = gasCostUsd.mul(fixedPoint).div(fillAmountUsd);

          const relayerFeePcts: BigNumber[] = [
            toBNWei(-1),
            toBNWei(0),
            minRelayerFeePct.div(4),
            minRelayerFeePct.div(2),
            minRelayerFeePct,
            minRelayerFeePct.add(gasCostPct),
            minRelayerFeePct.add(gasCostPct).add(1),
            minRelayerFeePct.add(gasCostPct).add(toBNWei(1)),
          ];

          relayerFeePcts.forEach((_relayerFeePct: BigNumber) => {
            const relayerFeePct = _relayerFeePct.gt(maxRelayerFeePct) ? maxRelayerFeePct : _relayerFeePct;
            const deposit = { relayerFeePct, destinationChainId } as Deposit;

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

  it("Considers refund fees when computing profitability", async function () {
    const fillAmounts = [".001", "0.1", 1, 10, 100, 1_000, 100_000];
    const refundFeeMultipliers = ["-0.1", "-0.01", "-0.001", "-0.0001", 0.0001, 0.001, 0.01, 0.1, 1];

    chainIds.forEach((destinationChainId: number) => {
      const { gasCostUsd } = profitClient.estimateFillCost(destinationChainId);

      Object.values(tokens).forEach((l1Token: L1Token) => {
        const tokenPriceUsd = profitClient.getPriceOfToken(l1Token.address);
        hubPoolClient.setTokenInfoToReturn(l1Token);

        fillAmounts.forEach((_fillAmount) => {
          const fillAmount = toBNWei(_fillAmount);
          const nativeFillAmount = toBNWei(_fillAmount, l1Token.decimals);
          spyLogger.debug({ message: `Testing fillAmount ${formatEther(fillAmount)}.` });

          const fillAmountUsd = fillAmount.mul(tokenPriceUsd).div(fixedPoint);
          const gasCostPct = gasCostUsd.mul(fixedPoint).div(fillAmountUsd);

          const relayerFeePct = toBN(0.0001);
          const deposit = { relayerFeePct, destinationChainId } as Deposit;

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

  it("Allows per-route and per-token fee configuration", async function () {
    // Setup custom USDC pricing to Optimism.
    chainIds.forEach((srcChainId) => {
      process.env[`MIN_RELAYER_FEE_PCT_USDC_${srcChainId}_10`] = Math.random().toPrecision(10).toString();
      process.env[`MIN_RELAYER_FEE_PCT_USDC_${srcChainId}_42161`] = "0.00005";
    });

    const envPrefix = "MIN_RELAYER_FEE_PCT";
    ["USDC", "DAI", "WETH", "WBTC"].forEach((symbol) => {
      chainIds.forEach((srcChainId) => {
        chainIds.forEach((dstChainId) => {
          if (srcChainId === dstChainId) {
            return;
          }

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

  it("Considers deposits with newRelayerFeePct", async function () {
    const l1Token: L1Token = tokens["WETH"];
    hubPoolClient.setTokenInfoToReturn(l1Token);

    const fillAmount = toBNWei(1);
    const deposit = {
      relayerFeePct: toBNWei("0.001"),
      destinationChainId: 1,
    } as Deposit;

    let fill: FillProfit;
    fill = profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct);
    expect(fill.grossRelayerFeePct.eq(deposit.relayerFeePct)).to.be.true;

    deposit["newRelayerFeePct"] = toBNWei("0.1");
    fill = profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct);
    expect(fill.grossRelayerFeePct.eq(deposit.newRelayerFeePct)).to.be.true;
  });

  it("Ignores newRelayerFeePct if it's lower than original relayerFeePct", async function () {
    const l1Token: L1Token = tokens["WETH"];
    hubPoolClient.setTokenInfoToReturn(l1Token);

    const deposit = {
      relayerFeePct: toBNWei("0.1"),
      newRelayerFeePct: toBNWei("0.01"),
      destinationChainId: 1,
    } as Deposit;
    const fillAmount = toBNWei(1);

    let fill: FillProfit;
    fill = profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct);
    expect(fill.grossRelayerFeePct.eq(deposit.relayerFeePct)).to.be.true;

    deposit.relayerFeePct = toBNWei(".001");
    expect(deposit.relayerFeePct.lt(deposit.newRelayerFeePct)).to.be.true; // Sanity check
    fill = profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct);
    expect(fill.grossRelayerFeePct.eq(deposit.newRelayerFeePct)).to.be.true;
  });

  it("Captures unprofitable fills", async function () {
    const deposit = { relayerFeePct: toBNWei("0.003"), originChainId: 1, depositId: 42 } as DepositWithBlock;
    profitClient.captureUnprofitableFill(deposit, toBNWei(1));
    expect(profitClient.getUnprofitableFills()).to.deep.equal({ 1: [{ deposit, fillAmount: toBNWei(1) }] });
  });
});
