import {
  assertPromiseError,
  BigNumber,
  SignerWithAddress,
  createSpyLogger,
  deployConfigStore,
  ethers,
  expect,
  hubPoolFixture,
  lastSpyLogIncludes,
  sinon,
  toBNWei,
  toWei,
  winston,
  spyLogIncludes,
  randomAddress,
} from "./utils";

import { ConfigStoreClient, InventoryClient } from "../src/clients"; // Tested
import { CrossChainTransferClient } from "../src/clients/bridges";
import { Deposit, InventoryConfig, SwapRoute } from "../src/interfaces";
import {
  CHAIN_IDs,
  ZERO_ADDRESS,
  bnZero,
  getNetworkName,
  parseUnits,
  TOKEN_SYMBOLS_MAP,
  toAddressType,
  depositForcesOriginChainRepayment,
  EvmAddress,
} from "../src/utils";
import { MockAdapterManager, MockHubPoolClient, MockInventoryClient, MockTokenClient } from "./mocks";
import { utils as sdkUtils } from "@across-protocol/sdk";
import { MockRebalancerClient } from "./mocks/MockRebalancerClient";

describe("InventoryClient: Refund chain selection", async function () {
  const { MAINNET, OPTIMISM, POLYGON, ARBITRUM, BSC } = CHAIN_IDs;
  const enabledChainIds = [MAINNET, OPTIMISM, POLYGON, ARBITRUM, BSC];
  const mainnetWeth = TOKEN_SYMBOLS_MAP.WETH.addresses[MAINNET];
  const mainnetUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[MAINNET];

  let hubPoolClient: MockHubPoolClient, adapterManager: MockAdapterManager, tokenClient: MockTokenClient;
  let mockRebalancerClient: MockRebalancerClient;
  let owner: SignerWithAddress, spy: sinon.SinonSpy, spyLogger: winston.Logger;
  let inventoryClient: InventoryClient; // tested
  let sampleDepositData: Deposit;
  let crossChainTransferClient: CrossChainTransferClient;

  // construct two mappings of chainId to token address. Set the l1 token address to the "real" token address.
  const l2TokensForWeth = { [MAINNET]: mainnetWeth };
  const l2TokensForUsdc = { [MAINNET]: mainnetUsdc };
  enabledChainIds
    .filter((chainId) => chainId !== MAINNET)
    .forEach((chainId) => {
      l2TokensForWeth[chainId] = TOKEN_SYMBOLS_MAP.WETH.addresses[chainId];
      if (chainId !== BSC) {
        l2TokensForUsdc[chainId] = TOKEN_SYMBOLS_MAP["USDC.e"].addresses[chainId];
      } else {
        l2TokensForUsdc[chainId] = TOKEN_SYMBOLS_MAP["USDC-BNB"].addresses[chainId];
      }
    });

  const toMegaWei = (num: string | number | BigNumber) => parseUnits(num.toString(), 6);
  // Configure thresholds percentages as 10% optimism, 5% polygon and 5% Arbitrum with a target being threshold +2%.
  const targetOverageBuffer = toWei(1);
  const inventoryConfig: InventoryConfig = {
    wrapEtherTargetPerChain: {},
    wrapEtherTarget: toWei(1),
    wrapEtherThresholdPerChain: {},
    wrapEtherThreshold: toWei(1),
    allowedSwapRoutes: [],
    repaymentChainOverride: undefined,
    repaymentChainOverridePerChain: {},
    forceOriginRepayment: undefined,
    forceOriginRepaymentPerChain: {},
    tokenConfig: {
      [mainnetWeth]: {
        [OPTIMISM]: { targetPct: toWei(0.12), thresholdPct: toWei(0.1), targetOverageBuffer },
        [POLYGON]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
        [ARBITRUM]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
        [BSC]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
      },
      [mainnetUsdc]: {
        [OPTIMISM]: { targetPct: toWei(0.12), thresholdPct: toWei(0.1), targetOverageBuffer },
        [POLYGON]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
        [ARBITRUM]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
        [BSC]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
      },
    },
  };

  // Construct an initial distribution that keeps these values within the above thresholds.
  const initialAllocation = {
    [MAINNET]: { [mainnetWeth]: toWei(100), [mainnetUsdc]: toMegaWei(10000) }, // seed 100 WETH and 10000 USDC on Mainnet
    [OPTIMISM]: { [mainnetWeth]: toWei(20), [mainnetUsdc]: toMegaWei(2000) }, // seed 20 WETH and 2000 USDC on Optimism
    [POLYGON]: { [mainnetWeth]: toWei(10), [mainnetUsdc]: toMegaWei(1000) }, // seed 10 WETH and 1000 USDC on Polygon
    [ARBITRUM]: { [mainnetWeth]: toWei(10), [mainnetUsdc]: toMegaWei(1000) }, // seed 10 WETH and 1000 USDC on Arbitrum
  };

  const seedMocks = (seedBalances: { [chainId: string]: { [token: string]: BigNumber } }) => {
    const wethEVMAddress = EvmAddress.from(mainnetWeth);
    const usdcEVMAddress = EvmAddress.from(mainnetUsdc);
    hubPoolClient.addL1Token({ address: wethEVMAddress, decimals: 18, symbol: "WETH" });
    hubPoolClient.addL1Token({ address: usdcEVMAddress, decimals: 6, symbol: "USDC" });
    Object.keys(seedBalances).forEach((_chainId) => {
      const chainId = Number(_chainId);
      adapterManager.setMockedOutstandingCrossChainTransfers(
        chainId,
        toAddressType(owner.address, MAINNET),
        wethEVMAddress,
        bnZero
      );
      adapterManager.setMockedOutstandingCrossChainTransfers(
        chainId,
        toAddressType(owner.address, MAINNET),
        usdcEVMAddress,
        bnZero
      );
      tokenClient.setTokenData(
        chainId,
        toAddressType(l2TokensForWeth[chainId], chainId),
        seedBalances[chainId][mainnetWeth]
      );

      const l2TokenForUsdcAddress = toAddressType(l2TokensForUsdc[chainId], chainId);
      tokenClient.setTokenData(chainId, l2TokenForUsdcAddress, seedBalances[chainId][mainnetUsdc]);
      hubPoolClient.setTokenMapping(mainnetWeth, chainId, l2TokensForWeth[chainId]);
      hubPoolClient.setTokenMapping(mainnetUsdc, chainId, l2TokensForUsdc[chainId]);
      hubPoolClient.mapTokenInfo(l2TokenForUsdcAddress, "USDC", 6);
      hubPoolClient.mapTokenInfo(wethEVMAddress, "WETH", 18);
    });
  };

  const computeOutputAmount = async (deposit: Deposit) => {
    return deposit.inputAmount;
  };

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spy, spyLogger } = createSpyLogger());

    const { hubPool, dai: l1Token } = await hubPoolFixture();
    const { configStore } = await deployConfigStore(owner, [l1Token]);

    const configStoreClient = new ConfigStoreClient(spyLogger, configStore);
    await configStoreClient.update();

    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);
    hubPoolClient.setDefaultRealizedLpFeePct(bnZero);
    await hubPoolClient.update();

    adapterManager = new MockAdapterManager(null, null, null, null);
    tokenClient = new MockTokenClient(null, null, null, null);

    crossChainTransferClient = new CrossChainTransferClient(spyLogger, enabledChainIds, adapterManager);
    mockRebalancerClient = new MockRebalancerClient(spyLogger);
    inventoryClient = new MockInventoryClient(
      toAddressType(owner.address, MAINNET),
      spyLogger,
      inventoryConfig,
      tokenClient,
      enabledChainIds,
      hubPoolClient,
      adapterManager,
      crossChainTransferClient,
      mockRebalancerClient,
      false, // simMode
      false // prioritizeUtilization
    );
    (inventoryClient as MockInventoryClient).setTokenMapping({
      [mainnetWeth]: {
        [MAINNET]: mainnetWeth,
        [OPTIMISM]: l2TokensForWeth[OPTIMISM],
        [POLYGON]: l2TokensForWeth[POLYGON],
        [ARBITRUM]: l2TokensForWeth[ARBITRUM],
        [BSC]: l2TokensForWeth[BSC],
      },
      [mainnetUsdc]: {
        [MAINNET]: mainnetUsdc,
        [OPTIMISM]: l2TokensForUsdc[OPTIMISM],
        [POLYGON]: l2TokensForUsdc[POLYGON],
        [ARBITRUM]: l2TokensForUsdc[ARBITRUM],
        [BSC]: l2TokensForUsdc[BSC],
      },
    });
    (inventoryClient as MockInventoryClient).setUpcomingRefunds(mainnetWeth, {});

    seedMocks(initialAllocation);
  });

  describe("Invariant tests", function () {
    beforeEach(async function () {
      const inputAmount = toBNWei(1);
      sampleDepositData = {
        depositId: bnZero,
        fromLiteChain: false,
        toLiteChain: false,
        originChainId: ARBITRUM,
        destinationChainId: OPTIMISM,
        depositor: toAddressType(owner.address, MAINNET),
        recipient: toAddressType(owner.address, MAINNET),
        inputToken: toAddressType(l2TokensForWeth[ARBITRUM], ARBITRUM),
        inputAmount,
        outputToken: toAddressType(l2TokensForWeth[OPTIMISM], OPTIMISM),
        outputAmount: inputAmount,
        message: "0x",
        messageHash: "0x",
        quoteTimestamp: hubPoolClient.currentTime!,
        fillDeadline: 0,
        exclusivityDeadline: 0,
        exclusiveRelayer: toAddressType(ZERO_ADDRESS, MAINNET),
      };
    });

    it("Correctly factors in pending L2->L1 withdrawals when deciding where to refund", async function () {
      // This fakes a 10 WETH pending withdrawal on each L2 chain, of which there are 4, so the cumulative balance
      // should go from 140 to 180.
      adapterManager.setL2PendingWithdrawalAmount(7200, toWei(10));
      await inventoryClient.update();

      await inventoryClient.determineRefundChainId(sampleDepositData);
      expect(spyLogIncludes(spy, -1, 'cumulativeVirtualBalance":"180000000000000000000"')).to.be.true;
    });

    it("Normalizes repayment amount to correct precision", async function () {
      // We'll pretend the input token uses a different precision than the output token.
      hubPoolClient.mapTokenInfo(toAddressType(l2TokensForWeth[ARBITRUM], ARBITRUM), "WETH", 6);
      const toL2Decimals = sdkUtils.ConvertDecimals(18, 6);
      tokenClient.setTokenData(
        ARBITRUM,
        toAddressType(l2TokensForWeth[ARBITRUM], ARBITRUM),
        toL2Decimals(initialAllocation[ARBITRUM][mainnetWeth])
      );
      sampleDepositData.inputAmount = toMegaWei(1);

      // Check that expected post relay allocations are in correct precision:
      // Starts with 20 tokens on Optimism and ends up with 20 post-repayment.
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([MAINNET]);
      expect(spyLogIncludes(spy, -2, 'expectedPostRelayAllocation":"142857142857142857"')).to.be.true; // (20)/(140)=0.1428
      // Starts with 10 tokens on Arbitrum and ends up with 11 post-repayment.
      expect(spyLogIncludes(spy, -1, 'expectedPostRelayAllocation":"78571428571428571"')).to.be.true; // (10+1)/(140)=0.15

      // Now, transfer away tokens from the origin chain to make it look under allocated:
      tokenClient.setTokenData(ARBITRUM, toAddressType(l2TokensForWeth[ARBITRUM], ARBITRUM), toMegaWei(5));
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([ARBITRUM, MAINNET]);
      expect(spyLogIncludes(spy, -1, 'expectedPostRelayAllocation":"44444444444444444"')).to.be.true; // (5+1)/(135)=0.044444

      // If we set the fill amount large enough, the origin chain choice won't be picked anymore.
      sampleDepositData.inputAmount = toMegaWei(5);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([MAINNET]);
      expect(spyLogIncludes(spy, -1, 'expectedPostRelayAllocation":"74074074074074074"')).to.be.true; // (5+5)/(135)=0.074074
    });

    it("Normalizes upcoming refunds to correct precision", async function () {
      // Identical setup to previous test but we'll pretend the L2 token uses a different precision than the L1 token.
      hubPoolClient.mapTokenInfo(toAddressType(l2TokensForWeth[OPTIMISM], OPTIMISM), "WETH", 6);
      tokenClient.setTokenData(OPTIMISM, toAddressType(l2TokensForWeth[OPTIMISM], OPTIMISM), toMegaWei(15));

      sampleDepositData.inputAmount = toWei(5);
      sampleDepositData.outputAmount = sdkUtils.ConvertDecimals(18, 6)(await computeOutputAmount(sampleDepositData));
      (inventoryClient as MockInventoryClient).setUpcomingRefunds(mainnetWeth, {
        [MAINNET]: toWei(5),
        [OPTIMISM]: toMegaWei(10),
      });
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([MAINNET]);

      // Check that the cumulative balance post refunds accounts exactly for the sum of the upcoming refunds.
      expect(lastSpyLogIncludes(spy, 'cumulativeVirtualBalance":"135000000000000000000')).to.be.true;
      expect(lastSpyLogIncludes(spy, 'cumulativeVirtualBalancePostRefunds":"150000000000000000000')).to.be.true;
    });

    it("Correctly throws when Deposit tokens are not equivalent", async function () {
      sampleDepositData.inputAmount = toWei(5);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([1]);

      // In this test, output token has a valid pool rebalance mapping but its not the equivalent token as the
      // input token
      sampleDepositData.outputToken = toAddressType(l2TokensForUsdc[OPTIMISM], OPTIMISM);
      const srcChain = getNetworkName(sampleDepositData.originChainId);
      const dstChain = getNetworkName(sampleDepositData.destinationChainId);
      await assertPromiseError(
        inventoryClient.determineRefundChainId(sampleDepositData),
        `Unexpected ${dstChain} output token on ${srcChain} deposit`
      );

      sampleDepositData.outputToken = toAddressType(randomAddress(), MAINNET);
      await assertPromiseError(
        inventoryClient.determineRefundChainId(sampleDepositData),
        `Unexpected ${dstChain} output token on ${srcChain} deposit`
      );
    });

    it("Allows user to define swap routes", async function () {
      const swapRoutes: SwapRoute[] = [
        {
          fromChain: POLYGON,
          fromToken: l2TokensForWeth[POLYGON],
          toChain: OPTIMISM,
          toToken: l2TokensForUsdc[OPTIMISM],
          bidirectional: false,
        },
      ];
      const _inventoryClient = new MockInventoryClient(
        toAddressType(owner.address, MAINNET),
        spyLogger,
        {
          ...inventoryConfig,
          allowedSwapRoutes: swapRoutes,
        },
        tokenClient,
        enabledChainIds,
        hubPoolClient,
        adapterManager,
        crossChainTransferClient,
        mockRebalancerClient,
        false, // simMode
        false // prioritizeUtilization
      );

      expect(
        await _inventoryClient.isSwapSupported(
          toAddressType(l2TokensForWeth[POLYGON], POLYGON),
          toAddressType(l2TokensForUsdc[OPTIMISM], OPTIMISM),
          POLYGON,
          OPTIMISM
        )
      ).to.be.true;
      // Should throw since its not a supported swap route:
      await assertPromiseError(
        _inventoryClient.determineRefundChainId(sampleDepositData),
        `Unexpected ${getNetworkName(sampleDepositData.destinationChainId)} output token on ${getNetworkName(
          sampleDepositData.originChainId
        )} deposit`
      );
    });

    it("allows swap routes to be defined for all chains", async function () {
      const swapRoutes: SwapRoute[] = [
        {
          fromChain: "ALL",
          fromToken: l2TokensForWeth[POLYGON],
          toChain: "ALL",
          toToken: l2TokensForUsdc[OPTIMISM],
          bidirectional: false,
        },
      ];
      const _inventoryClient = new MockInventoryClient(
        toAddressType(owner.address, MAINNET),
        spyLogger,
        {
          ...inventoryConfig,
          allowedSwapRoutes: swapRoutes,
        },
        tokenClient,
        enabledChainIds,
        hubPoolClient,
        adapterManager,
        crossChainTransferClient,
        mockRebalancerClient,
        false, // simMode
        false // prioritizeUtilization
      );
      expect(
        await _inventoryClient.isSwapSupported(
          toAddressType(l2TokensForWeth[POLYGON], POLYGON),
          toAddressType(l2TokensForUsdc[OPTIMISM], OPTIMISM),
          POLYGON,
          OPTIMISM
        )
      ).to.be.true;
      // Should not throw:
      await assertPromiseError(
        _inventoryClient.determineRefundChainId(sampleDepositData),
        `Unexpected ${getNetworkName(sampleDepositData.destinationChainId)} output token on ${getNetworkName(
          sampleDepositData.originChainId
        )} deposit`
      );
    });

    it("token config is not defined", async function () {
      // Defaults to destination chain.
      const _inventoryClient = new MockInventoryClient(
        toAddressType(owner.address, MAINNET),
        spyLogger,
        {
          ...inventoryConfig,
          tokenConfig: {},
        },
        tokenClient,
        enabledChainIds,
        hubPoolClient,
        adapterManager,
        crossChainTransferClient,
        mockRebalancerClient,
        false, // simMode
        false // prioritizeUtilization
      );
      _inventoryClient.setTokenMapping({
        [mainnetWeth]: {
          [sampleDepositData.originChainId]: sampleDepositData.inputToken.toEvmAddress(),
          [sampleDepositData.destinationChainId]: sampleDepositData.outputToken.toEvmAddress(),
        },
      });
      expect(await _inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([
        sampleDepositData.destinationChainId,
      ]);
    });
    it("includes origin, destination, and hub chain in repayment chain list", async function () {
      // In the case of a deposit that doesn't force origin chain repayment, the possible repayment chain
      // list should include the origin, destination, and hub chain.
      const possibleRepaymentChains = inventoryClient.getPossibleRepaymentChainIds(sampleDepositData);
      [sampleDepositData.originChainId, sampleDepositData.destinationChainId, hubPoolClient.chainId].forEach(
        (chainId) => {
          expect(possibleRepaymentChains).to.include(chainId);
        }
      );
    });
  });

  describe("lifecycle tests", function () {
    beforeEach(async function () {
      const inputAmount = toBNWei(1);
      sampleDepositData = {
        depositId: bnZero,
        fromLiteChain: false,
        toLiteChain: false,
        originChainId: POLYGON,
        destinationChainId: OPTIMISM,
        depositor: toAddressType(owner.address, MAINNET),
        recipient: toAddressType(owner.address, MAINNET),
        inputToken: toAddressType(l2TokensForWeth[POLYGON], POLYGON),
        inputAmount,
        outputToken: toAddressType(l2TokensForWeth[OPTIMISM], OPTIMISM),
        outputAmount: inputAmount,
        message: "0x",
        messageHash: "0x",
        quoteTimestamp: hubPoolClient.currentTime!,
        fillDeadline: 0,
        exclusivityDeadline: 0,
        exclusiveRelayer: toAddressType(ZERO_ADDRESS, MAINNET),
      };
    });
    it("Both origin and destination chain allocations are below target, returns destination before origin followed by mainnet", async function () {
      // Set chain allocations lower than target, resulting in a cumulative starting balance of 116.
      tokenClient.setTokenData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), toWei(1));
      tokenClient.setTokenData(OPTIMISM, toAddressType(l2TokensForWeth[OPTIMISM], OPTIMISM), toWei(5));

      // Post relay allocations:
      // Optimism (destination chain): (5)/(116)=4.3% < 12%
      // Polygon (origin chain): (1+5)/(116)=5.2% < 7%
      // Relayer should choose to refund on destination over origin if both are under allocated
      sampleDepositData.inputAmount = toWei(5);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([
        OPTIMISM,
        POLYGON,
        MAINNET,
      ]);
      expect(spyLogIncludes(spy, -2, 'expectedPostRelayAllocation":"43103448275862068"')).to.be.true;
      expect(spyLogIncludes(spy, -1, 'expectedPostRelayAllocation":"51724137931034482"')).to.be.true;
    });
    it("Origin chain allocation does not depend on subtracting from numerator", async function () {
      // Post relay allocation adds repayment amount to chain virtual balance, unlike
      // accounting for destination chain allocation

      // Set Polygon allocation just higher than target. This is set so that any additions
      // to the numerator send it over allocated. Starting cumulative balance is 135.
      tokenClient.setTokenData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), toWei(5));

      // Post relay allocations:
      // Optimism (destination chain): (20)/(135)= > 12%
      // Polygon (origin chain): (5+10)/(135)= > 7%
      // Relayer should default to hub chain.
      sampleDepositData.inputAmount = toWei(10);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([MAINNET]);
      expect(spyLogIncludes(spy, -2, 'expectedPostRelayAllocation":"148148148148148148"')).to.be.true;
      expect(spyLogIncludes(spy, -1, 'expectedPostRelayAllocation":"111111111111111111"')).to.be.true;
    });
    it("Origin allocation is below target", async function () {
      // Set Polygon allocation lower than target:
      tokenClient.setTokenData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), toWei(0));

      // Post relay allocations:
      // Optimism (destination chain): (20)/(130) > 12%
      // Polygon (origin chain): (5)/(130)= < 7%
      // Relayer should choose to refund origin since destination isn't an option.
      sampleDepositData.inputAmount = toWei(5);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([POLYGON, MAINNET]);
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"38461538461538461"')).to.be.true;
    });
    it("Origin allocation depends on outstanding transfers", async function () {
      // Set Polygon allocation lower than target:
      tokenClient.setTokenData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), toWei(0));

      // Post relay allocations:
      // Optimism (destination chain): (20)/(130) > 12%
      // Polygon (origin chain): (5)/(130)= < 7%
      // Relayer should choose to refund origin since destination isn't an option.
      sampleDepositData.inputAmount = toWei(5);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([POLYGON, MAINNET]);

      // Now add outstanding transfers to Polygon that make the allocation above the target. Note that this
      // increases cumulative balance a bit.
      adapterManager.setMockedOutstandingCrossChainTransfers(
        POLYGON,
        toAddressType(owner.address, MAINNET),
        toAddressType(mainnetWeth, MAINNET),
        toWei(10)
      );
      await inventoryClient.update();

      // Post relay allocations:
      // Optimism (destination chain): (20)/(140) > 12%
      // Polygon (origin chain): (5+10)/(140) > 7%
      // Relayer should now default to hub chain.
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([MAINNET]);
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"107142857142857142"')).to.be.true;
    });
    it("Origin allocation depends on short falls", async function () {
      // Set Polygon allocation lower than target:
      tokenClient.setTokenData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), toWei(5));
      tokenClient.setTokenData(OPTIMISM, toAddressType(l2TokensForWeth[OPTIMISM], OPTIMISM), toWei(25));

      // Shortfalls are subtracted from just numerator
      tokenClient.setTokenShortFallData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), [6969], [toWei(5)]); // Mock the shortfall.
      // Post relay allocations:
      // Optimism (destination chain): (25-5)/(140) > 12%
      // Polygon (origin chain): (5-5+1)/(140) < 7%
      // Relayer should still use origin chain
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([POLYGON, MAINNET]);
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"7142857142857142"')).to.be.true;
    });
    it("Origin allocation depends on upcoming refunds", async function () {
      // Set Polygon allocation lower than target:
      tokenClient.setTokenData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), toWei(0));

      // Post relay allocations:
      // Optimism (destination chain): (20)/(130) > 12%
      // Polygon (origin chain): (5)/(130) < 7%
      // Relayer should use origin chain
      sampleDepositData.inputAmount = toWei(5);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);

      (inventoryClient as MockInventoryClient).setUpcomingRefunds(mainnetWeth, {
        [POLYGON]: toWei(5),
      });

      // Post relay allocations:
      // Optimism (destination chain): (20)/(130+5) > 12%
      // Polygon (origin chain): (5+5)/(130+5) > 7%
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([MAINNET]);
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"74074074074074074"')).to.be.true;
    });
    it("includes origin, destination and hub chain in repayment chain list", async function () {
      const possibleRepaymentChains = inventoryClient.getPossibleRepaymentChainIds(sampleDepositData);
      [sampleDepositData.originChainId, sampleDepositData.destinationChainId, MAINNET].forEach((chainId) => {
        expect(possibleRepaymentChains).to.include(chainId);
      });
    });
  });

  describe("origin chain is a lite chain", function () {
    beforeEach(async function () {
      const inputAmount = toBNWei(1);
      sampleDepositData = {
        depositId: bnZero,
        fromLiteChain: true, // Pretend Polygon is a lite chain.
        toLiteChain: false,
        originChainId: POLYGON,
        destinationChainId: ARBITRUM,
        depositor: toAddressType(owner.address, MAINNET),
        recipient: toAddressType(owner.address, MAINNET),
        inputToken: toAddressType(l2TokensForWeth[POLYGON], POLYGON),
        inputAmount,
        outputToken: toAddressType(l2TokensForWeth[ARBITRUM], ARBITRUM),
        outputAmount: inputAmount,
        message: "0x",
        messageHash: "0x",
        quoteTimestamp: hubPoolClient.currentTime!,
        fillDeadline: 0,
        exclusivityDeadline: 0,
        exclusiveRelayer: toAddressType(ZERO_ADDRESS, MAINNET),
      };
    });
    it("returns only origin chain as repayment chain if it is underallocated", async function () {
      tokenClient.setTokenData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), toWei(0));
      const refundChains = await inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains).to.deep.equal([POLYGON]);
    });
    it("returns no repayment chains if origin chain is over allocated", async function () {
      tokenClient.setTokenData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), toWei(10));
      const refundChains = await inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains.length).to.equal(0);
    });
    it("returns origin chain even if it is over allocated if origin chain is a quick rebalance source", async function () {
      sampleDepositData.originChainId = BSC;
      sampleDepositData.inputToken = toAddressType(l2TokensForWeth[BSC], BSC);
      seedMocks({
        [BSC]: { [mainnetWeth]: toWei(10), [mainnetUsdc]: toMegaWei(1000) },
      });
      tokenClient.setTokenData(BSC, toAddressType(l2TokensForWeth[BSC], BSC), toWei(10));
      const refundChains = await inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains).to.deep.equal([BSC]);
    });
  });

  describe("origin token and chain are not mapped to a PoolRebalanceRoute", function () {
    beforeEach(async function () {
      const inputAmount = toBNWei(1);
      sampleDepositData = {
        depositId: bnZero,
        fromLiteChain: false,
        toLiteChain: false,
        originChainId: POLYGON,
        destinationChainId: ARBITRUM,
        depositor: toAddressType(owner.address, MAINNET),
        recipient: toAddressType(owner.address, MAINNET),
        inputToken: toAddressType(l2TokensForWeth[POLYGON], POLYGON),
        inputAmount,
        outputToken: toAddressType(l2TokensForWeth[ARBITRUM], ARBITRUM),
        outputAmount: inputAmount,
        message: "0x",
        messageHash: "0x",
        quoteTimestamp: hubPoolClient.currentTime!,
        fillDeadline: 0,
        exclusivityDeadline: 0,
        exclusiveRelayer: toAddressType(ZERO_ADDRESS, MAINNET),
      };
      hubPoolClient.deleteTokenMapping(mainnetWeth, POLYGON);
      (inventoryClient as MockInventoryClient).setTokenMapping({
        [mainnetWeth]: {
          [MAINNET]: mainnetWeth,
          [OPTIMISM]: l2TokensForWeth[OPTIMISM],
          // [POLYGON]: l2TokensForWeth[POLYGON],
          [ARBITRUM]: l2TokensForWeth[ARBITRUM],
        },
        [mainnetUsdc]: {
          [MAINNET]: mainnetUsdc,
          [OPTIMISM]: l2TokensForUsdc[OPTIMISM],
          // [POLYGON]: l2TokensForUsdc[POLYGON],
          [ARBITRUM]: l2TokensForUsdc[ARBITRUM],
        },
      });
    });
    it("returns only origin chain as repayment chain if it is underallocated", async function () {
      tokenClient.setTokenData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), toWei(0));
      const refundChains = await inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains).to.deep.equal([POLYGON]);
    });
    it("returns no repayment chains if origin chain is over allocated", async function () {
      tokenClient.setTokenData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), toWei(10));
      const refundChains = await inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains.length).to.equal(0);
    });
    it("includes only origin chain repayment chain list", async function () {
      const possibleRepaymentChains = inventoryClient.getPossibleRepaymentChainIds(sampleDepositData);
      [sampleDepositData.originChainId].forEach((chainId) => {
        expect(possibleRepaymentChains).to.include(chainId);
      });
      expect(possibleRepaymentChains.length).to.equal(1);
    });
  });

  describe("destination token and origin token are both not mapped to a PoolRebalanceRoute", function () {
    beforeEach(async function () {
      const inputAmount = toBNWei(1);
      sampleDepositData = {
        depositId: bnZero,
        fromLiteChain: false,
        toLiteChain: false,
        originChainId: POLYGON,
        destinationChainId: ARBITRUM,
        depositor: toAddressType(owner.address, MAINNET),
        recipient: toAddressType(owner.address, MAINNET),
        inputToken: toAddressType(l2TokensForWeth[POLYGON], POLYGON),
        inputAmount,
        outputToken: toAddressType(l2TokensForWeth[ARBITRUM], ARBITRUM),
        outputAmount: inputAmount,
        message: "0x",
        messageHash: "0x",
        quoteTimestamp: hubPoolClient.currentTime!,
        fillDeadline: 0,
        exclusivityDeadline: 0,
        exclusiveRelayer: toAddressType(ZERO_ADDRESS, MAINNET),
      };
      hubPoolClient.deleteTokenMapping(mainnetWeth, ARBITRUM);
      hubPoolClient.deleteTokenMapping(mainnetWeth, POLYGON);
      tokenClient.setTokenData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), toWei(0));
      tokenClient.setTokenData(ARBITRUM, toAddressType(l2TokensForWeth[ARBITRUM], ARBITRUM), toWei(0));
      (inventoryClient as MockInventoryClient).setTokenMapping({
        [mainnetWeth]: {
          [MAINNET]: mainnetWeth,
          [OPTIMISM]: l2TokensForWeth[OPTIMISM],
          // [POLYGON]: l2TokensForWeth[POLYGON],
          // [ARBITRUM]: l2TokensForWeth[ARBITRUM],
        },
        [mainnetUsdc]: {
          [MAINNET]: mainnetUsdc,
          [OPTIMISM]: l2TokensForUsdc[OPTIMISM],
          // [POLYGON]: l2TokensForUsdc[POLYGON],
          // [ARBITRUM]: l2TokensForUsdc[ARBITRUM],
        },
      });
    });
    it("only origin chain can be repayment chain", async function () {
      const refundChains = await inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains).to.deep.equal([POLYGON]);
    });
    it("returns no repayment chains if origin chain is over allocated", async function () {
      tokenClient.setTokenData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), toWei(10));
      tokenClient.setTokenData(ARBITRUM, toAddressType(l2TokensForWeth[ARBITRUM], ARBITRUM), toWei(10));
      const refundChains = await inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains.length).to.equal(0);
    });
    it("includes only origin chain repayment chain list", async function () {
      const possibleRepaymentChains = inventoryClient.getPossibleRepaymentChainIds(sampleDepositData);
      [sampleDepositData.originChainId].forEach((chainId) => {
        expect(possibleRepaymentChains).to.include(chainId);
      });
      expect(possibleRepaymentChains.length).to.equal(1);
    });
  });

  describe("destination token is not mapped to a PoolRebalanceRoute", function () {
    beforeEach(async function () {
      const inputAmount = toBNWei(1);
      sampleDepositData = {
        depositId: bnZero,
        fromLiteChain: false,
        toLiteChain: false,
        originChainId: POLYGON,
        destinationChainId: ARBITRUM,
        depositor: toAddressType(owner.address, MAINNET),
        recipient: toAddressType(owner.address, MAINNET),
        inputToken: toAddressType(l2TokensForWeth[POLYGON], POLYGON),
        inputAmount,
        outputToken: toAddressType(l2TokensForWeth[ARBITRUM], ARBITRUM),
        outputAmount: inputAmount,
        message: "0x",
        messageHash: "0x",
        quoteTimestamp: hubPoolClient.currentTime!,
        fillDeadline: 0,
        exclusivityDeadline: 0,
        exclusiveRelayer: toAddressType(ZERO_ADDRESS, MAINNET),
      };
      hubPoolClient.deleteTokenMapping(mainnetWeth, ARBITRUM);
      tokenClient.setTokenData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), toWei(0));
      tokenClient.setTokenData(ARBITRUM, toAddressType(l2TokensForWeth[ARBITRUM], ARBITRUM), toWei(0));
      (inventoryClient as MockInventoryClient).setTokenMapping({
        [mainnetWeth]: {
          [MAINNET]: mainnetWeth,
          [OPTIMISM]: l2TokensForWeth[OPTIMISM],
          [POLYGON]: l2TokensForWeth[POLYGON],
          // [ARBITRUM]: l2TokensForWeth[ARBITRUM],
        },
        [mainnetUsdc]: {
          [MAINNET]: mainnetUsdc,
          [OPTIMISM]: l2TokensForUsdc[OPTIMISM],
          [POLYGON]: l2TokensForUsdc[POLYGON],
          // [ARBITRUM]: l2TokensForUsdc[ARBITRUM],
        },
      });
    });
    it("origin chain and hub chain can be repayment chain", async function () {
      const refundChains = await inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains).to.deep.equal([POLYGON, MAINNET]);
    });
    it("returns hub chain if origin chain is over allocated", async function () {
      tokenClient.setTokenData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), toWei(10));
      const refundChains = await inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains.length).to.equal(1);
      expect(refundChains).to.deep.equal([MAINNET]);
    });
    it("includes hub chain and origin chain on repayment chain list, does not include destination chain", async function () {
      const possibleRepaymentChains = inventoryClient.getPossibleRepaymentChainIds(sampleDepositData);
      expect(possibleRepaymentChains).to.not.include(sampleDepositData.destinationChainId);
      expect(possibleRepaymentChains).to.include(sampleDepositData.originChainId);
      expect(possibleRepaymentChains).to.include(hubPoolClient.chainId);
    });
  });

  describe("evaluates slow withdrawal chains with excess running balances", function () {
    let excessRunningBalances: { [chainId: number]: BigNumber };
    beforeEach(async function () {
      // "enable" all pool rebalance routes so that inventory client evaluates slow withdrawal chains
      // as possible repayment chains.
      hubPoolClient.setEnableAllL2Tokens(true);
      excessRunningBalances = {
        [OPTIMISM]: toWei("0.1"),
        [ARBITRUM]: toWei("0.2"),
      };
      // Fill in rest of slow withdrawal chains with 0 excess since we won't test them.
      inventoryClient.getSlowWithdrawalRepaymentChains(toAddressType(mainnetWeth, MAINNET)).forEach((chainId) => {
        if (!excessRunningBalances[chainId]) {
          excessRunningBalances[chainId] = toWei("0");
        }
      });
      inventoryClient = new MockInventoryClient(
        toAddressType(owner.address, MAINNET),
        spyLogger,
        inventoryConfig,
        tokenClient,
        enabledChainIds,
        hubPoolClient,
        adapterManager,
        crossChainTransferClient,
        mockRebalancerClient,
        false,
        true // Need to set prioritizeUtilization to true to force client to consider slow withdrawal chains.
      );
      (inventoryClient as MockInventoryClient).setUpcomingRefunds(mainnetWeth, {});
      (inventoryClient as MockInventoryClient).setExcessRunningBalances(mainnetWeth, excessRunningBalances);
      const inputAmount = toBNWei(1);
      sampleDepositData = {
        depositId: bnZero,
        fromLiteChain: false,
        toLiteChain: false,
        originChainId: POLYGON,
        destinationChainId: MAINNET,
        depositor: toAddressType(owner.address, MAINNET),
        recipient: toAddressType(owner.address, MAINNET),
        inputToken: toAddressType(l2TokensForWeth[POLYGON], POLYGON),
        inputAmount,
        outputToken: toAddressType(l2TokensForWeth[MAINNET], MAINNET),
        outputAmount: inputAmount,
        message: "0x",
        messageHash: "0x",
        quoteTimestamp: hubPoolClient.currentTime!,
        fillDeadline: 0,
        exclusivityDeadline: 0,
        exclusiveRelayer: toAddressType(ZERO_ADDRESS, MAINNET),
      };
    });
    it("selects slow withdrawal chain with excess running balance and under relayer allocation", async function () {
      // Initial allocations are all under allocated so the first slow withdrawal chain should be selected since it has
      // the highest overage.
      tokenClient.setTokenData(ARBITRUM, toAddressType(l2TokensForWeth[ARBITRUM], ARBITRUM), toWei(0));
      tokenClient.setTokenData(OPTIMISM, toAddressType(l2TokensForWeth[OPTIMISM], OPTIMISM), toWei(0));
      tokenClient.setTokenData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), toWei(0));
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([
        ARBITRUM,
        OPTIMISM,
        POLYGON,
        MAINNET,
      ]);

      // If we instead drop the excess on Arbitrum to 0, then we should take repayment on
      // the next slow withdrawal chain.
      excessRunningBalances[ARBITRUM] = toWei("0");
      (inventoryClient as MockInventoryClient).setExcessRunningBalances(mainnetWeth, excessRunningBalances);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([
        OPTIMISM,
        POLYGON,
        MAINNET,
      ]);
    });
    it("includes slow withdrawal chains in possible repayment chain list", async function () {
      const possibleRepaymentChains = inventoryClient.getPossibleRepaymentChainIds(sampleDepositData);
      inventoryClient.getSlowWithdrawalRepaymentChains(toAddressType(mainnetWeth, MAINNET)).forEach((chainId) => {
        expect(possibleRepaymentChains).to.include(chainId);
      });
      [sampleDepositData.originChainId, sampleDepositData.destinationChainId].forEach((chainId) => {
        expect(possibleRepaymentChains).to.include(chainId);
      });
      expect(possibleRepaymentChains.length).to.equal(4);
    });
  });

  describe("Origin chain is a fast rebalance source", function () {
    beforeEach(async function () {
      // Modify mocks to be aware of native USDC, which is a "fast" rebalance token for certain routes
      hubPoolClient.setTokenMapping(mainnetUsdc, POLYGON, TOKEN_SYMBOLS_MAP.USDC.addresses[POLYGON]);
      hubPoolClient.setTokenMapping(mainnetUsdc, ARBITRUM, TOKEN_SYMBOLS_MAP.USDC.addresses[ARBITRUM]);
      (inventoryClient as unknown as MockInventoryClient).setTokenMapping({
        [mainnetUsdc]: {
          [POLYGON]: TOKEN_SYMBOLS_MAP.USDC.addresses[POLYGON],
          [ARBITRUM]: TOKEN_SYMBOLS_MAP.USDC.addresses[ARBITRUM],
        },
      });
      sampleDepositData = {
        depositId: bnZero,
        fromLiteChain: false,
        toLiteChain: false,
        originChainId: POLYGON,
        destinationChainId: ARBITRUM,
        depositor: toAddressType(owner.address, MAINNET),
        recipient: toAddressType(owner.address, MAINNET),
        inputToken: toAddressType(TOKEN_SYMBOLS_MAP.USDC.addresses[POLYGON], POLYGON),
        inputAmount: toMegaWei(10),
        outputToken: toAddressType(TOKEN_SYMBOLS_MAP.USDC.addresses[ARBITRUM], ARBITRUM),
        outputAmount: toMegaWei(10),
        message: "0x",
        messageHash: "0x",
        quoteTimestamp: hubPoolClient.currentTime!,
        fillDeadline: 0,
        exclusivityDeadline: 0,
        exclusiveRelayer: toAddressType(ZERO_ADDRESS, MAINNET),
      };
    });
    it("returns origin chain before destination chain", async function () {
      // Make sure that deposit doesn't force origin chain repayment otherwise this test would succeed and return
      // the origin chain for the wrong reason (i.e. this would be a false positive).
      expect(depositForcesOriginChainRepayment(sampleDepositData, hubPoolClient)).to.be.false;
      const refundChains = await inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains).to.deep.equal([
        sampleDepositData.originChainId,
        sampleDepositData.destinationChainId,
        MAINNET,
      ]);
    });
    it("forced origin chain repayment returns origin chain as only repayment chain", async function () {
      sampleDepositData.fromLiteChain = true;
      // Make sure that deposit forces origin chain repayment otherwise this test would succeed and return
      // the origin chain for the wrong reason (i.e. this would be a false positive).
      expect(depositForcesOriginChainRepayment(sampleDepositData, hubPoolClient)).to.be.true;
      const refundChains = await inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains).to.deep.equal([sampleDepositData.originChainId]);
    });
  });

  describe("forceOriginRepayment configuration", function () {
    beforeEach(async function () {
      const inputAmount = toMegaWei(1); // Use USDC amount (6 decimals)
      // Use POLYGON as origin chain with native USDC - Polygon supports CCTP for native USDC,
      // making it a quick rebalance source without Mainnet's special hub chain behavior
      // Note: We use native USDC (not USDC.e) for CCTP support
      const polygonNativeUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[POLYGON];
      const optimismNativeUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[OPTIMISM] || l2TokensForUsdc[OPTIMISM];

      // Set up pool rebalance route for native USDC on Polygon
      hubPoolClient.setTokenMapping(mainnetUsdc, POLYGON, polygonNativeUsdc);
      hubPoolClient.setEnableAllL2Tokens(true);

      sampleDepositData = {
        depositId: bnZero,
        fromLiteChain: false,
        toLiteChain: false,
        originChainId: POLYGON,
        destinationChainId: OPTIMISM,
        depositor: toAddressType(owner.address, MAINNET),
        recipient: toAddressType(owner.address, MAINNET),
        inputToken: toAddressType(polygonNativeUsdc, POLYGON),
        inputAmount,
        outputToken: toAddressType(optimismNativeUsdc, OPTIMISM),
        outputAmount: inputAmount,
        message: "0x",
        messageHash: "0x",
        quoteTimestamp: hubPoolClient.currentTime!,
        fillDeadline: 0,
        exclusivityDeadline: 0,
        exclusiveRelayer: toAddressType(ZERO_ADDRESS, MAINNET),
      };
      // Ensure deposit doesn't force origin chain repayment by protocol rules
      expect(depositForcesOriginChainRepayment(sampleDepositData, hubPoolClient)).to.be.false;
    });

    it("global forceOriginRepayment forces origin chain repayment", async function () {
      // Use native USDC for Polygon (CCTP support)
      const polygonNativeUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[POLYGON];
      const _inventoryClient = new MockInventoryClient(
        toAddressType(owner.address, MAINNET),
        spyLogger,
        {
          ...inventoryConfig,
          forceOriginRepayment: true,
        },
        tokenClient,
        enabledChainIds,
        hubPoolClient,
        adapterManager,
        mockRebalancerClient,
        false,
        false
      );
      (_inventoryClient as MockInventoryClient).setTokenMapping({
        [mainnetWeth]: {
          [MAINNET]: mainnetWeth,
          [OPTIMISM]: l2TokensForWeth[OPTIMISM],
          [POLYGON]: l2TokensForWeth[POLYGON],
          [ARBITRUM]: l2TokensForWeth[ARBITRUM],
          [BSC]: l2TokensForWeth[BSC],
        },
        [mainnetUsdc]: {
          [MAINNET]: mainnetUsdc,
          [OPTIMISM]: l2TokensForUsdc[OPTIMISM],
          [POLYGON]: polygonNativeUsdc, // Use native USDC for CCTP support
          [ARBITRUM]: l2TokensForUsdc[ARBITRUM],
          [BSC]: l2TokensForUsdc[BSC],
        },
      });
      (_inventoryClient as MockInventoryClient).setUpcomingRefunds(mainnetUsdc, {});

      const refundChains = await _inventoryClient.determineRefundChainId(sampleDepositData);
      // When forceOriginRepayment is true and origin chain is a quick rebalance source (Polygon with native USDC/CCTP),
      // determineRefundChainId returns origin chain immediately
      expect(refundChains).to.deep.equal([POLYGON]);
    });

    it("per-chain forceOriginRepaymentPerChain takes priority over global forceOriginRepayment", async function () {
      // Use native USDC for Polygon (CCTP support)
      const polygonNativeUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[POLYGON];
      const _inventoryClient = new MockInventoryClient(
        toAddressType(owner.address, MAINNET),
        spyLogger,
        {
          ...inventoryConfig,
          forceOriginRepayment: false, // Global says no
          forceOriginRepaymentPerChain: {
            [POLYGON]: true, // But per-chain says yes for Polygon
          },
        },
        tokenClient,
        enabledChainIds,
        hubPoolClient,
        adapterManager,
        crossChainTransferClient,
        mockRebalancerClient,
        false,
        false
      );
      (_inventoryClient as MockInventoryClient).setTokenMapping({
        [mainnetWeth]: {
          [MAINNET]: mainnetWeth,
          [OPTIMISM]: l2TokensForWeth[OPTIMISM],
          [POLYGON]: l2TokensForWeth[POLYGON],
          [ARBITRUM]: l2TokensForWeth[ARBITRUM],
          [BSC]: l2TokensForWeth[BSC],
        },
        [mainnetUsdc]: {
          [MAINNET]: mainnetUsdc,
          [OPTIMISM]: l2TokensForUsdc[OPTIMISM],
          [POLYGON]: polygonNativeUsdc, // Use native USDC for CCTP support
          [ARBITRUM]: l2TokensForUsdc[ARBITRUM],
          [BSC]: l2TokensForUsdc[BSC],
        },
      });
      (_inventoryClient as MockInventoryClient).setUpcomingRefunds(mainnetUsdc, {});

      // Should force origin chain repayment because per-chain config overrides global
      const refundChains = await _inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains).to.deep.equal([POLYGON]);

      // Test with a different origin chain that doesn't have per-chain config and is not a quick rebalance source
      // Use ARBITRUM with WETH (not a quick rebalance source for WETH)
      sampleDepositData.originChainId = ARBITRUM;
      sampleDepositData.inputToken = toAddressType(l2TokensForWeth[ARBITRUM], ARBITRUM);
      sampleDepositData.outputToken = toAddressType(l2TokensForWeth[OPTIMISM], OPTIMISM);
      sampleDepositData.inputAmount = toBNWei(1); // Back to WETH amount (18 decimals)
      sampleDepositData.outputAmount = toBNWei(1);
      // Should not force origin chain repayment (uses global false, and Arbitrum with WETH is not a quick rebalance source)
      // Check getPossibleRepaymentChainIds to verify it includes multiple chains
      const possibleChains2 = _inventoryClient.getPossibleRepaymentChainIds(sampleDepositData);
      // When forceOriginRepayment is false, possible chains should include more than just origin
      expect(possibleChains2.length).to.be.greaterThan(1);
      expect(possibleChains2).to.include(ARBITRUM); // Origin chain should be in the list
    });

    it("per-chain forceOriginRepaymentPerChain=false overrides global forceOriginRepayment=true", async function () {
      // Use native USDC for Polygon (CCTP support)
      const polygonNativeUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[POLYGON];
      const _inventoryClient = new MockInventoryClient(
        toAddressType(owner.address, MAINNET),
        spyLogger,
        {
          ...inventoryConfig,
          forceOriginRepayment: true, // Global says yes
          forceOriginRepaymentPerChain: {
            [POLYGON]: false, // But per-chain says no for Polygon
          },
        },
        tokenClient,
        enabledChainIds,
        hubPoolClient,
        adapterManager,
        crossChainTransferClient,
        mockRebalancerClient,
        false,
        false
      );
      (_inventoryClient as MockInventoryClient).setTokenMapping({
        [mainnetWeth]: {
          [MAINNET]: mainnetWeth,
          [OPTIMISM]: l2TokensForWeth[OPTIMISM],
          [POLYGON]: l2TokensForWeth[POLYGON],
          [ARBITRUM]: l2TokensForWeth[ARBITRUM],
          [BSC]: l2TokensForWeth[BSC],
        },
        [mainnetUsdc]: {
          [MAINNET]: mainnetUsdc,
          [OPTIMISM]: l2TokensForUsdc[OPTIMISM],
          [POLYGON]: polygonNativeUsdc, // Use native USDC for CCTP support
          [ARBITRUM]: l2TokensForUsdc[ARBITRUM],
          [BSC]: l2TokensForUsdc[BSC],
        },
      });
      (_inventoryClient as MockInventoryClient).setUpcomingRefunds(mainnetUsdc, {});

      // Should NOT force origin chain repayment because per-chain config overrides global
      // Since forceOriginRepaymentPerChain[MAINNET] = false, shouldForceOriginRepayment returns false
      // Verify that forceOriginRepayment is actually false by checking getPossibleRepaymentChainIds
      const possibleChains = _inventoryClient.getPossibleRepaymentChainIds(sampleDepositData);
      // When forceOriginRepayment is false, possible chains should include more than just origin
      // This is the key test - it should not be forced to only Polygon
      expect(possibleChains.length).to.be.greaterThan(1);
      expect(possibleChains).to.include(POLYGON); // Polygon should still be in the list (as origin chain)
    });

    it("repaymentChainOverridePerChain is respected when forceOriginRepaymentPerChain=false overrides global forceOriginRepayment=true", async function () {
      // Use native USDC for Polygon (CCTP support)
      const polygonNativeUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[POLYGON];
      const _inventoryClient = new MockInventoryClient(
        toAddressType(owner.address, MAINNET),
        spyLogger,
        {
          ...inventoryConfig,
          forceOriginRepayment: true, // Global says yes
          forceOriginRepaymentPerChain: {
            [POLYGON]: false, // But per-chain says no for Polygon
          },
          repaymentChainOverridePerChain: {
            [POLYGON]: ARBITRUM, // Override to Arbitrum for Polygon deposits
          },
        },
        tokenClient,
        enabledChainIds,
        hubPoolClient,
        adapterManager,
        crossChainTransferClient,
        mockRebalancerClient,
        false,
        false
      );
      (_inventoryClient as MockInventoryClient).setTokenMapping({
        [mainnetWeth]: {
          [MAINNET]: mainnetWeth,
          [OPTIMISM]: l2TokensForWeth[OPTIMISM],
          [POLYGON]: l2TokensForWeth[POLYGON],
          [ARBITRUM]: l2TokensForWeth[ARBITRUM],
          [BSC]: l2TokensForWeth[BSC],
        },
        [mainnetUsdc]: {
          [MAINNET]: mainnetUsdc,
          [OPTIMISM]: l2TokensForUsdc[OPTIMISM],
          [POLYGON]: polygonNativeUsdc, // Use native USDC for CCTP support
          [ARBITRUM]: l2TokensForUsdc[ARBITRUM],
          [BSC]: l2TokensForUsdc[BSC],
        },
      });
      (_inventoryClient as MockInventoryClient).setUpcomingRefunds(mainnetUsdc, {});

      // Should use the repaymentChainOverridePerChain (Arbitrum) because forceOriginRepaymentPerChain is false
      const refundChains = await _inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains).to.deep.equal([ARBITRUM]);
    });

    it("forceOriginRepayment includes only origin chain in possible repayment chains", async function () {
      // Use native USDC for Polygon (CCTP support)
      const polygonNativeUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[POLYGON];
      const _inventoryClient = new MockInventoryClient(
        toAddressType(owner.address, MAINNET),
        spyLogger,
        {
          ...inventoryConfig,
          forceOriginRepayment: true,
        },
        tokenClient,
        enabledChainIds,
        hubPoolClient,
        adapterManager,
        crossChainTransferClient,
        mockRebalancerClient,
        false,
        false
      );
      (_inventoryClient as MockInventoryClient).setTokenMapping({
        [mainnetWeth]: {
          [MAINNET]: mainnetWeth,
          [OPTIMISM]: l2TokensForWeth[OPTIMISM],
          [POLYGON]: l2TokensForWeth[POLYGON],
          [ARBITRUM]: l2TokensForWeth[ARBITRUM],
          [BSC]: l2TokensForWeth[BSC],
        },
        [mainnetUsdc]: {
          [MAINNET]: mainnetUsdc,
          [OPTIMISM]: l2TokensForUsdc[OPTIMISM],
          [POLYGON]: polygonNativeUsdc, // Use native USDC for CCTP support
          [ARBITRUM]: l2TokensForUsdc[ARBITRUM],
          [BSC]: l2TokensForUsdc[BSC],
        },
      });
      (_inventoryClient as MockInventoryClient).setUpcomingRefunds(mainnetUsdc, {});

      const possibleRepaymentChains = _inventoryClient.getPossibleRepaymentChainIds(sampleDepositData);
      // When forceOriginRepayment is true and origin is a quick rebalance source (Polygon with native USDC/CCTP),
      // getPossibleRepaymentChainIds should return only origin chain
      expect(possibleRepaymentChains).to.deep.equal([POLYGON]);
      expect(possibleRepaymentChains.length).to.equal(1);
    });
  });

  describe("repaymentChainOverride configuration", function () {
    beforeEach(async function () {
      const inputAmount = toBNWei(1);
      sampleDepositData = {
        depositId: bnZero,
        fromLiteChain: false,
        toLiteChain: false,
        originChainId: POLYGON,
        destinationChainId: OPTIMISM,
        depositor: toAddressType(owner.address, MAINNET),
        recipient: toAddressType(owner.address, MAINNET),
        inputToken: toAddressType(l2TokensForWeth[POLYGON], POLYGON),
        inputAmount,
        outputToken: toAddressType(l2TokensForWeth[OPTIMISM], OPTIMISM),
        outputAmount: inputAmount,
        message: "0x",
        messageHash: "0x",
        quoteTimestamp: hubPoolClient.currentTime!,
        fillDeadline: 0,
        exclusivityDeadline: 0,
        exclusiveRelayer: toAddressType(ZERO_ADDRESS, MAINNET),
      };
      // Ensure deposit doesn't force origin chain repayment by protocol rules
      expect(depositForcesOriginChainRepayment(sampleDepositData, hubPoolClient)).to.be.false;
    });

    it("global repaymentChainOverride overrides repayment chain selection", async function () {
      const _inventoryClient = new MockInventoryClient(
        toAddressType(owner.address, MAINNET),
        spyLogger,
        {
          ...inventoryConfig,
          repaymentChainOverride: ARBITRUM, // Override to Arbitrum
        },
        tokenClient,
        enabledChainIds,
        hubPoolClient,
        adapterManager,
        crossChainTransferClient,
        mockRebalancerClient,
        false,
        false
      );
      (_inventoryClient as MockInventoryClient).setTokenMapping({
        [mainnetWeth]: {
          [MAINNET]: mainnetWeth,
          [OPTIMISM]: l2TokensForWeth[OPTIMISM],
          [POLYGON]: l2TokensForWeth[POLYGON],
          [ARBITRUM]: l2TokensForWeth[ARBITRUM],
          [BSC]: l2TokensForWeth[BSC],
        },
        [mainnetUsdc]: {
          [MAINNET]: mainnetUsdc,
          [OPTIMISM]: l2TokensForUsdc[OPTIMISM],
          [POLYGON]: l2TokensForUsdc[POLYGON],
          [ARBITRUM]: l2TokensForUsdc[ARBITRUM],
          [BSC]: l2TokensForUsdc[BSC],
        },
      });
      (_inventoryClient as MockInventoryClient).setUpcomingRefunds(mainnetWeth, {});

      const refundChains = await _inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains).to.deep.equal([ARBITRUM]);
    });

    it("per-chain repaymentChainOverridePerChain takes priority over global repaymentChainOverride", async function () {
      const _inventoryClient = new MockInventoryClient(
        toAddressType(owner.address, MAINNET),
        spyLogger,
        {
          ...inventoryConfig,
          repaymentChainOverride: ARBITRUM, // Global override to Arbitrum
          repaymentChainOverridePerChain: {
            [POLYGON]: OPTIMISM, // But per-chain override to Optimism for Polygon deposits
          },
        },
        tokenClient,
        enabledChainIds,
        hubPoolClient,
        adapterManager,
        crossChainTransferClient,
        mockRebalancerClient,
        false,
        false
      );
      (_inventoryClient as MockInventoryClient).setTokenMapping({
        [mainnetWeth]: {
          [MAINNET]: mainnetWeth,
          [OPTIMISM]: l2TokensForWeth[OPTIMISM],
          [POLYGON]: l2TokensForWeth[POLYGON],
          [ARBITRUM]: l2TokensForWeth[ARBITRUM],
          [BSC]: l2TokensForWeth[BSC],
        },
        [mainnetUsdc]: {
          [MAINNET]: mainnetUsdc,
          [OPTIMISM]: l2TokensForUsdc[OPTIMISM],
          [POLYGON]: l2TokensForUsdc[POLYGON],
          [ARBITRUM]: l2TokensForUsdc[ARBITRUM],
          [BSC]: l2TokensForUsdc[BSC],
        },
      });
      (_inventoryClient as MockInventoryClient).setUpcomingRefunds(mainnetWeth, {});

      // Should use per-chain override (Optimism) instead of global override (Arbitrum)
      const refundChains = await _inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains).to.deep.equal([OPTIMISM]);

      // Test with a different origin chain that doesn't have per-chain config
      sampleDepositData.originChainId = ARBITRUM;
      sampleDepositData.inputToken = toAddressType(l2TokensForWeth[ARBITRUM], ARBITRUM);
      // Should use global override (Arbitrum)
      const refundChains2 = await _inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains2).to.deep.equal([ARBITRUM]);
    });

    it("repaymentChainOverride includes override chain in possible repayment chains", async function () {
      const _inventoryClient = new MockInventoryClient(
        toAddressType(owner.address, MAINNET),
        spyLogger,
        {
          ...inventoryConfig,
          repaymentChainOverride: ARBITRUM,
        },
        tokenClient,
        enabledChainIds,
        hubPoolClient,
        adapterManager,
        crossChainTransferClient,
        mockRebalancerClient,
        false,
        false
      );
      (_inventoryClient as MockInventoryClient).setTokenMapping({
        [mainnetWeth]: {
          [MAINNET]: mainnetWeth,
          [OPTIMISM]: l2TokensForWeth[OPTIMISM],
          [POLYGON]: l2TokensForWeth[POLYGON],
          [ARBITRUM]: l2TokensForWeth[ARBITRUM],
          [BSC]: l2TokensForWeth[BSC],
        },
        [mainnetUsdc]: {
          [MAINNET]: mainnetUsdc,
          [OPTIMISM]: l2TokensForUsdc[OPTIMISM],
          [POLYGON]: l2TokensForUsdc[POLYGON],
          [ARBITRUM]: l2TokensForUsdc[ARBITRUM],
          [BSC]: l2TokensForUsdc[BSC],
        },
      });
      (_inventoryClient as MockInventoryClient).setUpcomingRefunds(mainnetWeth, {});

      const possibleRepaymentChains = _inventoryClient.getPossibleRepaymentChainIds(sampleDepositData);
      expect(possibleRepaymentChains).to.include(ARBITRUM);
    });

    it("repaymentChainOverride is ignored when forceOriginRepayment is true", async function () {
      // Use Polygon with native USDC as origin since it's a quick rebalance source (CCTP), so forceOriginRepayment will return immediately
      const polygonNativeUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[POLYGON];
      const optimismNativeUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[OPTIMISM] || l2TokensForUsdc[OPTIMISM];
      sampleDepositData.originChainId = POLYGON;
      sampleDepositData.inputToken = toAddressType(polygonNativeUsdc, POLYGON);
      sampleDepositData.outputToken = toAddressType(optimismNativeUsdc, OPTIMISM);

      const _inventoryClient = new MockInventoryClient(
        toAddressType(owner.address, MAINNET),
        spyLogger,
        {
          ...inventoryConfig,
          forceOriginRepayment: true,
          repaymentChainOverride: ARBITRUM, // Should be ignored
        },
        tokenClient,
        enabledChainIds,
        hubPoolClient,
        adapterManager,
        crossChainTransferClient,
        mockRebalancerClient,
        false,
        false
      );
      (_inventoryClient as MockInventoryClient).setTokenMapping({
        [mainnetWeth]: {
          [MAINNET]: mainnetWeth,
          [OPTIMISM]: l2TokensForWeth[OPTIMISM],
          [POLYGON]: l2TokensForWeth[POLYGON],
          [ARBITRUM]: l2TokensForWeth[ARBITRUM],
          [BSC]: l2TokensForWeth[BSC],
        },
        [mainnetUsdc]: {
          [MAINNET]: mainnetUsdc,
          [OPTIMISM]: l2TokensForUsdc[OPTIMISM],
          [POLYGON]: polygonNativeUsdc, // Use native USDC for CCTP support
          [ARBITRUM]: l2TokensForUsdc[ARBITRUM],
          [BSC]: l2TokensForUsdc[BSC],
        },
      });
      (_inventoryClient as MockInventoryClient).setUpcomingRefunds(mainnetUsdc, {});

      // Should return origin chain, not the override chain
      const refundChains = await _inventoryClient.determineRefundChainId(sampleDepositData);
      expect(refundChains).to.deep.equal([POLYGON]);
    });
  });
});
