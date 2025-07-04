import {
  BigNumber,
  FakeContract,
  SignerWithAddress,
  createSpyLogger,
  deployConfigStore,
  ethers,
  expect,
  hubPoolFixture,
  lastSpyLogIncludes,
  sinon,
  smock,
  spyLogIncludes,
  toBN,
  toWei,
  winston,
} from "./utils";

import { ConfigStoreClient, InventoryClient } from "../src/clients"; // Tested
import { CrossChainTransferClient } from "../src/clients/bridges";
import { InventoryConfig } from "../src/interfaces";
import { MockAdapterManager, MockBundleDataClient, MockHubPoolClient, MockTokenClient } from "./mocks/";
import {
  bnZero,
  CHAIN_IDs,
  createFormatFunction,
  ERC20,
  EvmAddress,
  fixedPointAdjustment as fixedPoint,
  getNetworkName,
  parseUnits,
  TOKEN_SYMBOLS_MAP,
  toAddressType,
} from "../src/utils";
import { MockBaseChainAdapter } from "./mocks/MockBaseChainAdapter";
import { utils as sdkUtils } from "@across-protocol/sdk";

const toMegaWei = (num: string | number | BigNumber) => parseUnits(num.toString(), 6);

let hubPoolClient: MockHubPoolClient, adapterManager: MockAdapterManager, tokenClient: MockTokenClient;
let bundleDataClient: MockBundleDataClient;
let owner: SignerWithAddress, spy: sinon.SinonSpy, spyLogger: winston.Logger;
let inventoryClient: InventoryClient; // tested
let crossChainTransferClient: CrossChainTransferClient;

const { MAINNET, OPTIMISM, POLYGON, BASE, ARBITRUM } = CHAIN_IDs;
const enabledChainIds = [MAINNET, OPTIMISM, POLYGON, BASE, ARBITRUM];
const mainnetWeth = TOKEN_SYMBOLS_MAP.WETH.addresses[MAINNET];
const mainnetUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[MAINNET];

let mainnetWethContract: FakeContract;
let mainnetUsdcContract: FakeContract;

// construct two mappings of chainId to token address. Set the l1 token address to the "real" token address.
const l2TokensForWeth = { [MAINNET]: mainnetWeth };
const l2TokensForUsdc = { [MAINNET]: mainnetUsdc };
enabledChainIds
  .filter((chainId) => chainId !== MAINNET)
  .forEach((chainId) => {
    l2TokensForWeth[chainId] = TOKEN_SYMBOLS_MAP.WETH.addresses[chainId];
    l2TokensForUsdc[chainId] = TOKEN_SYMBOLS_MAP.USDC.addresses[chainId];
  });

// Configure target percentages as 80% mainnet, 10% optimism, 5% polygon and 5% Arbitrum.
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
      [BASE]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
      [ARBITRUM]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
    },
    [mainnetUsdc]: {
      [OPTIMISM]: { targetPct: toWei(0.12), thresholdPct: toWei(0.1), targetOverageBuffer },
      [POLYGON]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
      [BASE]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
      [ARBITRUM]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
    },
  },
};

// Construct an initial distribution that keeps these values within the above thresholds.
const initialAllocation = {
  [MAINNET]: { [mainnetWeth]: toWei(100), [mainnetUsdc]: toMegaWei(10000) }, // seed 100 WETH and 10000 USDC
  [OPTIMISM]: { [mainnetWeth]: toWei(20), [mainnetUsdc]: toMegaWei(2000) }, // seed 20 WETH and 2000 USDC
  [POLYGON]: { [mainnetWeth]: toWei(10), [mainnetUsdc]: toMegaWei(1000) }, // seed 10 WETH and 1000 USDC
  [BASE]: { [mainnetWeth]: toWei(10), [mainnetUsdc]: toMegaWei(1000) }, // seed 10 WETH and 1000 USDC
  [ARBITRUM]: { [mainnetWeth]: toWei(10), [mainnetUsdc]: toMegaWei(1000) }, // seed 10 WETH and 1000 USDC
};

const initialWethTotal = toWei(150); // Sum over all 5 chains is 150
const initialUsdcTotal = toMegaWei(15000); // Sum over all 5 chains is 15000
const initialTotals = { [mainnetWeth]: initialWethTotal, [mainnetUsdc]: initialUsdcTotal };

describe("InventoryClient: Rebalancing inventory", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spy, spyLogger } = createSpyLogger());

    const { hubPool, dai: l1Token } = await hubPoolFixture();
    const { configStore } = await deployConfigStore(owner, [l1Token]);

    const configStoreClient = new ConfigStoreClient(spyLogger, configStore, { from: 0 }, 0);
    await configStoreClient.update();

    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);
    enabledChainIds.forEach((chainId) => {
      hubPoolClient.mapTokenInfo(l2TokensForWeth[chainId], "WETH", 18);
      hubPoolClient.mapTokenInfo(l2TokensForUsdc[chainId], "USDC", 6);
    });
    await hubPoolClient.update();

    adapterManager = new MockAdapterManager(null, null, null, null);
    tokenClient = new MockTokenClient(null, null, null, null);
    bundleDataClient = new MockBundleDataClient(null, null, null, null);

    crossChainTransferClient = new CrossChainTransferClient(spyLogger, enabledChainIds, adapterManager);

    inventoryClient = new InventoryClient(
      EvmAddress.from(owner.address),
      spyLogger,
      inventoryConfig,
      tokenClient,
      enabledChainIds,
      hubPoolClient,
      bundleDataClient,
      adapterManager,
      crossChainTransferClient
    );

    mainnetWethContract = await smock.fake(ERC20.abi, { address: mainnetWeth });
    mainnetUsdcContract = await smock.fake(ERC20.abi, { address: mainnetUsdc });

    mainnetWethContract.balanceOf.whenCalledWith(owner.address).returns(initialAllocation[MAINNET][mainnetWeth]);
    mainnetUsdcContract.balanceOf.whenCalledWith(owner.address).returns(initialAllocation[MAINNET][mainnetUsdc]);

    seedMocks(initialAllocation);
  });

  it("Accessors work as expected", async function () {
    expect(inventoryClient.getEnabledChains()).to.deep.equal(enabledChainIds);
    expect(inventoryClient.getL1Tokens().map((token) => token.toNative())).to.deep.equal(
      Object.keys(inventoryConfig.tokenConfig)
    );
    expect(inventoryClient.getEnabledL2Chains()).to.deep.equal([OPTIMISM, POLYGON, BASE, ARBITRUM]);

    expect(inventoryClient.getCumulativeBalance(EvmAddress.from(mainnetWeth)).eq(initialWethTotal)).to.be.true;
    expect(inventoryClient.getCumulativeBalance(EvmAddress.from(mainnetUsdc)).eq(initialUsdcTotal)).to.be.true;

    // Check the allocation matches to what is expected in the seed state of the mock. Check more complex matchers.
    const tokenDistribution = inventoryClient.getTokenDistributionPerL1Token();
    for (const chainId of enabledChainIds) {
      for (const l1Token of inventoryClient.getL1Tokens()) {
        expect(inventoryClient.getBalanceOnChain(chainId, l1Token)).to.equal(
          initialAllocation[chainId][l1Token.toNative()]
        );
        expect(
          inventoryClient.crossChainTransferClient
            .getOutstandingCrossChainTransferAmount(EvmAddress.from(owner.address), chainId, l1Token)
            .eq(bnZero)
        ).to.be.true; // For now no cross-chain transfers

        const expectedShare = initialAllocation[chainId][l1Token.toNative()]
          .mul(toWei(1))
          .div(initialTotals[l1Token.toNative()]);
        const l2Token = (l1Token.toNative() === mainnetWeth ? l2TokensForWeth : l2TokensForUsdc)[chainId];
        expect(tokenDistribution[l1Token.toNative()][chainId][l2Token]).to.equal(expectedShare);
      }
    }
  });

  it("Correctly decides when to execute rebalances: allocation too low", async function () {
    // Test the case where the ratio on a given chain is two low and the bot needs to rebalance.
    // As each chain is at the expected amounts there should be no rebalance.
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, "No rebalances required")).to.be.true;

    // Now, simulate the re-allocation of funds. Say that the USDC on arbitrum is half used up. This will leave arbitrum
    // with 500 USDC, giving a percentage of 500/15000 = 0.035. This is below the threshold of 0.5 so we should see
    // a re-balance executed in size of the target allocation + overshoot percentage.
    const initialBalance = initialAllocation[ARBITRUM][mainnetUsdc];
    expect(tokenClient.getBalance(ARBITRUM, toAddressType(l2TokensForUsdc[ARBITRUM], ARBITRUM)).eq(initialBalance)).to
      .be.true;
    const withdrawAmount = toMegaWei(500);
    tokenClient.decrementLocalBalance(ARBITRUM, toAddressType(l2TokensForUsdc[ARBITRUM], ARBITRUM), withdrawAmount);
    expect(
      tokenClient
        .getBalance(ARBITRUM, toAddressType(l2TokensForUsdc[ARBITRUM], ARBITRUM))
        .eq(initialBalance.sub(withdrawAmount))
    ).to.be.true;

    // The allocation of this should now be below the threshold of 5% so the inventory client should instruct a rebalance.
    const expectedAlloc = withdrawAmount.mul(toWei(1)).div(initialUsdcTotal.sub(withdrawAmount));
    expect(
      inventoryClient
        .getCurrentAllocationPct(
          EvmAddress.from(mainnetUsdc),
          ARBITRUM,
          toAddressType(l2TokensForUsdc[ARBITRUM], ARBITRUM)
        )
        .eq(expectedAlloc)
    ).to.be.true;

    // Execute rebalance. Check logs and enqueued transaction in Adapter manager. Given the total amount over all chains
    // and the amount still on arbitrum we would expect the module to instruct the relayer to send over:
    // (0.05 + 0.02) * (15000 - 500) - 500 = 515. Note the -500 component is there as arbitrum already has 500 remaining
    // post previous relay.
    const expectedBridgedAmount = toMegaWei(515);
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, "Executed Inventory rebalances")).to.be.true;
    expect(lastSpyLogIncludes(spy, "Rebalances sent to Arbitrum")).to.be.true;
    expect(lastSpyLogIncludes(spy, "515.00 USDC rebalanced")).to.be.true; // cast to formatting expected by client.
    expect(lastSpyLogIncludes(spy, "This meets target allocation of 7.00%")).to.be.true; // config from client.

    // The mock adapter manager should have been called with the expected transaction.
    expect(adapterManager.tokensSentCrossChain[ARBITRUM][mainnetUsdc].amount.eq(expectedBridgedAmount)).to.be.true;

    // Now, mock these funds having entered the canonical bridge.
    adapterManager.setMockedOutstandingCrossChainTransfers(
      ARBITRUM,
      EvmAddress.from(owner.address),
      EvmAddress.from(mainnetUsdc),
      expectedBridgedAmount
    );

    // Now that funds are "in the bridge" re-running the rebalance should not execute any transactions.
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, "No rebalances required")).to.be.true;
    expect(spyLogIncludes(spy, -2, '"outstandingTransfers":"515.00"')).to.be.true;

    // Now mock that funds have finished coming over the bridge and check behavior is as expected.
    adapterManager.setMockedOutstandingCrossChainTransfers(
      ARBITRUM,
      EvmAddress.from(owner.address),
      EvmAddress.from(mainnetUsdc),
      bnZero
    ); // zero the transfer. mock conclusion.

    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, "No rebalances required")).to.be.true;
    // We should see a log for Arbitrum that shows the actual balance after the relay concluded and the share. The
    // actual balance should be listed above at 1015. share should be 1015/(14500) = 0.7 (initial total - withdrawAmount).
    expect(spyLogIncludes(spy, -2, '"actualBalanceOnChain":"500.00"')).to.be.true;
    expect(spyLogIncludes(spy, -2, '"outstandingTransfers":"515.00"')).to.be.true;
    expect(spyLogIncludes(spy, -2, '"proRataShare":"7.00%"')).to.be.true;
  });

  it("Correctly decides when to execute rebalances: token shortfall", async function () {
    // Test the case where the funds on a particular chain are too low to meet a relay (shortfall) and the bot rebalances.
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();

    expect(tokenClient.getBalance(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON)).eq(toWei(10))).to.be.true; // Starting balance.

    // Construct a token shortfall of 18.
    const shortfallAmount = toWei(18);
    tokenClient.setTokenShortFallData(
      POLYGON,
      toAddressType(l2TokensForWeth[POLYGON], POLYGON),
      [6969],
      shortfallAmount
    );
    await inventoryClient.update();

    // If we now consider how much should be sent over the bridge. The spoke pool, considering the shortfall, has an
    // allocation of -5.3%. The target is, however, 5% of the total supply. factoring in the overshoot parameter we
    // should see a transfer of 5 + 2 - (-5.3)=12.3% of total inventory. This should be an amount of 0.1233*150=18.49.
    const expectedBridgedAmount = toBN("18499999999999999950");
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, "Executed Inventory rebalances")).to.be.true;
    expect(lastSpyLogIncludes(spy, "Rebalances sent to Polygon")).to.be.true;
    expect(lastSpyLogIncludes(spy, "18.49 WETH rebalanced")).to.be.true; // expected bridge amount rounded for logs.
    expect(lastSpyLogIncludes(spy, "This meets target allocation of 7.00%")).to.be.true; // config from client.

    // Note that there should be some additional state updates that we should check. In particular the token balance
    // on L1 should have been decremented by the amount sent over the bridge and the Inventory client should be tracking
    // the cross-chain transfers.
    expect(tokenClient.getBalance(MAINNET, EvmAddress.from(mainnetWeth)).eq(toWei(100).sub(expectedBridgedAmount))).to
      .be.true;
    expect(
      inventoryClient.crossChainTransferClient.getOutstandingCrossChainTransferAmount(
        EvmAddress.from(owner.address),
        POLYGON,
        EvmAddress.from(mainnetWeth)
      )
    ).to.equal(expectedBridgedAmount);

    // The mock adapter manager should have been called with the expected transaction.
    expect(adapterManager.tokensSentCrossChain[POLYGON][mainnetWeth].amount.eq(expectedBridgedAmount)).to.be.true;

    // Now, mock these funds having entered the canonical bridge.
    adapterManager.setMockedOutstandingCrossChainTransfers(
      POLYGON,
      EvmAddress.from(owner.address),
      EvmAddress.from(mainnetWeth),
      expectedBridgedAmount
    );

    // Now that funds are "in the bridge" re-running the rebalance should not execute any transactions as the util
    // should consider the funds in transit as part of the balance and therefore should not send more.
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, "No rebalances required")).to.be.true;
    expect(spyLogIncludes(spy, -2, '"outstandingTransfers":"18.49"')).to.be.true;
    expect(spyLogIncludes(spy, -2, '"actualBalanceOnChain":"10.00"')).to.be.true;
    expect(spyLogIncludes(spy, -2, '"virtualBalanceOnChain":"28.49"')).to.be.true;

    // Now mock that funds have finished coming over the bridge and check behavior is as expected.
    // Zero the transfer. mock conclusion.
    adapterManager.setMockedOutstandingCrossChainTransfers(
      POLYGON,
      EvmAddress.from(owner.address),
      EvmAddress.from(mainnetWeth),
      bnZero
    );
    // Balance after the relay concludes should be initial + bridged amount as 10+17.9=27.9
    const expectedPostRelayBalance = toWei(10).add(expectedBridgedAmount);
    tokenClient.setTokenData(
      POLYGON,
      toAddressType(l2TokensForWeth[POLYGON], POLYGON),
      expectedPostRelayBalance,
      bnZero
    );
    // The token shortfall should now no longer be an issue. This means we can fill the relay of 18 size now.
    tokenClient.setTokenShortFallData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), [6969], bnZero);
    tokenClient.decrementLocalBalance(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), shortfallAmount); // mock the relay actually filling.

    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, "No rebalances required")).to.be.true;
    // We should see a log for chain Arbitrum that shows the actual balance after the relay concluded and the share.
    // actual balance should be listed above at 945. share should be 945/(13500) =0.7 (initial total - withdrawAmount).
    // expect(spyLogIncludes(spy, -2, `"${ARBITRUM}":{"actualBalanceOnChain":"945.00"`)).to.be.true;
    // expect(spyLogIncludes(spy, -2, `"proRataShare":"7.00%"`)).to.be.true;
  });

  it("Refuses to send rebalance when ERC20 balance changes", async function () {
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();

    // Now, simulate the re-allocation of funds. Say that the USDC on arbitrum is half used up. This will leave arbitrum
    // with 500 USDC, giving a percentage of 500/14000 = 0.035. This is below the threshold of 0.5 so we should see
    // a re-balance executed in size of the target allocation + overshoot percentage.
    const initialBalance = initialAllocation[ARBITRUM][mainnetUsdc];
    expect(tokenClient.getBalance(ARBITRUM, toAddressType(l2TokensForUsdc[ARBITRUM], ARBITRUM))).to.equal(
      initialBalance
    );
    const withdrawAmount = toMegaWei(500);
    tokenClient.decrementLocalBalance(ARBITRUM, toAddressType(l2TokensForUsdc[ARBITRUM], ARBITRUM), withdrawAmount);
    expect(tokenClient.getBalance(ARBITRUM, toAddressType(l2TokensForUsdc[ARBITRUM], ARBITRUM))).to.equal(
      withdrawAmount
    );

    // The allocation of this should now be below the threshold of 5% so the inventory client should instruct a rebalance.
    const expectedAlloc = withdrawAmount.mul(toWei(1)).div(initialUsdcTotal.sub(withdrawAmount));
    expect(
      inventoryClient.getCurrentAllocationPct(
        EvmAddress.from(mainnetUsdc),
        ARBITRUM,
        toAddressType(l2TokensForUsdc[ARBITRUM], ARBITRUM)
      )
    ).to.equal(expectedAlloc);

    // Set USDC balance to be lower than expected.
    mainnetUsdcContract.balanceOf
      .whenCalledWith(owner.address)
      .returns(initialAllocation[MAINNET][mainnetUsdc].sub(toMegaWei(1)));
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(spyLogIncludes(spy, -2, "Token balance on mainnet changed")).to.be.true;

    // Reset and check again.
    mainnetUsdcContract.balanceOf.whenCalledWith(owner.address).returns(initialAllocation[MAINNET][mainnetUsdc]);
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, "Executed Inventory rebalances")).to.be.true;
  });

  describe("Withdraws excess balance from L2 to L1", function () {
    const testChain = OPTIMISM;
    const testL1Token = mainnetUsdc;
    const testL2Token = l2TokensForUsdc[testChain];
    const targetOverageBuffer = toWei("2");
    beforeEach(function () {
      inventoryConfig.tokenConfig[testL1Token][testChain].withdrawExcessPeriod = 7200;
      inventoryConfig.tokenConfig[testL1Token][testChain].targetOverageBuffer = targetOverageBuffer;
      const mockAdapter = new MockBaseChainAdapter();
      adapterManager.setAdapters(testChain, mockAdapter);
    });

    it("Withdraws excess balance from L2 to L1", async function () {
      // The threshold to trigger an excess withdrawal is when the currentAllocPct is greater than the
      // targetPct multiplied by the "targetPctMultiplier"
      const targetPctMultiplier = targetOverageBuffer.mul(toWei("0.95")).div(toWei("1"));
      const excessWithdrawThresholdPct = inventoryConfig.tokenConfig[testL1Token][testChain].targetPct
        .mul(targetPctMultiplier)
        .div(toWei("1"));

      // We can trigger this by increasing the balance on the chain a lot. In this case, we set it
      // equal to the current cumulative balance so the chain allocation gets set close to 50%.
      let currentCumulativeBalance = inventoryClient.getCumulativeBalance(EvmAddress.from(testL1Token));
      const increaseBalanceAmount = currentCumulativeBalance;
      tokenClient.setTokenData(testChain, toAddressType(testL2Token, hubPoolClient.chainId), increaseBalanceAmount);
      currentCumulativeBalance = inventoryClient.getCumulativeBalance(EvmAddress.from(testL1Token));
      const currentChainBalance = inventoryClient.getBalanceOnChain(testChain, EvmAddress.from(testL1Token));
      const currentAllocationPct = currentChainBalance.mul(toWei(1)).div(currentCumulativeBalance);
      expect(currentAllocationPct.gte(excessWithdrawThresholdPct)).to.be.true;

      await inventoryClient.withdrawExcessBalances();
      const expectedWithdrawalPct = currentAllocationPct.sub(
        inventoryConfig.tokenConfig[testL1Token][testChain].targetPct
      );
      const expectedWithdrawalAmount = expectedWithdrawalPct.mul(currentCumulativeBalance).div(toWei(1));
      expect(adapterManager.withdrawalsRequired[0].amountToWithdraw).eq(expectedWithdrawalAmount);
      expect(adapterManager.withdrawalsRequired[0].l2ChainId).eq(testChain);
      expect(adapterManager.withdrawalsRequired[0].l2Token.toNative()).eq(testL2Token);
      expect(adapterManager.withdrawalsRequired[0].address.toNative()).eq(owner.address);
    });

    it("Withdrawal amount is in correct L2 token decimals", async function () {
      // This test validates when an L2 token has different decimals than the L1 token, that the
      // withdrawal amount is in the correct L2 token decimals.
      hubPoolClient.mapTokenInfo(testL2Token, "USDC", 18);
      const l2TokenConverter = sdkUtils.ConvertDecimals(6, 18);

      // We set the token balance on the L2 chain using 18 decimals rather than 6:
      let currentCumulativeBalance = inventoryClient.getCumulativeBalance(EvmAddress.from(testL1Token));
      const increaseBalanceAmount = l2TokenConverter(currentCumulativeBalance);
      tokenClient.setTokenData(testChain, toAddressType(testL2Token, hubPoolClient.chainId), increaseBalanceAmount);
      currentCumulativeBalance = inventoryClient.getCumulativeBalance(EvmAddress.from(testL1Token));

      // Current allocation computations should still be able to be performed correctly:
      const currentChainBalance = inventoryClient.getBalanceOnChain(testChain, EvmAddress.from(testL1Token));
      const currentAllocationPct = currentChainBalance.mul(toWei(1)).div(currentCumulativeBalance);
      expect(currentAllocationPct).eq(toWei("0.5"));

      await inventoryClient.withdrawExcessBalances();
      const expectedWithdrawalPct = currentAllocationPct.sub(
        BigNumber.from(inventoryConfig.tokenConfig[testL1Token][testChain].targetPct)
      );

      // Expected withdrawal amount is in correct decimals:
      const expectedWithdrawalAmount = l2TokenConverter(
        expectedWithdrawalPct.mul(currentCumulativeBalance).div(toWei(1))
      );
      expect(adapterManager.withdrawalsRequired[0].amountToWithdraw).eq(expectedWithdrawalAmount);
    });
  });

  describe("Remote chain token mappings", async function () {
    const nativeUSDC = TOKEN_SYMBOLS_MAP.USDC.addresses;
    const bridgedUSDC = { ...TOKEN_SYMBOLS_MAP["USDC.e"].addresses, ...TOKEN_SYMBOLS_MAP["USDbC"].addresses };
    const usdcConfig = {
      [nativeUSDC[OPTIMISM]]: {
        [OPTIMISM]: { targetPct: toWei(0.12), thresholdPct: toWei(0.1), targetOverageBuffer },
      },
      [nativeUSDC[POLYGON]]: {
        [POLYGON]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
      },
      [nativeUSDC[BASE]]: {
        [BASE]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
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
      [bridgedUSDC[BASE]]: {
        [BASE]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
      },
      [bridgedUSDC[ARBITRUM]]: {
        [ARBITRUM]: { targetPct: toWei(0.07), thresholdPct: toWei(0.05), targetOverageBuffer },
      },
    };

    beforeEach(async function () {
      // Sub in a nested USDC config for the existing USDC single-token config.
      inventoryConfig.tokenConfig[mainnetUsdc] = usdcConfig;

      enabledChainIds.forEach((chainId) => {
        hubPoolClient.mapTokenInfo(nativeUSDC[chainId], "USDC", 6);
        hubPoolClient.mapTokenInfo(bridgedUSDC[chainId], "USDC", 6);
      });
    });

    it("Correctly resolves 1:many token mappings", async function () {
      // Caller must specify l2Token for 1:many mappings.
      expect(() => inventoryClient.getTokenConfig(EvmAddress.from(mainnetUsdc), BASE)).to.throw;

      enabledChainIds
        .filter((chainId) => chainId !== MAINNET)
        .forEach((chainId) => {
          const config = inventoryClient.getTokenConfig(
            EvmAddress.from(mainnetUsdc),
            chainId,
            toAddressType(bridgedUSDC[chainId], chainId)
          );
          expect(config).to.exist;

          const expectedConfig = inventoryConfig.tokenConfig[mainnetUsdc][bridgedUSDC[chainId]][chainId];
          expect(expectedConfig).to.exist;
          expect(expectedConfig).to.deep.equal(expectedConfig);
        });
    });

    it("Correctly isolates 1:many token balances", async function () {
      enabledChainIds
        .filter((chainId) => chainId !== MAINNET)
        .forEach((chainId) => {
          // Non-zero native USDC balance, zero bridged balance.
          const nativeBalance = inventoryClient.getBalanceOnChain(
            chainId,
            EvmAddress.from(mainnetUsdc),
            toAddressType(nativeUSDC[chainId], chainId)
          );
          expect(nativeBalance.gt(bnZero)).to.be.true;

          let bridgedBalance = inventoryClient.getBalanceOnChain(
            chainId,
            EvmAddress.from(mainnetUsdc),
            toAddressType(bridgedUSDC[chainId], chainId)
          );
          expect(bridgedBalance.eq(bnZero)).to.be.true;

          // Add bridged balance.
          tokenClient.setTokenData(chainId, toAddressType(bridgedUSDC[chainId], chainId), nativeBalance);

          // Native balance should now match bridged balance.
          bridgedBalance = inventoryClient.getBalanceOnChain(
            chainId,
            EvmAddress.from(mainnetUsdc),
            toAddressType(bridgedUSDC[chainId], chainId)
          );
          expect(nativeBalance.eq(bridgedBalance)).to.be.true;
        });
    });

    it("Correctly normalizes remote token balance to L1 token decimals", async function () {
      // Let's pretend that the Optimism USDC version uses 18 decimals instead of 6, like the L1 token decimals:
      const testChain = CHAIN_IDs.OPTIMISM;
      hubPoolClient.mapTokenInfo(bridgedUSDC[testChain], "USDC", 18);
      let bridgedBalance = inventoryClient.getBalanceOnChain(
        testChain,
        EvmAddress.from(mainnetUsdc),
        toAddressType(bridgedUSDC[testChain], testChain)
      );
      expect(bridgedBalance.eq(bnZero)).to.be.true;

      // Add balance of optimism token:
      const testBalance = toWei("10");
      tokenClient.setTokenData(testChain, toAddressType(bridgedUSDC[testChain], testChain), testBalance);

      const convertedTestBalance = toMegaWei("10");
      bridgedBalance = inventoryClient.getBalanceOnChain(
        testChain,
        EvmAddress.from(mainnetUsdc),
        toAddressType(bridgedUSDC[testChain], testChain)
      );
      expect(bridgedBalance.eq(convertedTestBalance)).to.be.true;

      // Cumulative balance returns in L1 token decimals:
      const cumulativeBalance = inventoryClient.getCumulativeBalance(EvmAddress.from(mainnetUsdc));
      expect(cumulativeBalance.eq(initialUsdcTotal.add(convertedTestBalance))).to.be.true;
    });

    it("Correctly normalizes shortfalls to L1 token decimals", async function () {
      const testChain = CHAIN_IDs.OPTIMISM;
      hubPoolClient.mapTokenInfo(bridgedUSDC[testChain], "USDC", 18);
      let bridgedBalance = inventoryClient.getBalanceOnChain(
        testChain,
        EvmAddress.from(mainnetUsdc),
        toAddressType(bridgedUSDC[testChain], testChain)
      );
      expect(bridgedBalance.eq(bnZero)).to.be.true;

      // Add balance of optimism token:
      const testBalance = toWei("10");
      tokenClient.setTokenData(testChain, toAddressType(bridgedUSDC[testChain], testChain), testBalance);

      const convertedTestBalance = toMegaWei("10");
      bridgedBalance = inventoryClient.getBalanceOnChain(
        testChain,
        EvmAddress.from(mainnetUsdc),
        toAddressType(bridgedUSDC[testChain], testChain)
      );
      expect(bridgedBalance.eq(convertedTestBalance)).to.be.true;

      const shortfallAmount = toWei("1");
      tokenClient.setTokenShortFallData(
        testChain,
        toAddressType(bridgedUSDC[testChain], testChain),
        [6969],
        shortfallAmount
      );
      await inventoryClient.update();

      const cumulativeBalance = inventoryClient.getCumulativeBalance(EvmAddress.from(mainnetUsdc));
      const currentAllocationPct = inventoryClient.getCurrentAllocationPct(
        EvmAddress.from(mainnetUsdc),
        testChain,
        toAddressType(bridgedUSDC[testChain], testChain)
      );
      const expectedCurrentAllocationPct = testBalance
        .sub(shortfallAmount)
        .mul(toWei("1"))
        .div(sdkUtils.ConvertDecimals(6, 18)(cumulativeBalance));
      expect(currentAllocationPct).eq(expectedCurrentAllocationPct);
    });

    it("Correctly sums 1:many token balances", async function () {
      enabledChainIds
        .filter((chainId) => chainId !== MAINNET)
        .forEach((chainId) => {
          const bridgedBalance = inventoryClient.getBalanceOnChain(
            chainId,
            EvmAddress.from(mainnetUsdc),
            toAddressType(bridgedUSDC[chainId], chainId)
          );
          expect(bridgedBalance.eq(bnZero)).to.be.true;

          const nativeBalance = inventoryClient.getBalanceOnChain(
            chainId,
            EvmAddress.from(mainnetUsdc),
            toAddressType(nativeUSDC[chainId], chainId)
          );
          expect(nativeBalance.gt(bnZero)).to.be.true;

          const cumulativeBalance = inventoryClient.getCumulativeBalance(EvmAddress.from(mainnetUsdc));
          expect(cumulativeBalance.eq(initialUsdcTotal)).to.be.true;

          tokenClient.setTokenData(chainId, toAddressType(bridgedUSDC[chainId], chainId), nativeBalance);

          const newBalance = inventoryClient.getCumulativeBalance(EvmAddress.from(mainnetUsdc));
          expect(newBalance.eq(initialUsdcTotal.add(nativeBalance))).to.be.true;

          // Revert to 0 balance for bridged USDC.
          tokenClient.setTokenData(chainId, toAddressType(bridgedUSDC[chainId], chainId), bnZero);
        });
    });

    it("Correctly tracks 1:many token distributions", async function () {
      enabledChainIds
        .filter((chainId) => chainId !== MAINNET)
        .forEach((chainId) => {
          // Total USDC across all chains.
          let cumulativeBalance = inventoryClient.getCumulativeBalance(EvmAddress.from(mainnetUsdc));
          expect(cumulativeBalance.gt(bnZero)).to.be.true;
          expect(cumulativeBalance.eq(initialUsdcTotal)).to.be.true;

          // The initial allocation is all native USDC, 0 bridged.
          const nativeAllocation = inventoryClient.getCurrentAllocationPct(
            EvmAddress.from(mainnetUsdc),
            chainId,
            toAddressType(nativeUSDC[chainId], chainId)
          );
          expect(nativeAllocation.gt(bnZero)).to.be.true;
          let balance = inventoryClient.getBalanceOnChain(
            chainId,
            EvmAddress.from(mainnetUsdc),
            toAddressType(nativeUSDC[chainId], chainId)
          );
          expect(nativeAllocation.eq(balance.mul(fixedPoint).div(cumulativeBalance))).to.be.true;

          let bridgedAllocation = inventoryClient.getCurrentAllocationPct(
            EvmAddress.from(mainnetUsdc),
            chainId,
            toAddressType(bridgedUSDC[chainId], chainId)
          );
          expect(bridgedAllocation.eq(bnZero)).to.be.true;

          balance = inventoryClient.getBalanceOnChain(
            chainId,
            EvmAddress.from(mainnetUsdc),
            toAddressType(bridgedUSDC[chainId], chainId)
          );
          expect(bridgedAllocation.eq(bnZero)).to.be.true;

          // Add bridged USDC, same amount as native USDC.
          balance = inventoryClient.getBalanceOnChain(
            chainId,
            EvmAddress.from(mainnetUsdc),
            toAddressType(nativeUSDC[chainId], chainId)
          );
          tokenClient.setTokenData(chainId, toAddressType(bridgedUSDC[chainId], chainId), balance);
          expect(
            inventoryClient
              .getBalanceOnChain(chainId, EvmAddress.from(mainnetUsdc), toAddressType(bridgedUSDC[chainId], chainId))
              .eq(balance)
          ).to.be.true;
          expect(bridgedAllocation.eq(bnZero)).to.be.true;

          // Native USDC allocation should now be non-zero.
          bridgedAllocation = inventoryClient.getCurrentAllocationPct(
            EvmAddress.from(mainnetUsdc),
            chainId,
            toAddressType(bridgedUSDC[chainId], chainId)
          );
          expect(bridgedAllocation.gt(bnZero)).to.be.true;

          expect(inventoryClient.getCumulativeBalance(EvmAddress.from(mainnetUsdc)).gt(cumulativeBalance)).to.be.true;
          cumulativeBalance = inventoryClient.getCumulativeBalance(EvmAddress.from(mainnetUsdc));
          expect(cumulativeBalance.gt(initialUsdcTotal)).to.be.true;

          // Return bridged USDC balance to 0 for next loop.
          tokenClient.setTokenData(chainId, toAddressType(bridgedUSDC[chainId], chainId), bnZero);
        });
    });

    it("Correctly rebalances mainnet USDC into non-repayment USDC", async function () {
      // Unset all bridged USDC allocations.
      for (const chainId of [OPTIMISM, POLYGON, BASE, ARBITRUM]) {
        const l2Token = bridgedUSDC[chainId];
        hubPoolClient.mapTokenInfo(l2Token, "USDC.e", 6);
        delete inventoryConfig.tokenConfig[mainnetUsdc][l2Token];
      }

      await inventoryClient.update();
      await inventoryClient.rebalanceInventoryIfNeeded();
      expect(lastSpyLogIncludes(spy, "No rebalances required")).to.be.true;

      const cumulativeUSDC = inventoryClient.getCumulativeBalance(EvmAddress.from(mainnetUsdc));
      const targetPct = toWei(0.1);
      const thresholdPct = toWei(0.05);
      const expectedRebalance = cumulativeUSDC.mul(targetPct).div(fixedPoint);
      const { decimals } = TOKEN_SYMBOLS_MAP.USDC;
      const formatter = createFormatFunction(2, 4, false, decimals);
      const formattedAmount = formatter(expectedRebalance.toString());

      let virtualMainnetBalance = initialAllocation[MAINNET][mainnetUsdc];

      for (const chainId of [OPTIMISM, POLYGON, BASE, ARBITRUM]) {
        const chain = getNetworkName(chainId);
        await inventoryClient.update();
        const l2Token = bridgedUSDC[chainId];

        // Apply a new target balance for bridged USDC.
        inventoryConfig.tokenConfig[mainnetUsdc][l2Token] = {
          [chainId]: { targetPct, thresholdPct, targetOverageBuffer },
        };

        await inventoryClient.update();
        await inventoryClient.rebalanceInventoryIfNeeded();
        expect(lastSpyLogIncludes(spy, `Rebalances sent to ${chain}`)).to.be.true;
        expect(lastSpyLogIncludes(spy, `${formattedAmount} USDC.e rebalanced`)).to.be.true;
        expect(lastSpyLogIncludes(spy, "This meets target allocation of 10.00%")).to.be.true; // config from client.

        // Decrement the mainnet USDC balance to simulate the rebalance.
        virtualMainnetBalance = virtualMainnetBalance.sub(expectedRebalance);
        mainnetUsdcContract.balanceOf.whenCalledWith(owner.address).returns(virtualMainnetBalance);

        // The mock adapter manager should have been called with the expected transaction.
        expect(adapterManager.tokensSentCrossChain[chainId][mainnetUsdc].amount.eq(expectedRebalance)).to.be.true;

        await inventoryClient.update();
        await inventoryClient.rebalanceInventoryIfNeeded();
        expect(lastSpyLogIncludes(spy, "No rebalances required")).to.be.true;
        expect(spyLogIncludes(spy, -2, `"outstandingTransfers":"${formattedAmount}"`)).to.be.true;
      }
    });
  });
});

function seedMocks(seedBalances: { [chainId: string]: { [token: string]: BigNumber } }) {
  hubPoolClient.addL1Token({ address: EvmAddress.from(mainnetWeth), decimals: 18, symbol: "WETH" });
  hubPoolClient.addL1Token({ address: EvmAddress.from(mainnetUsdc), decimals: 6, symbol: "USDC" });
  enabledChainIds.forEach((chainId) => {
    adapterManager.setMockedOutstandingCrossChainTransfers(
      chainId,
      EvmAddress.from(owner.address),
      EvmAddress.from(mainnetWeth),
      bnZero
    );
    adapterManager.setMockedOutstandingCrossChainTransfers(
      chainId,
      EvmAddress.from(owner.address),
      EvmAddress.from(mainnetUsdc),
      bnZero
    );
    tokenClient.setTokenData(
      chainId,
      toAddressType(l2TokensForWeth[chainId], chainId),
      seedBalances[chainId][mainnetWeth],
      bnZero
    );
    tokenClient.setTokenData(
      chainId,
      toAddressType(l2TokensForUsdc[chainId], chainId),
      seedBalances[chainId][mainnetUsdc],
      bnZero
    );
    hubPoolClient.setTokenMapping(mainnetWeth, chainId, l2TokensForWeth[chainId]);
    hubPoolClient.setTokenMapping(mainnetUsdc, chainId, l2TokensForUsdc[chainId]);
  });
}
