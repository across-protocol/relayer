import { assert } from "chai";
import { random } from "lodash";
import { constants as sdkConstants, utils as sdkUtils } from "@across-protocol/sdk-v2";
import { ConfigStoreClient, FillProfit, SpokePoolClient, V2FillProfit, V3FillProfit } from "../src/clients";
import { Deposit, DepositWithBlock, V2Deposit, V3Deposit } from "../src/interfaces";
import {
  bnZero,
  bnOne,
  BigNumber,
  fixedPointAdjustment as fixedPoint,
  formatFeePct,
  getCurrentTime,
  toBN,
  toBNWei,
  toGWei,
  TOKEN_SYMBOLS_MAP,
} from "../src/utils";
import { MockHubPoolClient, MockProfitClient } from "./mocks";
import { originChainId, destinationChainId, ZERO_ADDRESS } from "./constants";
import {
  assertPromiseError,
  createSpyLogger,
  deployConfigStore,
  deploySpokePoolWithToken,
  ethers,
  expect,
  hubPoolFixture,
  randomAddress,
  winston,
} from "./utils";

type TransactionCostEstimate = sdkUtils.TransactionCostEstimate;

const { formatEther } = ethers.utils;

const chainIds = [originChainId, destinationChainId];
const zeroRefundFee = bnZero;

const minRelayerFeeBps = 3;
const minRelayerFeePct = toBNWei(minRelayerFeeBps).div(1e4);

// relayerFeePct clamped at 50 bps by each SpokePool.
const maxRelayerFeeBps = 50;
const maxRelayerFeePct = toBNWei(maxRelayerFeeBps).div(1e4);

function testV2Profitability(
  deposit: V2Deposit,
  fillAmountUsd: BigNumber,
  gasCostUsd: BigNumber,
  refundFeeUsd: BigNumber
): Pick<
  V2FillProfit,
  "grossRelayerFeeUsd" | "netRelayerFeePct" | "relayerCapitalUsd" | "netRelayerFeeUsd" | "profitable"
> {
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
  };
}

function testV3Profitability(
  inputAmountUsd: BigNumber,
  outputAmountUsd: BigNumber,
  gasCostUsd: BigNumber,
  lpFeeUsd: BigNumber
): Pick<V3FillProfit, "grossRelayerFeeUsd" | "netRelayerFeePct" | "netRelayerFeeUsd" | "profitable"> {
  const grossRelayerFeeUsd = inputAmountUsd.sub(outputAmountUsd).sub(lpFeeUsd);
  const netRelayerFeeUsd = inputAmountUsd.sub(outputAmountUsd.add(lpFeeUsd.add(gasCostUsd)));
  const netRelayerFeePct = netRelayerFeeUsd.mul(fixedPoint).div(inputAmountUsd);

  const minRelayerFeeUsd = inputAmountUsd.mul(minRelayerFeePct).div(fixedPoint);
  const profitable = netRelayerFeeUsd.gte(minRelayerFeeUsd);

  return {
    grossRelayerFeeUsd,
    netRelayerFeePct,
    netRelayerFeeUsd,
    profitable,
  };
}

describe("ProfitClient: Consider relay profit", () => {
  // Define LOG_IN_TEST for logging to console.
  const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
  let hubPoolClient: MockHubPoolClient, profitClient: MockProfitClient;
  const message = sdkConstants.EMPTY_MESSAGE; // Empty message by default.

  const randomiseGasCost = (chainId: number): TransactionCostEstimate & { gasTokenPriceUsd: BigNumber } => {
    // Randomise the gas token price (usd)
    const gasToken = profitClient.resolveGasToken(chainId);
    const gasTokenPriceUsd = toBNWei(Math.random().toFixed(18));

    // Randomise the fillRelay cost in units of gas.
    const nativeGasCost = toBN(random(80_000, 100_000));
    const tokenGasCost = nativeGasCost.mul(toGWei(random(1, 100))).div(toBN(10).pow(9));

    profitClient.setTokenPrice(gasToken.address, gasTokenPriceUsd);
    profitClient.setGasCost(chainId, { nativeGasCost, tokenGasCost });

    return { nativeGasCost, tokenGasCost, gasTokenPriceUsd };
  };

  const tokens = Object.fromEntries(
    ["MATIC", "USDC", "WBTC", "WETH"].map((symbol) => {
      const { decimals, addresses } = TOKEN_SYMBOLS_MAP[symbol];
      return [symbol, { symbol, decimals, address: addresses[1] }];
    })
  );

  const tokenPrices = Object.fromEntries(
    Object.keys(tokens).map((symbol) => {
      const { decimals } = TOKEN_SYMBOLS_MAP[symbol];
      return [symbol, toBNWei(random(0.1, 21000, true).toFixed(decimals))];
    })
  );

  // Quirk: Use the chainId as the gas price in Gwei. This gives a range of
  // gas prices to test with, since there's a spread in the chainId numbers.
  const gasCost: { [chainId: number]: TransactionCostEstimate } = Object.fromEntries(
    chainIds.map((chainId) => {
      const nativeGasCost = toBN(100_000); // Assume 100k gas for a single fill
      const gasTokenPrice = toBN(chainId);
      const tokenGasCost = nativeGasCost.mul(gasTokenPrice);
      return [chainId, { nativeGasCost, tokenGasCost }];
    })
  );

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
    profitClient.setTokenPrices(tokenPrices);
  });

  // Verify gas cost calculation first, so we can leverage it in all subsequent tests.
  it("Verify gas cost estimation", async () => {
    for (const destinationChainId of chainIds) {
      spyLogger.debug({ message: `Verifying USD fill cost calculation for chain ${destinationChainId}.` });
      const deposit = { destinationChainId, message } as Deposit;
      const gasToken = profitClient.resolveGasToken(destinationChainId);
      const expected = randomiseGasCost(destinationChainId);

      const { tokenGasCost } = await profitClient.getTotalGasCost(deposit, deposit.amount);
      expect(tokenGasCost.eq(0)).to.be.false;

      const gasTokenPriceUsd = profitClient.getPriceOfToken(gasToken.address);

      const estimate = await profitClient.estimateFillCost(deposit, deposit.amount);
      ["nativeGasCost", "tokenGasCost"].forEach((field) => expect(estimate[field].eq(expected[field])).to.be.true);

      expect(estimate.gasCostUsd.eq(tokenGasCost.mul(gasTokenPriceUsd).div(toBN(10).pow(gasToken.decimals)))).to.be
        .true;
    }
  });

  it("Verify gas padding", async () => {
    const gasPadding = ["0", "0.10", "0.20", "0.50", "1"].map((padding) => toBNWei("1").add(toBNWei(padding)));

    profitClient.setGasMultiplier(toBNWei("1")); // Neutralise any gas multiplier.

    for (const destinationChainId of chainIds) {
      spyLogger.debug({ message: `Verifying gas padding for chainId ${destinationChainId}.` });
      const deposit = { destinationChainId, message } as Deposit;

      const { nativeGasCost: defaultNativeGasCost, tokenGasCost: defaultTokenGasCost } =
        await profitClient.getTotalGasCost(deposit, deposit.amount);

      for (const padding of gasPadding) {
        profitClient.setGasPadding(padding);

        const expectedNativeGasCost = defaultNativeGasCost.mul(padding).div(fixedPoint);
        const expectedTokenGasCost = defaultTokenGasCost.mul(padding).div(fixedPoint);

        const { nativeGasCost, tokenGasCost } = await profitClient.estimateFillCost(deposit);
        expect(expectedNativeGasCost.eq(nativeGasCost)).to.be.true;
        expect(expectedTokenGasCost.eq(tokenGasCost)).to.be.true;
      }
    }
  });

  it("Verify gas multiplier", async () => {
    const gasMultipliers = [0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0].map((multiplier) => toBNWei(multiplier));

    for (const destinationChainId of chainIds) {
      spyLogger.debug({ message: `Verifying gas multiplier for chainId ${destinationChainId}.` });
      const deposit = { destinationChainId, message } as Deposit;

      const { gasTokenPriceUsd } = randomiseGasCost(destinationChainId);
      const gasToken = profitClient.resolveGasToken(destinationChainId);
      const { tokenGasCost } = await profitClient.getTotalGasCost(deposit, deposit.amount);
      expect(tokenGasCost.gt(0)).to.be.true;

      for (const gasMultiplier of gasMultipliers) {
        profitClient.setGasMultiplier(gasMultiplier);

        const expectedFillCostUsd = tokenGasCost
          .mul(gasMultiplier)
          .div(fixedPoint)
          .mul(gasTokenPriceUsd)
          .div(toBN(10).pow(gasToken.decimals));
        const { gasCostUsd } = await profitClient.estimateFillCost(deposit);
        expect(expectedFillCostUsd.eq(gasCostUsd)).to.be.true;
      }
    }
  });

  it("Return 0 when gas cost fails to be fetched", async () => {
    const destinationChainId = 137;
    profitClient.setGasCost(destinationChainId, undefined);
    const deposit = { amount: bnOne, destinationChainId, message } as Deposit;
    const { nativeGasCost, tokenGasCost } = await profitClient.getTotalGasCost(deposit);
    expect(nativeGasCost.eq(bnZero)).to.be.true;
    expect(tokenGasCost.eq(bnZero)).to.be.true;
  });

  it("Verify token price and gas cost lookup failures", async () => {
    const fillAmount = toBNWei(1);
    const l1Token = tokens.WETH;
    const relayerFeePct = toBNWei("0.0003");
    hubPoolClient.setTokenInfoToReturn(l1Token);

    for (const destinationChainId of chainIds) {
      const deposit = { amount: fillAmount, destinationChainId, message, relayerFeePct } as Deposit;

      // Verify that it works before we break it.
      expect(() =>
        profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct)
      ).to.not.throw();

      spyLogger.debug({ message: `Verify exception on chain ${destinationChainId} gas cost estimation failure.` });
      const destinationGasCost = await profitClient.getTotalGasCost(deposit);
      profitClient.setGasCost(destinationChainId, undefined);
      await assertPromiseError(
        profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct)
      );
      profitClient.setGasCost(destinationChainId, destinationGasCost);

      spyLogger.debug({ message: `Verifying exception on chain ${destinationChainId} token price lookup failure.` });
      const l1TokenPrice = profitClient.getPriceOfToken(l1Token.address);
      profitClient.setTokenPrice(l1Token.address, undefined);

      // Setting price to 0 causes a downstream error in calculateFillProfitability.
      await assertPromiseError(
        profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct)
      );
      profitClient.setTokenPrice(l1Token.address, l1TokenPrice);

      // Verify we left everything as we found it.
      expect(() =>
        profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct)
      ).to.not.throw();
    }
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
  it("Considers gas cost when computing profitability", async () => {
    const fillAmounts = [".001", "0.1", 1, 10, 100, 1_000, 100_000];
    for (const destinationChainId of chainIds) {
      const deposit = { originToken: "", amount: bnOne, destinationChainId, message } as V2Deposit;

      randomiseGasCost(destinationChainId);
      const { gasCostUsd } = await profitClient.estimateFillCost(deposit);

      for (const l1Token of Object.values(tokens)) {
        const tokenPriceUsd = profitClient.getPriceOfToken(l1Token.address);
        hubPoolClient.setTokenInfoToReturn(l1Token);

        for (const _fillAmount of fillAmounts) {
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

          for (const _relayerFeePct of relayerFeePcts) {
            const relayerFeePct = _relayerFeePct.gt(maxRelayerFeePct) ? maxRelayerFeePct : _relayerFeePct;
            deposit.relayerFeePct = relayerFeePct;

            const expected = testV2Profitability(deposit, fillAmountUsd, gasCostUsd, zeroRefundFee);
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

            const { profitable } = await profitClient.isFillProfitable(
              deposit,
              nativeFillAmount,
              zeroRefundFee,
              l1Token
            );
            expect(profitable).to.equal(expected.profitable);
          }
        }
      }
    }
  });

  // @note: This test is not relevant because refund fees were never introdued.
  // tbd on whether to update or rewrite it to test that verifies the input lpFeePct is respected.
  it.only("Considers LP fees when computing profitability", async () => {
    const inputAmounts = [".01", "0.1", 1, 10, 100, 1_000, 100_000];
    const lpFeeMultipliers = [0.1, 1, 10];
    const baseLpFeePct = toBNWei("0.0001");
    const relayerFeePct = minRelayerFeePct.add(baseLpFeePct);

    for (const destinationChainId of chainIds) {
      for (const l1Token of Object.values(tokens)) {
        const inputToken = l1Token.address;
        const outputToken = inputToken;

        hubPoolClient.setTokenMapping(inputToken, originChainId, inputToken);
        hubPoolClient.setTokenMapping(outputToken, destinationChainId, outputToken);
        await hubPoolClient.update();

        const tokenScalar = toBN(10).pow(18 - l1Token.decimals);
        const tokenPriceUsd = profitClient.getPriceOfToken(inputToken);

        for (const _inputAmount of inputAmounts) {
          const inputAmount = toBNWei(_inputAmount);
          const scaledInputAmount = inputAmount.mul(tokenScalar);
          const inputAmountUsd = scaledInputAmount.mul(tokenPriceUsd).div(fixedPoint);

          for (const lpFeeMultiplier of lpFeeMultipliers) {
            const lpFeePct = baseLpFeePct.mul(toBNWei(lpFeeMultiplier)).div(fixedPoint);
            const lpFee = scaledInputAmount.mul(lpFeePct).div(fixedPoint);
            const lpFeeUsd = lpFee.mul(tokenPriceUsd).div(fixedPoint);

            // relayer eats the LP fee.
            const outputAmount = inputAmount.mul(fixedPoint.sub(relayerFeePct)).div(fixedPoint);
            const scaledOutputAmount = outputAmount.mul(tokenScalar);
            const outputAmountUsd = scaledOutputAmount.mul(tokenPriceUsd).div(fixedPoint);

            const quoteTimestamp = getCurrentTime();
            const deposit: V3Deposit = {
              originChainId,
              destinationChainId,
              depositId: Math.ceil(Math.random() * 10_000),
              depositor: randomAddress(),
              recipient: randomAddress(),
              inputToken,
              inputAmount,
              outputToken,
              outputAmount,
              message,
              quoteTimestamp,
              fillDeadline: quoteTimestamp,
              exclusivityDeadline: 0,
              exclusiveRelayer: ZERO_ADDRESS,
            };
            const { gasCostUsd } = await profitClient.estimateFillCost(deposit);

            const expected = testV3Profitability(inputAmountUsd, outputAmountUsd, gasCostUsd, lpFeeUsd);
            spyLogger.debug({
              message: `Expect ${l1Token.symbol} deposit is ${expected.profitable ? "" : "un"}profitable:`,
              tokenPrice: formatEther(tokenPriceUsd),
              outputAmount: formatEther(outputAmount),
              outputAmountUsd: formatEther(outputAmountUsd),
              gasCostUsd: formatEther(gasCostUsd),
              lpFee: formatEther(lpFee),
              lpFeeMultiplier: formatEther(toBNWei(lpFeeMultiplier)),
              lpFeeUsd: formatEther(lpFeeUsd),
              grossRelayerFeePct: `${formatFeePct(relayerFeePct)} %`,
              minRelayerFeePct: `${formatFeePct(minRelayerFeePct)} %`,
              minRelayerFeeUsd: formatEther(minRelayerFeePct.mul(inputAmountUsd).div(fixedPoint)),
              netRelayerFeePct: `${formatFeePct(expected.netRelayerFeePct)} %`,
              netRelayerFeeUsd: formatEther(expected.netRelayerFeeUsd),
            });

            const { profitable } = await profitClient.isFillProfitable(
              deposit,
              outputAmount,
              lpFeePct,
              l1Token
            );
            expect(profitable).to.equal(expected.profitable);
          }
        }
      }
    }
  });

  it("Allows per-route and per-token fee configuration", () => {
    // Setup custom USDC pricing to Optimism.
    chainIds.forEach((srcChainId) => {
      process.env[`MIN_RELAYER_FEE_PCT_USDC_${srcChainId}_10`] = Math.random().toFixed(10).toString();
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
    const l1Token = tokens.WETH;
    hubPoolClient.setTokenInfoToReturn(l1Token);

    const fillAmount = toBNWei(1);
    const relayerFeePct = toBNWei("0.001");
    const deposit = { destinationChainId, originToken: "", message, relayerFeePct } as V2Deposit;

    randomiseGasCost(destinationChainId);

    let fill: FillProfit;
    fill = await profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct);
    expect(fill.grossRelayerFeePct.eq(deposit.relayerFeePct)).to.be.true;

    deposit.newRelayerFeePct = deposit.relayerFeePct.mul(10);
    fill = await profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct);
    expect(fill.grossRelayerFeePct.eq(deposit.newRelayerFeePct)).to.be.true;
  });

  it("Ignores newRelayerFeePct if it's lower than original relayerFeePct", async () => {
    const l1Token = tokens.WETH;
    hubPoolClient.setTokenInfoToReturn(l1Token);

    randomiseGasCost(destinationChainId);

    const deposit = {
      destinationChainId,
      originToken: "",
      message,
      relayerFeePct: toBNWei("0.1"),
      newRelayerFeePct: toBNWei("0.01"),
    } as V2Deposit;
    const fillAmount = toBNWei(1);

    let fill: FillProfit;
    fill = await profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct);
    expect(fill.grossRelayerFeePct.eq(deposit.relayerFeePct)).to.be.true;

    deposit.relayerFeePct = toBNWei(".001");
    expect(deposit.relayerFeePct.lt(deposit.newRelayerFeePct as BigNumber)).to.be.true; // Sanity check
    fill = await profitClient.calculateFillProfitability(deposit, fillAmount, zeroRefundFee, l1Token, minRelayerFeePct);
    expect(fill.grossRelayerFeePct.eq(deposit.newRelayerFeePct as BigNumber)).to.be.true;
  });

  it("Captures unprofitable fills", () => {
    const deposit = { relayerFeePct: toBNWei("0.003"), originChainId: 1, depositId: 42 } as DepositWithBlock;
    const gasCost = toGWei(random(1, 100_000));
    profitClient.captureUnprofitableFill(deposit, toBNWei(1), gasCost);
    expect(profitClient.getUnprofitableFills()).to.deep.equal({ 1: [{ deposit, fillAmount: toBNWei(1), gasCost }] });
  });
});
