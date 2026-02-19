import { assert } from "chai";
import { random } from "lodash";
import { constants as sdkConstants, utils as sdkUtils } from "@across-protocol/sdk";
import { ConfigStoreClient, FillProfit, EVMSpokePoolClient } from "../src/clients";
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
  toAddressType,
  EvmAddress,
  SvmAddress,
  ZERO_BYTES,
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
    depositor: toAddressType(randomAddress(), originChainId),
    recipient: toAddressType(randomAddress(), destinationChainId),
    inputToken: toAddressType(randomAddress(), originChainId),
    inputAmount: outputAmount.mul(fixedPoint).div(fixedPoint.sub(lpFeePct.add(relayerFeePct).add(gasFeePct))),
    outputToken: toAddressType(randomAddress(), destinationChainId),
    outputAmount,
    quoteTimestamp: now,
    message: sdkConstants.EMPTY_MESSAGE,
    fillDeadline: now,
    exclusivityDeadline: 0,
    exclusiveRelayer: toAddressType(ZERO_ADDRESS, destinationChainId),
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
    ["POL", "USDC", "WBTC", "WETH"].map((symbol) => {
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
        const spokePoolClient = new EVMSpokePoolClient(
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
      EvmAddress.from(randomAddress()),
      SvmAddress.from(ZERO_BYTES),
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
          const inputToken = toAddressType(randomAddress(), originChainId);
          const outputToken = toAddressType(randomAddress(), destinationChainId);

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
          hubPoolClient.setTokenMapping(token.address, deposit.originChainId, deposit.inputToken.toNative());
          hubPoolClient.mapTokenInfo(deposit.outputToken, token.symbol, token.decimals);
          hubPoolClient.mapTokenInfo(deposit.inputToken, token.symbol, token.decimals);
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
          const inputToken = toAddressType(randomAddress(), originChainId);
          const outputToken = toAddressType(randomAddress(), destinationChainId);

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
          hubPoolClient.setTokenMapping(token.address, deposit.originChainId, deposit.inputToken.toNative());
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
    ["USDC", "WETH", "WBTC"].forEach((symbol) => {
      profitClient.setTokenSymbol(tokens[symbol].address, symbol);
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

            const computedMinRelayerFeePct = profitClient.minRelayerFeePct({
              inputToken: EvmAddress.from(tokens[symbol].address),
              originChainId: srcChainId,
              outputToken: EvmAddress.from(ZERO_ADDRESS),
              destinationChainId: dstChainId,
            });
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
              delete process.env[routeEnvVar];
            }

            expect(computedMinRelayerFeePct.eq(routeMinRelayerFeePct)).to.be.true;
          });
      });
    });
    process.env[minUSDCKey] = initialMinUSDC;
  });

  it("Per-route and per-token configuration priority", () => {
    // Verify minRelayerFeePct lookup precedence:
    // routeKey -> destinationChainKey -> tokenKey.
    // Also verify tokenKey with src+dst symbols is used ahead of src-only key.
    profitClient.setTokenSymbol(tokens.USDC.address, "USDC");
    profitClient.setTokenSymbol(tokens.WETH.address, "WETH");

    const minRouteFee = "0.00041";
    const minDestinationChainFee = "0.00031";
    const minPairTokenFee = "0.00021";
    const minSrcTokenFee = "0.00011";

    const pairTokenKey = "MIN_RELAYER_FEE_PCT_USDC_WETH";
    const srcTokenKey = "MIN_RELAYER_FEE_PCT_USDC";
    const destinationChainKey = `MIN_RELAYER_FEE_PCT_${destinationChainId}`;
    const routeKey = `${pairTokenKey}_${originChainId}_${destinationChainId}`;

    const initialRouteFee = process.env[routeKey];
    const initialDestinationChainFee = process.env[destinationChainKey];
    const initialPairTokenFee = process.env[pairTokenKey];
    const initialSrcTokenFee = process.env[srcTokenKey];
    const restoreEnvKey = (key: string, value: string | undefined): void => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    };

    const deposit = {
      inputToken: EvmAddress.from(tokens.USDC.address),
      originChainId,
      outputToken: EvmAddress.from(tokens.WETH.address),
      destinationChainId,
    };

    try {
      // 1) route key has highest precedence.
      process.env[routeKey] = minRouteFee;
      process.env[destinationChainKey] = minDestinationChainFee;
      process.env[pairTokenKey] = minPairTokenFee;
      process.env[srcTokenKey] = minSrcTokenFee;
      const computedFromRoute = profitClient.minRelayerFeePct(deposit);
      expect(computedFromRoute.eq(toBNWei(minRouteFee))).to.be.true;

      // 2) destination-chain key has higher precedence than token key.
      const uncachedOriginChain = originChainId + 999;
      const uncachedRouteKey = `${pairTokenKey}_${uncachedOriginChain}_${destinationChainId}`;
      delete process.env[uncachedRouteKey];
      const computedFromDestinationChain = profitClient.minRelayerFeePct({
        ...deposit,
        originChainId: uncachedOriginChain,
      });
      expect(computedFromDestinationChain.eq(toBNWei(minDestinationChainFee))).to.be.true;

      // 3) pair-token key takes precedence over src-only token key.
      delete process.env[destinationChainKey];
      const anotherUncachedOriginChain = originChainId + 1999;
      const anotherUncachedRouteKey = `${pairTokenKey}_${anotherUncachedOriginChain}_${destinationChainId}`;
      delete process.env[anotherUncachedRouteKey];
      const computedFromPairToken = profitClient.minRelayerFeePct({
        ...deposit,
        originChainId: anotherUncachedOriginChain,
      });
      expect(computedFromPairToken.eq(toBNWei(minPairTokenFee))).to.be.true;

      // 4) falls back to default min fee when no env key is set.
      delete process.env[pairTokenKey];
      delete process.env[srcTokenKey];
      const defaultFallbackOriginChain = originChainId + 2999;
      const defaultFallbackRouteKey = `${pairTokenKey}_${defaultFallbackOriginChain}_${destinationChainId}`;
      delete process.env[defaultFallbackRouteKey];
      const computedFromDefault = profitClient.minRelayerFeePct({
        ...deposit,
        originChainId: defaultFallbackOriginChain,
      });
      expect(computedFromDefault.eq(minRelayerFeePct)).to.be.true;
    } finally {
      restoreEnvKey(routeKey, initialRouteFee);
      restoreEnvKey(destinationChainKey, initialDestinationChainFee);
      restoreEnvKey(pairTokenKey, initialPairTokenFee);
      restoreEnvKey(srcTokenKey, initialSrcTokenFee);
    }
  });

  it("Considers updated deposits", async () => {
    const deposit = { ...v3DepositTemplate };
    const l1Token = tokens.WETH;
    hubPoolClient.setTokenMapping(l1Token.address, originChainId, deposit.inputToken.toEvmAddress());
    hubPoolClient.mapTokenInfo(deposit.outputToken, l1Token.symbol, l1Token.decimals);
    hubPoolClient.mapTokenInfo(deposit.inputToken, l1Token.symbol, l1Token.decimals);
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

    hubPoolClient.setTokenMapping(tokens.WETH.address, originChainId, deposit.inputToken.toEvmAddress());
    hubPoolClient.mapTokenInfo(deposit.outputToken, tokens.WETH.symbol, tokens.WETH.decimals);
    hubPoolClient.mapTokenInfo(deposit.inputToken, tokens.WETH.symbol, tokens.WETH.decimals);
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
