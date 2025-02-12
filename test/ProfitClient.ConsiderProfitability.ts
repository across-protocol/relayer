import { assert } from "chai";
import { random } from "lodash";
import { constants as sdkConstants, utils as sdkUtils } from "@across-protocol/sdk";
import { ConfigStoreClient, FillProfit, SpokePoolClient } from "../src/clients";
import { Deposit } from "../src/interfaces";
import {
  bnZero,
  bnOne,
  bnUint256Max as uint256Max,
  CHAIN_IDs,
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

describe("ProfitClient: Consider relay profit", () => {
  const now = getCurrentTime();
  const bn10 = toBN(10);
  const outputAmount = toBNWei(1);
  const lpFeePct = toBNWei(1).div(1e4);
  const relayerFeePct = toBNWei(1).div(1e4);
  const gasFeePct = toBNWei(1).div(1e4);
  const v3DepositTemplate: Deposit = {
    originChainId,
    depositId: BigNumber.from(1),
    destinationChainId,
    depositor: randomAddress(),
    recipient: randomAddress(),
    inputToken: randomAddress(),
    inputAmount: outputAmount.mul(fixedPoint).div(fixedPoint.sub(lpFeePct.add(relayerFeePct).add(gasFeePct))),
    outputToken: randomAddress(),
    outputAmount,
    quoteTimestamp: now,
    message: sdkConstants.EMPTY_MESSAGE,
    fillDeadline: now,
    exclusivityDeadline: 0,
    exclusiveRelayer: ZERO_ADDRESS,
    fromLiteChain: false,
    toLiteChain: false,
  };

  const chainIds = [originChainId, destinationChainId];
  const zeroLPFee = bnZero;

  const minRelayerFeeBps = 1;
  const minRelayerFeePct = toBNWei(minRelayerFeeBps).div(1e4);

  // Define LOG_IN_TEST for logging to console.
  const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
  let hubPoolClient: MockHubPoolClient, profitClient: MockProfitClient;
  const message = sdkConstants.EMPTY_MESSAGE; // Empty message by default.

  const randomiseGasCost = (chainId: number): TransactionCostEstimate & { gasTokenPriceUsd: BigNumber } => {
    // Randomise the gas token price (usd)
    const gasToken = profitClient.resolveGasToken(chainId);
    const gasTokenPriceUsd = profitClient.getPriceOfToken(gasToken.symbol);

    // Randomise the fillRelay cost in units of gas.
    const nativeGasCost = toBN(random(80_000, 100_000));
    const gasPrice = toGWei(random(1, 100));
    const tokenGasCost = nativeGasCost.mul(gasPrice).div(toBN(10).pow(9));

    profitClient.setTokenPrice(gasToken.address, gasTokenPriceUsd);
    profitClient.setGasCost(chainId, { nativeGasCost, tokenGasCost, gasPrice });

    return { nativeGasCost, tokenGasCost, gasPrice, gasTokenPriceUsd };
  };

  const tokens = Object.fromEntries(
    ["MATIC", "USDC", "WBTC", "WETH"].map((symbol) => {
      const { decimals, addresses } = TOKEN_SYMBOLS_MAP[symbol];
      return [symbol, { symbol, decimals, address: addresses[CHAIN_IDs.MAINNET] }];
    })
  );

  const tokenPrices = Object.fromEntries(
    Object.keys(tokens).map((symbol) => {
      const { decimals } = TOKEN_SYMBOLS_MAP[symbol];
      return "USDC" === symbol ? [symbol, toBNWei(1)] : [symbol, toBNWei(random(0.1, 21000, true).toFixed(decimals))];
    })
  );

  // Quirk: Use the chainId as the gas price in Gwei. This gives a range of
  // gas prices to test with, since there's a spread in the chainId numbers.
  const gasCost: { [chainId: number]: TransactionCostEstimate } = Object.fromEntries(
    chainIds.map((chainId) => {
      const nativeGasCost = toBN(100_000); // Assume 100k gas for a single fill
      const gasTokenPrice = toBN(chainId);
      const gasPrice = gasTokenPrice;
      const tokenGasCost = nativeGasCost.mul(gasPrice);
      return [chainId, { nativeGasCost, tokenGasCost, gasPrice }];
    })
  );

  const testProfitability = (
    inputAmountUsd: BigNumber,
    outputAmountUsd: BigNumber,
    gasCostUsd: BigNumber,
    lpFeeUsd: BigNumber
  ): Pick<FillProfit, "grossRelayerFeeUsd" | "netRelayerFeePct" | "netRelayerFeeUsd" | "profitable"> => {
    const grossRelayerFeeUsd = inputAmountUsd.sub(outputAmountUsd).sub(lpFeeUsd);
    const netRelayerFeeUsd = grossRelayerFeeUsd.sub(gasCostUsd);
    const netRelayerFeePct = netRelayerFeeUsd.mul(fixedPoint).div(outputAmountUsd);

    const minRelayerFeeUsd = outputAmountUsd.mul(minRelayerFeePct).div(fixedPoint);
    const profitable = netRelayerFeeUsd.gte(minRelayerFeeUsd);

    return {
      grossRelayerFeeUsd,
      netRelayerFeePct,
      netRelayerFeeUsd,
      profitable,
    };
  };

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
      const deposit = {
        ...v3DepositTemplate,
        destinationChainId,
        message,
      };
      const gasToken = profitClient.resolveGasToken(destinationChainId);
      const expected = randomiseGasCost(destinationChainId);

      const { tokenGasCost } = await profitClient.getTotalGasCost(deposit);
      expect(tokenGasCost.eq(0)).to.be.false;

      const gasTokenPriceUsd = profitClient.getPriceOfToken(gasToken.address);

      const estimate = await profitClient.estimateFillCost(deposit);
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
      const deposit = { ...v3DepositTemplate, destinationChainId };

      const { nativeGasCost: defaultNativeGasCost, tokenGasCost: defaultTokenGasCost } =
        await profitClient.getTotalGasCost(deposit);

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
      const deposit = { ...v3DepositTemplate, destinationChainId };

      const { gasTokenPriceUsd } = randomiseGasCost(destinationChainId);
      const gasToken = profitClient.resolveGasToken(destinationChainId);
      const { tokenGasCost } = await profitClient.getTotalGasCost(deposit);
      expect(tokenGasCost.gt(bnZero)).to.be.true;

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

  it("Return uint256Max when gas cost fails to be fetched", async () => {
    const destinationChainId = 137;
    profitClient.setGasCost(destinationChainId, undefined);
    const deposit = { ...v3DepositTemplate, destinationChainId };
    const { nativeGasCost, tokenGasCost } = await profitClient.getTotalGasCost(deposit);
    expect(nativeGasCost.eq(uint256Max)).to.be.true;
    expect(tokenGasCost.eq(uint256Max)).to.be.true;
  });

  it("Verify token price and gas cost lookup failures", async () => {
    const outputAmount = toBNWei(1);
    const l1Token = tokens.WETH;
    hubPoolClient.setTokenInfoToReturn(l1Token);

    for (const destinationChainId of chainIds) {
      const deposit = { ...v3DepositTemplate, outputAmount, destinationChainId };

      // Verify that it works before we break it.
      expect(() => profitClient.calculateFillProfitability(deposit, zeroLPFee, minRelayerFeePct)).to.not.throw();

      spyLogger.debug({ message: `Verify exception on chain ${destinationChainId} gas cost estimation failure.` });
      const destinationGasCost = await profitClient.getTotalGasCost(deposit);
      profitClient.setGasCost(destinationChainId, undefined);
      await assertPromiseError(profitClient.calculateFillProfitability(deposit, zeroLPFee, minRelayerFeePct));
      profitClient.setGasCost(destinationChainId, destinationGasCost);

      spyLogger.debug({ message: `Verifying exception on chain ${destinationChainId} token price lookup failure.` });
      const l1TokenPrice = profitClient.getPriceOfToken(l1Token.address);
      profitClient.setTokenPrice(l1Token.address, undefined);

      // Setting price to 0 causes a downstream error in calculateFillProfitability.
      await assertPromiseError(profitClient.calculateFillProfitability(deposit, zeroLPFee, minRelayerFeePct));
      profitClient.setTokenPrice(l1Token.address, l1TokenPrice);

      // Verify we left everything as we found it.
      expect(() => profitClient.calculateFillProfitability(deposit, zeroLPFee, minRelayerFeePct)).to.not.throw();
    }
  });

  it("Considers gas cost when computing profitability", async () => {
    const gasCostMultipliers = ["0.1", "0.5", "1", "2", "5", "10"].map((n) => toBNWei(n));

    for (const originChainId of chainIds) {
      for (const destinationChainId of chainIds.filter((chainId) => chainId !== originChainId)) {
        const { nativeGasCost: baseNativeGasCost, gasPrice } = gasCost[destinationChainId];

        for (const token of Object.values(tokens)) {
          const inputToken = randomAddress();
          const outputToken = randomAddress();

          const outputAmount = toBN(1).mul(bn10.pow(token.decimals));
          const inputAmount = outputAmount
            .mul(fixedPoint)
            .div(fixedPoint.sub(lpFeePct.add(relayerFeePct).add(gasFeePct)));
          const deposit = {
            ...v3DepositTemplate,
            originChainId,
            destinationChainId,
            inputToken,
            inputAmount,
            outputToken,
            outputAmount,
          };
          hubPoolClient.setTokenMapping(token.address, deposit.originChainId, deposit.inputToken);
          hubPoolClient.mapTokenInfo(deposit.outputToken, token.symbol, token.decimals);
          const tokenPriceUsd = profitClient.getPriceOfToken(token.symbol);

          // Normalise any tokens with <18 decimals to 18 decimals.
          const scaledInputAmount = deposit.inputAmount.mul(bn10.pow(18 - token.decimals));
          const scaledOutputAmount = deposit.outputAmount.mul(bn10.pow(18 - token.decimals));

          const inputAmountUsd = scaledInputAmount.mul(tokenPriceUsd).div(fixedPoint);
          const outputAmountUsd = scaledOutputAmount.mul(tokenPriceUsd).div(fixedPoint);

          const lpFeeUsd = inputAmountUsd.mul(lpFeePct).div(fixedPoint);
          const gasToken = profitClient.resolveGasToken(destinationChainId);
          const gasTokenPriceUsd = profitClient.getPriceOfToken(gasToken.symbol);

          for (const gasCostMultiplier of gasCostMultipliers) {
            const nativeGasCost = baseNativeGasCost.mul(gasCostMultiplier).div(fixedPoint);
            const tokenGasCost = nativeGasCost.mul(gasPrice);
            const gasCostUsd = tokenGasCost.mul(gasTokenPriceUsd).div(fixedPoint);
            profitClient.setGasCost(destinationChainId, { nativeGasCost, tokenGasCost, gasPrice });

            const gasCostPct = gasCostUsd.mul(fixedPoint).div(outputAmountUsd);

            const expected = testProfitability(inputAmountUsd, outputAmountUsd, gasCostUsd, lpFeeUsd);
            spyLogger.debug({
              message: `Expect ${token.symbol} deposit is ${expected.profitable ? "" : "un"}profitable:`,
              inputAmount: formatEther(scaledInputAmount),
              inputAmountUsd: formatEther(inputAmountUsd),
              outputAmount: formatEther(scaledOutputAmount),
              outputAmountUsd: formatEther(outputAmountUsd),
              lpFeePct: `${formatFeePct(lpFeePct)}`,
              lpFeeUsd: formatEther(lpFeeUsd),
              gasMultiplier: formatEther(gasCostMultiplier),
              gasCostUsd: formatEther(gasCostUsd),
              gasCostPct: `${formatFeePct(gasCostPct)} %`,
              minRelayerFeePct: `${formatFeePct(minRelayerFeePct)} %`,
              minRelayerFeeUsd: formatEther(minRelayerFeePct.mul(outputAmountUsd).div(fixedPoint)),
              netRelayerFeePct: `${formatFeePct(expected.netRelayerFeePct)} %`,
              netRelayerFeeUsd: formatEther(expected.netRelayerFeeUsd),
            });

            const { profitable } = await profitClient.isFillProfitable(deposit, lpFeePct, token, destinationChainId);
            expect(profitable).to.equal(expected.profitable);
          }
        }
      }
    }
  });

  it("Considers LP fees when computing profitability", async () => {
    const lpFeeMultipliers = ["0.01", "0.1", "0.5", "1", "2", "5", "10"].map((n) => toBNWei(n));

    for (const originChainId of chainIds) {
      for (const destinationChainId of chainIds.filter((chainId) => chainId !== originChainId)) {
        const { tokenGasCost } = gasCost[destinationChainId];
        const gasToken = profitClient.resolveGasToken(destinationChainId);
        const gasTokenPriceUsd = profitClient.getPriceOfToken(gasToken.symbol);
        const gasCostUsd = tokenGasCost.mul(gasTokenPriceUsd).div(bn10.pow(gasToken.decimals));

        for (const token of Object.values(tokens)) {
          const inputToken = randomAddress();
          const outputToken = randomAddress();

          const outputAmount = toBN(1).mul(bn10.pow(token.decimals));
          const inputAmount = outputAmount
            .mul(fixedPoint)
            .div(fixedPoint.sub(lpFeePct.add(relayerFeePct).add(gasFeePct)));
          const deposit = {
            ...v3DepositTemplate,
            originChainId,
            destinationChainId,
            inputToken,
            inputAmount,
            outputToken,
            outputAmount,
          };
          hubPoolClient.setTokenMapping(token.address, deposit.originChainId, deposit.inputToken);
          hubPoolClient.mapTokenInfo(deposit.outputToken, token.symbol, token.decimals);
          const tokenPriceUsd = profitClient.getPriceOfToken(token.symbol);

          // Normalise any tokens with <18 decimals to 18 decimals.
          const scaledInputAmount = deposit.inputAmount.mul(bn10.pow(18 - token.decimals));
          const scaledOutputAmount = deposit.outputAmount.mul(bn10.pow(18 - token.decimals));

          const inputAmountUsd = scaledInputAmount.mul(tokenPriceUsd).div(fixedPoint);
          const outputAmountUsd = scaledOutputAmount.mul(tokenPriceUsd).div(fixedPoint);
          const gasCostPct = gasCostUsd.mul(fixedPoint).div(outputAmountUsd);

          for (const lpFeeMultiplier of lpFeeMultipliers) {
            const effectiveLpFeePct = lpFeePct.mul(lpFeeMultiplier).div(fixedPoint);
            const lpFeeUsd = inputAmountUsd.mul(effectiveLpFeePct).div(fixedPoint);

            const expected = testProfitability(inputAmountUsd, outputAmountUsd, gasCostUsd, lpFeeUsd);
            spyLogger.debug({
              message: `Expect ${token.symbol} deposit is ${expected.profitable ? "" : "un"}profitable:`,
              inputAmount: formatEther(scaledInputAmount),
              inputAmountUsd: formatEther(inputAmountUsd),
              outputAmount: formatEther(scaledOutputAmount),
              outputAmountUsd: formatEther(outputAmountUsd),
              lpFeeMultiplier: `${formatEther(lpFeeMultiplier)}`,
              lpFeePct: `${formatFeePct(effectiveLpFeePct)}`,
              lpFeeUsd: formatEther(lpFeeUsd),
              gasCostUsd: formatEther(gasCostUsd),
              gasCostPct: `${formatFeePct(gasCostPct)} %`,
              grossRelayerFeeUsd: formatEther(expected.grossRelayerFeeUsd),
              minRelayerFeePct: `${formatFeePct(minRelayerFeePct)} %`,
              minRelayerFeeUsd: formatEther(minRelayerFeePct.mul(outputAmountUsd).div(fixedPoint)),
              netRelayerFeePct: `${formatFeePct(expected.netRelayerFeePct)} %`,
              netRelayerFeeUsd: formatEther(expected.netRelayerFeeUsd),
            });

            const { profitable } = await profitClient.isFillProfitable(
              deposit,
              effectiveLpFeePct,
              token,
              destinationChainId
            );
            expect(profitable).to.equal(expected.profitable);
          }
        }
      }
    }
  });

  it("Allows per-route and per-token fee configuration", () => {
    // Setup custom USDC pricing to Optimism and Arbitrum.
    chainIds.forEach((srcChainId) => {
      process.env[`MIN_RELAYER_FEE_PCT_USDC_${srcChainId}_10`] = Math.random().toFixed(10).toString();
      process.env[`MIN_RELAYER_FEE_PCT_USDC_${srcChainId}_42161`] = "0.00005";
    });

    // Also set a default fee for USDC.
    const minUSDC = "0.00001";
    const minUSDCKey = "MIN_RELAYER_FEE_PCT_USDC";
    const initialMinUSDC = process.env[minUSDCKey];
    process.env[minUSDCKey] = minUSDC;

    const envPrefix = "MIN_RELAYER_FEE_PCT";
    ["USDC", "DAI", "WETH", "WBTC"].forEach((symbol) => {
      chainIds.forEach((srcChainId) => {
        chainIds
          .filter((chainId) => chainId !== srcChainId)
          .forEach((dstChainId) => {
            const tokenEnvVar = `${envPrefix}_${symbol}`;
            const routeEnvVar = `${tokenEnvVar}_${srcChainId}_${dstChainId}`;
            const routeFee = process.env[routeEnvVar] ?? process.env[tokenEnvVar];
            const routeMinRelayerFeePct = routeFee ? toBNWei(routeFee) : minRelayerFeePct;
            if (!routeFee && symbol === "USDC") {
              expect(routeMinRelayerFeePct.eq(toBNWei(minUSDC))).to.be.true;
            }

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
            if (routeEnvVar) {
              process.env[routeEnvVar] = undefined;
            }

            expect(computedMinRelayerFeePct.eq(routeMinRelayerFeePct)).to.be.true;
          });
      });
    });
    process.env[minUSDCKey] = initialMinUSDC;
  });

  it("Considers updated deposits", async () => {
    const deposit = { ...v3DepositTemplate };
    const l1Token = tokens.WETH;
    hubPoolClient.setTokenMapping(l1Token.address, originChainId, deposit.inputToken);
    hubPoolClient.mapTokenInfo(deposit.outputToken, l1Token.symbol, l1Token.decimals);
    randomiseGasCost(destinationChainId);

    const outputTokenPriceUsd = profitClient.getPriceOfToken(l1Token.symbol);
    let expectedOutputAmountUsd = deposit.outputAmount.mul(outputTokenPriceUsd).div(fixedPoint);
    let fill = await profitClient.calculateFillProfitability(deposit, zeroLPFee, minRelayerFeePct);
    expect(fill.outputAmountUsd.eq(expectedOutputAmountUsd)).to.be.true;

    deposit.updatedOutputAmount = deposit.outputAmount.div(10);
    expectedOutputAmountUsd = deposit.updatedOutputAmount.mul(outputTokenPriceUsd).div(fixedPoint);
    fill = await profitClient.calculateFillProfitability(deposit, zeroLPFee, minRelayerFeePct);
    expect(fill.outputAmountUsd.eq(expectedOutputAmountUsd)).to.be.true;
  });

  it("Ignores updatedOutputAmount if it's higher than original outputAmount", async () => {
    const updatedOutputAmount = v3DepositTemplate.outputAmount.add(bnOne);
    const deposit = { ...v3DepositTemplate, updatedOutputAmount };

    hubPoolClient.setTokenMapping(tokens.WETH.address, originChainId, deposit.inputToken);
    hubPoolClient.mapTokenInfo(deposit.outputToken, tokens.WETH.symbol, tokens.WETH.decimals);
    const outputTokenPriceUsd = profitClient.getPriceOfToken(tokens.WETH.symbol);

    let expectedOutputAmountUsd = deposit.outputAmount.mul(outputTokenPriceUsd).div(fixedPoint);
    let fill = await profitClient.calculateFillProfitability(deposit, zeroLPFee, minRelayerFeePct);
    expect(fill.outputAmountUsd.eq(expectedOutputAmountUsd)).to.be.true;

    deposit.updatedOutputAmount = deposit.outputAmount.sub(bnOne);
    expectedOutputAmountUsd = deposit.updatedOutputAmount.mul(outputTokenPriceUsd).div(fixedPoint);
    fill = await profitClient.calculateFillProfitability(deposit, zeroLPFee, minRelayerFeePct);
    expect(fill.outputAmountUsd.eq(expectedOutputAmountUsd)).to.be.true;
  });

  it("Captures unprofitable fills", () => {
    const deposit = {
      ...v3DepositTemplate,
      quoteBlockNumber: 0,
      blockNumber: 0,
      transactionHash: "",
      transactionIndex: 0,
      logIndex: 0,
    };
    const relayerFeePct = toBNWei("0.001");
    const lpFeePct = toBNWei("0.002");
    const gasCost = toGWei("0.003");

    profitClient.captureUnprofitableFill(deposit, lpFeePct, relayerFeePct, gasCost);
    expect(profitClient.getUnprofitableFills()).to.deep.equal({
      [deposit.originChainId]: [{ deposit, lpFeePct, relayerFeePct, gasCost }],
    });
  });
});
