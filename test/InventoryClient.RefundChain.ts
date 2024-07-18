import {
  assertPromiseError,
  BigNumber,
  SignerWithAddress,
  createRefunds,
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
} from "./utils";

import { ConfigStoreClient, InventoryClient } from "../src/clients"; // Tested
import { CrossChainTransferClient } from "../src/clients/bridges";
import { V3Deposit, InventoryConfig } from "../src/interfaces";
import { CHAIN_IDs, ZERO_ADDRESS, bnZero, getNetworkName, TOKEN_SYMBOLS_MAP } from "../src/utils";
import {
  MockAdapterManager,
  MockBundleDataClient,
  MockHubPoolClient,
  MockInventoryClient,
  MockTokenClient,
} from "./mocks";

describe("InventoryClient: Refund chain selection", async function () {
  const { MAINNET, OPTIMISM, POLYGON, ARBITRUM } = CHAIN_IDs;
  const enabledChainIds = [MAINNET, OPTIMISM, POLYGON, ARBITRUM];
  const mainnetWeth = TOKEN_SYMBOLS_MAP.WETH.addresses[MAINNET];
  const mainnetUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[MAINNET];

  let hubPoolClient: MockHubPoolClient, adapterManager: MockAdapterManager, tokenClient: MockTokenClient;
  let bundleDataClient: MockBundleDataClient;
  let owner: SignerWithAddress, spy: sinon.SinonSpy, spyLogger: winston.Logger;
  let inventoryClient: InventoryClient; // tested
  let sampleDepositData: V3Deposit;
  let crossChainTransferClient: CrossChainTransferClient;

  // construct two mappings of chainId to token address. Set the l1 token address to the "real" token address.
  const l2TokensForWeth = { [MAINNET]: mainnetWeth };
  const l2TokensForUsdc = { [MAINNET]: mainnetUsdc };
  enabledChainIds
    .filter((chainId) => chainId !== MAINNET)
    .forEach((chainId) => {
      l2TokensForWeth[chainId] = TOKEN_SYMBOLS_MAP.WETH.addresses[chainId];
      l2TokensForUsdc[chainId] = TOKEN_SYMBOLS_MAP["USDC.e"].addresses[chainId];
    });

  const toMegaWei = (num: string | number | BigNumber) => ethers.utils.parseUnits(num.toString(), 6);
  // Configure thresholds percentages as 10% optimism, 5% polygon and 5% Arbitrum with a target being threshold +2%.
  const targetOverageBuffer = toWei(1);
  const inventoryConfig: InventoryConfig = {
    wrapEtherTargetPerChain: {},
    wrapEtherTarget: toWei(1),
    wrapEtherThresholdPerChain: {},
    wrapEtherThreshold: toWei(1),
    tokenConfig: {
      [mainnetWeth]: {
        [OPTIMISM]: { targetPct: toWei(0.12), thresholdPct: toWei(0.1), targetOverageBuffer },
        [POLYGON]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
        [ARBITRUM]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
      },
      [mainnetUsdc]: {
        [OPTIMISM]: { targetPct: toWei(0.12), thresholdPct: toWei(0.1), targetOverageBuffer },
        [POLYGON]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
        [ARBITRUM]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
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
    hubPoolClient.addL1Token({ address: mainnetWeth, decimals: 18, symbol: "WETH" });
    hubPoolClient.addL1Token({ address: mainnetUsdc, decimals: 6, symbol: "USDC" });
    enabledChainIds.forEach((chainId) => {
      adapterManager.setMockedOutstandingCrossChainTransfers(chainId, owner.address, mainnetWeth, bnZero);
      adapterManager.setMockedOutstandingCrossChainTransfers(chainId, owner.address, mainnetUsdc, bnZero);
      tokenClient.setTokenData(chainId, l2TokensForWeth[chainId], seedBalances[chainId][mainnetWeth]);
      tokenClient.setTokenData(chainId, l2TokensForUsdc[chainId], seedBalances[chainId][mainnetUsdc]);
      hubPoolClient.setTokenMapping(mainnetWeth, chainId, l2TokensForWeth[chainId]);
      hubPoolClient.setTokenMapping(mainnetUsdc, chainId, l2TokensForUsdc[chainId]);
    });
  };

  const computeOutputAmount = async (deposit: V3Deposit) => {
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
    bundleDataClient = new MockBundleDataClient(null, null, null, null);

    crossChainTransferClient = new CrossChainTransferClient(spyLogger, enabledChainIds, adapterManager);
    inventoryClient = new InventoryClient(
      owner.address,
      spyLogger,
      inventoryConfig,
      tokenClient,
      enabledChainIds,
      hubPoolClient,
      bundleDataClient,
      adapterManager,
      crossChainTransferClient,
      false, // simMode
      false // prioritizeUtilization
    );

    seedMocks(initialAllocation);
  });

  describe("origin chain is equal to hub chain", function () {
    beforeEach(async function () {
      const inputAmount = toBNWei(1);
      sampleDepositData = {
        depositId: 0,
        originChainId: MAINNET,
        destinationChainId: OPTIMISM,
        depositor: owner.address,
        recipient: owner.address,
        inputToken: mainnetWeth,
        inputAmount,
        outputToken: l2TokensForWeth[OPTIMISM],
        outputAmount: inputAmount,
        message: "0x",
        quoteTimestamp: hubPoolClient.currentTime!,
        fillDeadline: 0,
        exclusivityDeadline: 0,
        exclusiveRelayer: ZERO_ADDRESS,
      };
    });
    it("Correctly decides when to refund based on relay size", async function () {
      // To start with, consider a simple case where the relayer is filling small relays. The current allocation on the
      // target chain of Optimism for WETH is 20/140=14.2%. This is above the sum of targetL2Pct of 10% plus 2% buffer.
      // Construct a small mock deposit of size 1 WETH. Post relay Optimism should have (20-1)/(140-1)=13.6%. This is still
      // above the threshold of 12 and so the bot should choose to be refunded on L1.
      sampleDepositData.inputAmount = toWei(1);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([MAINNET]);
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"136690647482014388"')).to.be.true; // (20-1)/(140-1)=0.136

      // Now consider a case where the relayer is filling a marginally larger relay of size 5 WETH. Now the post relay
      // allocation on optimism would be (20-5)/(140-5)=11%. This now below the target plus buffer of 12%. Relayer should
      // choose to refund on the L2.
      sampleDepositData.inputAmount = toWei(5);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([OPTIMISM, MAINNET]);
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"111111111111111111"')).to.be.true; // (20-5)/(140-5)=0.11

      // Now consider a bigger relay that should force refunds on the L2 chain. Set the relay size to 10 WETH. now post
      // relay allocation would be (20-10)/(140-10)=0.076. This is below the target threshold of 10% and so the bot should
      // set the refund on L2.
      sampleDepositData.inputAmount = toWei(10);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([OPTIMISM, MAINNET]);
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"76923076923076923"')).to.be.true; // (20-10)/(140-10)=0.076
    });

    it("Correctly factors in cross chain transfers when deciding where to refund", async function () {
      // The relayer should correctly factor in pending cross-chain relays when thinking about shortfalls. Consider a large
      // fictitious relay that exceeds all outstanding liquidity on the target chain(Arbitrum) of 15 Weth (target only)
      // has 10 WETH in it.
      const largeRelayAmount = toWei(15);
      tokenClient.setTokenShortFallData(ARBITRUM, l2TokensForWeth[ARBITRUM], [6969], largeRelayAmount); // Mock the shortfall.
      // The expected cross chain transfer amount is (0.05+0.02-(10-15)/140)*140=14.8 // Mock the cross-chain transfer
      // leaving L1 to go to arbitrum by adding it to the mock cross chain transfers and removing from l1 balance.
      const bridgedAmount = toWei(14.8);
      adapterManager.setMockedOutstandingCrossChainTransfers(ARBITRUM, owner.address, mainnetWeth, bridgedAmount);
      await inventoryClient.update();
      tokenClient.setTokenData(MAINNET, mainnetWeth, initialAllocation[MAINNET][mainnetWeth].sub(bridgedAmount));

      // Now, consider that the bot is run while these funds for the above deposit are in the canonical bridge and cant
      // be filled yet. When it runs it picks up a relay that it can do, of size 1.69 WETH. Each part of the computation
      // is broken down to explain how the bot chooses where to allocate funds:
      // 1. chainVirtualBalance: Considering the funds on the target chain we have a balance of 10 WETH, with an amount of
      //    14.8 that is currently coming over the bridge. This totals a "virtual" balance of (10+14.8)=24.8.
      // 2. chainVirtualBalanceWithShortfall: this is the virtual balance minus the shortfall. 24.9-15=9.8.
      // 3. chainVirtualBalanceWithShortfallPostRelay: virtual balance with shortfall minus the relay amount. 9.8-1.69=8.11.
      // 4. cumulativeVirtualBalance: total balance across all chains considering fund movement. funds moving over the bridge
      //    does not impact the balance; they are just "moving" so it should be 140-15+15=140
      // 5. cumulativeVirtualBalancePostRelay: cumulative virtual balance plus upcoming refunds minus the relay amount
      //    140-1.69=138.31. This is total funds considering the relay amount that is to be executed.
      // 6. expectedPostRelayAllocation: the expected post relay allocation is the chainVirtualBalanceWithShortfallPostRelay
      //    divided by the cumulativeVirtualBalancePostRelay. 8.11/138.31 = 0.0586.
      // This number is then used to decide on where funds should be allocated! If this number is above the threshold plus
      // the buffer then refund on L1. if it is below the threshold then refund on the target chain. As this number is
      // is below the buffer plus the threshold then the bot should refund on L2.

      sampleDepositData.destinationChainId = ARBITRUM;
      sampleDepositData.outputToken = l2TokensForWeth[ARBITRUM];
      sampleDepositData.inputAmount = toWei(1.69);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([ARBITRUM, MAINNET]);

      expect(lastSpyLogIncludes(spy, 'chainShortfall":"15000000000000000000"')).to.be.true;
      expect(lastSpyLogIncludes(spy, 'chainVirtualBalance":"24800000000000000000"')).to.be.true; // (10+14.8)=24.8
      expect(lastSpyLogIncludes(spy, 'chainVirtualBalanceWithShortfall":"9800000000000000000"')).to.be.true; // 24.8-15=9.8
      expect(lastSpyLogIncludes(spy, 'chainVirtualBalanceWithShortfallPostRelay":"8110000000000000000"')).to.be.true; // 9.8-1.69=8.11
      expect(lastSpyLogIncludes(spy, 'cumulativeVirtualBalance":"140000000000000000000')).to.be.true; // 140-15+15=140
      expect(lastSpyLogIncludes(spy, 'cumulativeVirtualBalancePostRelay":"138310000000000000000"')).to.be.true; // 125-1.69=123.31
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"58636396500614561')).to.be.true; // 8.11/123.31 = 0.0657

      // Now consider if this small relay was larger to the point that we should be refunding on the L2. set it to 5 WETH.
      // Numerically we can shortcut some of the computations above to the following: chain virtual balance with shortfall
      // post relay is 9.8 - 5 = 4.8. cumulative virtual balance post relay is 140 - 5 = 135. Expected post
      // relay allocation is 4.8/135 = 0.036. This is below the threshold of 0.05 so the bot should refund on the target.
      sampleDepositData.inputAmount = toWei(5);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([ARBITRUM, MAINNET]);
      // Check only the final step in the computation.
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"35555555555555555"')).to.be.true; // 4.8/120 = 0.04

      // Consider that we manually send the relayer som funds while it's large transfer is currently in the bridge. This
      // is to validate that the module considers funds in transit correctly + dropping funds indirectly onto the L2 wallet.
      // Say we magically give the bot 10 WETH on Arbitrum and try to repeat the previous example. Now, we should a
      // chain virtual balance with shortfall post relay is 9.8 - 5 + 10 = 14.8. cumulative virtual balance with shortfall
      // post relay is 125 - 5 + 10 = 130. Expected post relay allocation is 14.8/130 = 0.11. This is above the threshold
      // of 0.05 so the bot should refund on L1.
      tokenClient.setTokenData(
        ARBITRUM,
        l2TokensForWeth[ARBITRUM],
        initialAllocation[ARBITRUM][mainnetWeth].add(toWei(10))
      );
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([MAINNET]);
    });

    it("Correctly decides where to refund based on upcoming refunds", async function () {
      // Consider a case where the relayer is filling a marginally larger relay of size 5 WETH. Without refunds, the post relay
      // allocation on optimism would be (15-5)/(140-5)=7.4%. This would be below the target plus buffer of 12%. However, if we now
      // factor in 10 WETH in refunds (5 from pending and 5 from next bundle) that are coming to L2 and 5 more WETH refunds coming to L1,
      // the allocation should actually be (15-5+10)/(140-5+5+10)=~13.3%, which is above L2 target.
      // Therefore, the bot should choose refund on L1 instead of L2.
      sampleDepositData.inputAmount = toWei(5);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      bundleDataClient.setReturnedPendingBundleRefunds({
        [MAINNET]: createRefunds(owner.address, toWei(5), mainnetWeth),
        [OPTIMISM]: createRefunds(owner.address, toWei(5), l2TokensForWeth[OPTIMISM]),
      });
      bundleDataClient.setReturnedNextBundleRefunds({
        [OPTIMISM]: createRefunds(owner.address, toWei(5), l2TokensForWeth[OPTIMISM]),
      });
      // We need HubPoolClient.l2TokenEnabledForL1Token() to return true for a given
      // L1 token and destination chain ID, otherwise it won't be counted in upcoming
      // refunds.
      hubPoolClient.setEnableAllL2Tokens(true);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([MAINNET]);
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"166666666666666666"')).to.be.true; // (20-5)/(140-5)=0.11

      // If we set this to false in this test, the destination chain will be default used since the refund data
      // will be ignored.
      hubPoolClient.setEnableAllL2Tokens(false);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([OPTIMISM, MAINNET]);
    });

    it("Correctly throws when Deposit tokens are not equivalent", async function () {
      sampleDepositData.inputAmount = toWei(5);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([
        sampleDepositData.destinationChainId,
        1,
      ]);

      sampleDepositData.outputToken = ZERO_ADDRESS;
      const srcChain = getNetworkName(sampleDepositData.originChainId);
      const dstChain = getNetworkName(sampleDepositData.destinationChainId);
      await assertPromiseError(
        inventoryClient.determineRefundChainId(sampleDepositData),
        `Unexpected ${dstChain} output token on ${srcChain} deposit`
      );
    });

    it("token config is not defined", async function () {
      // Defaults to destination chain.
      const _inventoryClient = new InventoryClient(
        owner.address,
        spyLogger,
        {
          ...inventoryConfig,
          tokenConfig: {},
        },
        tokenClient,
        enabledChainIds,
        hubPoolClient,
        bundleDataClient,
        adapterManager,
        crossChainTransferClient,
        false, // simMode
        false // prioritizeUtilization
      );
      expect(await _inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([
        sampleDepositData.destinationChainId,
      ]);
    });
    it("includes origin, destination in repayment chain list", async function () {
      const possibleRepaymentChains = inventoryClient.getPossibleRepaymentChainIds(sampleDepositData);
      [sampleDepositData.originChainId, sampleDepositData.destinationChainId].forEach((chainId) => {
        expect(possibleRepaymentChains).to.include(chainId);
      });
      expect(possibleRepaymentChains.length).to.equal(2);
    });
  });

  describe("origin chain is not equal to hub chain", function () {
    beforeEach(async function () {
      const inputAmount = toBNWei(1);
      sampleDepositData = {
        depositId: 0,
        originChainId: POLYGON,
        destinationChainId: OPTIMISM,
        depositor: owner.address,
        recipient: owner.address,
        inputToken: l2TokensForWeth[POLYGON],
        inputAmount,
        outputToken: l2TokensForWeth[OPTIMISM],
        outputAmount: inputAmount,
        message: "0x",
        quoteTimestamp: hubPoolClient.currentTime!,
        fillDeadline: 0,
        exclusivityDeadline: 0,
        exclusiveRelayer: ZERO_ADDRESS,
      };
    });
    it("Both origin and destination chain allocations are below target", async function () {
      // Set Polygon allocation lower than target:
      tokenClient.setTokenData(POLYGON, l2TokensForWeth[POLYGON], toWei(9));

      // Post relay allocations:
      // Optimism (destination chain): (20-5)/(139-5)=11.1% < 12%
      // Polygon (origin chain): (9)/(139-5)=6.7% < 7%
      // Relayer should choose to refund on destination over origin if both are under allocated
      sampleDepositData.inputAmount = toWei(5);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([
        OPTIMISM,
        POLYGON,
        MAINNET,
      ]);
      expect(spyLogIncludes(spy, -2, 'expectedPostRelayAllocation":"111940298507462686"')).to.be.true;
    });
    it("Origin chain allocation does not depend on subtracting from numerator", async function () {
      // Post relay allocation does not subtract anything from chain virtual balance, unlike
      // accounting for destination chain allocation

      // Set Polygon allocation just higher than target. This is set so that any subtractions
      // from the numerator would break this test.
      tokenClient.setTokenData(POLYGON, l2TokensForWeth[POLYGON], toWei(10));
      tokenClient.setTokenData(OPTIMISM, l2TokensForWeth[OPTIMISM], toWei(30));

      // Post relay allocations:
      // Optimism (destination chain): (30-10)/(150-10)=14.3% > 12%
      // Polygon (origin chain): (10)/(150-10)= 7.14% > 7%
      // Relayer should default to hub chain.
      sampleDepositData.inputAmount = toWei(10);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([MAINNET]);
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"71428571428571428"')).to.be.true;
    });
    it("Origin allocation is below target", async function () {
      // Set Polygon allocation lower than target:
      tokenClient.setTokenData(POLYGON, l2TokensForWeth[POLYGON], toWei(5));
      // Set Optimism allocation higher than target:
      tokenClient.setTokenData(OPTIMISM, l2TokensForWeth[OPTIMISM], toWei(30));

      // Post relay allocations:
      // Optimism (destination chain): (30-5)/(150-5)=17.2% > 12%
      // Polygon (origin chain): (5)/(150-5)=3.4% < 7%
      // Relayer should choose to refund origin since destination isn't an option.
      sampleDepositData.inputAmount = toWei(5);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([POLYGON, MAINNET]);
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"35714285714285714"')).to.be.true;
    });
    it("Origin allocation depends on outstanding transfers", async function () {
      // Set Polygon allocation lower than target:
      tokenClient.setTokenData(POLYGON, l2TokensForWeth[POLYGON], toWei(5));
      // Set Optimism allocation higher than target:
      tokenClient.setTokenData(OPTIMISM, l2TokensForWeth[OPTIMISM], toWei(30));

      // Post relay allocations:
      // Optimism (destination chain): (30-5)/(150-5)=17.2% > 12%
      // Polygon (origin chain): (5)/(150-5)=3.4% < 7%
      // Relayer should choose to refund origin since destination isn't an option.
      sampleDepositData.inputAmount = toWei(5);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([POLYGON, MAINNET]);

      // Now add outstanding transfers to Polygon that make the allocation above the target. Note that this
      // increases cumulative balance a bit.
      adapterManager.setMockedOutstandingCrossChainTransfers(POLYGON, owner.address, mainnetWeth, toWei(10));
      await inventoryClient.update();

      // Post relay allocations:
      // Optimism (destination chain): (30-5)/(160-5)=16.1% > 12%
      // Polygon (origin chain): (15)/(160-5)=9.6% > 7%
      // Relayer should now default to hub chain.
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([MAINNET]);
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"100000000000000000"')).to.be.true;
    });
    it("Origin allocation depends on short falls", async function () {
      // Set Polygon allocation lower than target:
      tokenClient.setTokenData(POLYGON, l2TokensForWeth[POLYGON], toWei(5));
      // Set Optimism allocation higher than target:
      tokenClient.setTokenData(OPTIMISM, l2TokensForWeth[OPTIMISM], toWei(30));

      // Shortfalls are subtracted from both numerator and denominator.
      tokenClient.setTokenShortFallData(POLYGON, l2TokensForWeth[POLYGON], [6969], toWei(5)); // Mock the shortfall.
      // Post relay allocations:
      // Optimism (destination chain): (25-5)/(145-5)=14.3% > 12%
      // Polygon (origin chain): (0)/(145-5)=0% < 7%
      // Relayer should still use origin chain
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([POLYGON, MAINNET]);
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"0"')).to.be.true; // (20-5)/(140-5)=0.11
    });
    it("Origin allocation depends on upcoming refunds", async function () {
      // Set Polygon allocation lower than target:
      tokenClient.setTokenData(POLYGON, l2TokensForWeth[POLYGON], toWei(5));
      // Set Optimism allocation higher than target:
      tokenClient.setTokenData(OPTIMISM, l2TokensForWeth[OPTIMISM], toWei(30));

      // Post relay allocations:
      // Optimism (destination chain): (30-5)/(150-5)=17.2% > 12%
      // Polygon (origin chain): (5)/(150-5)=3.4% < 7%
      // Relayer should choose to refund origin since destination isn't an option.
      sampleDepositData.inputAmount = toWei(5);
      sampleDepositData.outputAmount = await computeOutputAmount(sampleDepositData);

      bundleDataClient.setReturnedPendingBundleRefunds({
        [POLYGON]: createRefunds(owner.address, toWei(5), l2TokensForWeth[POLYGON]),
      });
      // We need HubPoolClient.l2TokenEnabledForL1Token() to return true for a given
      // L1 token and destination chain ID, otherwise it won't be counted in upcoming
      // refunds.
      hubPoolClient.setEnableAllL2Tokens(true);

      // Post relay allocations:
      // Optimism (destination chain): (30-5)/(155-5)=16.7% > 12%
      // Polygon (origin chain): (10)/(155-5)=6.7% > 7%
      // Relayer should still pick origin chain but compute a different allocation.
      expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.deep.equal([POLYGON, MAINNET]);
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"68965517241379310"')).to.be.true;
    });
    it("includes origin, destination and hub chain in repayment chain list", async function () {
      const possibleRepaymentChains = inventoryClient.getPossibleRepaymentChainIds(sampleDepositData);
      [sampleDepositData.originChainId, sampleDepositData.destinationChainId, MAINNET].forEach((chainId) => {
        expect(possibleRepaymentChains).to.include(chainId);
      });
      expect(possibleRepaymentChains.length).to.equal(3);
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
      inventoryClient.getSlowWithdrawalRepaymentChains(mainnetWeth).forEach((chainId) => {
        if (!excessRunningBalances[chainId]) {
          excessRunningBalances[chainId] = toWei("0");
        }
      });
      inventoryClient = new MockInventoryClient(
        owner.address,
        spyLogger,
        inventoryConfig,
        tokenClient,
        enabledChainIds,
        hubPoolClient,
        bundleDataClient,
        adapterManager,
        crossChainTransferClient
      );
      (inventoryClient as MockInventoryClient).setExcessRunningBalances(mainnetWeth, excessRunningBalances);
      const inputAmount = toBNWei(1);
      sampleDepositData = {
        depositId: 0,
        originChainId: POLYGON,
        destinationChainId: MAINNET,
        depositor: owner.address,
        recipient: owner.address,
        inputToken: l2TokensForWeth[POLYGON],
        inputAmount,
        outputToken: l2TokensForWeth[MAINNET],
        outputAmount: inputAmount,
        message: "0x",
        quoteTimestamp: hubPoolClient.currentTime!,
        fillDeadline: 0,
        exclusivityDeadline: 0,
        exclusiveRelayer: ZERO_ADDRESS,
      };
    });
    it("selects slow withdrawal chain with excess running balance and under relayer allocation", async function () {
      // Initial allocations are all under allocated so the first slow withdrawal chain should be selected since it has
      // the highest overage.
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
      inventoryClient.getSlowWithdrawalRepaymentChains(mainnetWeth).forEach((chainId) => {
        expect(possibleRepaymentChains).to.include(chainId);
      });
      [sampleDepositData.originChainId, sampleDepositData.destinationChainId].forEach((chainId) => {
        expect(possibleRepaymentChains).to.include(chainId);
      });
      expect(possibleRepaymentChains.length).to.equal(4);
    });
  });

  describe("In-protocol swap", async function () {
    const nativeUSDC = TOKEN_SYMBOLS_MAP.USDC.addresses;
    const bridgedUSDC = { ...TOKEN_SYMBOLS_MAP["USDC.e"].addresses, ...TOKEN_SYMBOLS_MAP["USDbC"].addresses };

    beforeEach(async function () {
      // Sub in a nested USDC config for the existing USDC config.
      const usdcConfig = {
        [nativeUSDC[OPTIMISM]]: {
          [OPTIMISM]: { targetPct: toWei(0.12), thresholdPct: toWei(0.1), targetOverageBuffer },
        },
        [nativeUSDC[POLYGON]]: {
          [POLYGON]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
        },
        [nativeUSDC[ARBITRUM]]: {
          [ARBITRUM]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
        },
        [bridgedUSDC[OPTIMISM]]: {
          [OPTIMISM]: { targetPct: toWei(0.12), thresholdPct: toWei(0.1), targetOverageBuffer },
        },
        [bridgedUSDC[POLYGON]]: {
          [POLYGON]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
        },
        [bridgedUSDC[ARBITRUM]]: {
          [ARBITRUM]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
        },
      };
      inventoryConfig.tokenConfig[mainnetUsdc] = usdcConfig;

      const inputAmount = toMegaWei(100);
      sampleDepositData = {
        depositId: 0,
        originChainId: ARBITRUM,
        destinationChainId: OPTIMISM,
        depositor: owner.address,
        recipient: owner.address,
        inputToken: nativeUSDC[ARBITRUM],
        inputAmount,
        outputToken: bridgedUSDC[OPTIMISM],
        outputAmount: inputAmount,
        message: "0x",
        quoteTimestamp: hubPoolClient.currentTime!,
        fillDeadline: 0,
        exclusivityDeadline: 0,
        exclusiveRelayer: ZERO_ADDRESS,
      };
    });

    it("outputToken is not supported as a repaymentToken", async function () {
      // Verify that there is no native USDC anywhere. The relayer is responsible for ensuring that it can make the fill.
      enabledChainIds
        .filter((chainId) => chainId !== MAINNET)
        .forEach((chainId) => expect(tokenClient.getBalance(chainId, nativeUSDC[chainId]).eq(bnZero)).to.be.true);

      // All chains are at target balance; cumulative balance will go down but repaymentToken balances on all chains are unaffected.
      expect(await inventoryClient.determineRefundChainId(sampleDepositData, mainnetUsdc)).to.deep.equal([MAINNET]);
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"71942446043165467"')).to.be.true; // (10000-0)/(14000-100)=0.71942

      // Even when the output amount is equal to the destination's entire balance, take repayment on mainnet.
      sampleDepositData.outputAmount = inventoryClient.getBalanceOnChain(OPTIMISM, mainnetUsdc);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData, mainnetUsdc)).to.deep.equal([MAINNET]);
      expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"83333333333333333"')).to.be.true; // (10000-0)/(14000-2000)=0.8333

      // Drop the relayer's repaymentToken balance on Optimism. Repayment chain should now be Optimism.
      let balance = tokenClient.getBalance(OPTIMISM, bridgedUSDC[OPTIMISM]);
      tokenClient.setTokenData(OPTIMISM, bridgedUSDC[OPTIMISM], bnZero);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData, mainnetUsdc)).to.deep.equal([
        OPTIMISM,
        MAINNET,
      ]);

      // Restore the Optimism balance and drop the Arbitrum balance. Repayment chain should now be Arbitrum.
      tokenClient.setTokenData(OPTIMISM, bridgedUSDC[OPTIMISM], balance);

      balance = tokenClient.getBalance(ARBITRUM, bridgedUSDC[ARBITRUM]);
      tokenClient.setTokenData(ARBITRUM, bridgedUSDC[ARBITRUM], bnZero);
      expect(await inventoryClient.determineRefundChainId(sampleDepositData, mainnetUsdc)).to.deep.equal([
        ARBITRUM,
        MAINNET,
      ]);
    });
  });
});
