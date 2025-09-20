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
import { Deposit, InventoryConfig } from "../src/interfaces";
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

describe("InventoryClient: Refund chain selection", async function () {
  const { MAINNET, OPTIMISM, POLYGON, ARBITRUM, BSC } = CHAIN_IDs;
  const enabledChainIds = [MAINNET, OPTIMISM, POLYGON, ARBITRUM, BSC];
  const mainnetWeth = TOKEN_SYMBOLS_MAP.WETH.addresses[MAINNET];
  const mainnetUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[MAINNET];

  let hubPoolClient: MockHubPoolClient, adapterManager: MockAdapterManager, tokenClient: MockTokenClient;
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
    hubPoolClient.addL1Token({ address: EvmAddress.from(mainnetWeth), decimals: 18, symbol: "WETH" });
    hubPoolClient.addL1Token({ address: EvmAddress.from(mainnetUsdc), decimals: 6, symbol: "USDC" });
    Object.keys(seedBalances).forEach((_chainId) => {
      const chainId = Number(_chainId);
      adapterManager.setMockedOutstandingCrossChainTransfers(
        chainId,
        toAddressType(owner.address, MAINNET),
        toAddressType(mainnetWeth, MAINNET),
        bnZero
      );
      adapterManager.setMockedOutstandingCrossChainTransfers(
        chainId,
        toAddressType(owner.address, MAINNET),
        toAddressType(mainnetUsdc, MAINNET),
        bnZero
      );
      tokenClient.setTokenData(
        chainId,
        toAddressType(l2TokensForWeth[chainId], chainId),
        seedBalances[chainId][mainnetWeth]
      );
      tokenClient.setTokenData(
        chainId,
        toAddressType(l2TokensForUsdc[chainId], chainId),
        seedBalances[chainId][mainnetUsdc]
      );
      hubPoolClient.setTokenMapping(mainnetWeth, chainId, l2TokensForWeth[chainId]);
      hubPoolClient.setTokenMapping(mainnetUsdc, chainId, l2TokensForUsdc[chainId]);
      hubPoolClient.mapTokenInfo(l2TokensForUsdc[chainId], "USDC", 6);
      hubPoolClient.mapTokenInfo(mainnetWeth[chainId], "WETH", 18);
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
    inventoryClient = new MockInventoryClient(
      toAddressType(owner.address, MAINNET),
      spyLogger,
      inventoryConfig,
      tokenClient,
      enabledChainIds,
      hubPoolClient,
      adapterManager,
      crossChainTransferClient,
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
      hubPoolClient.mapTokenInfo(l2TokensForWeth[ARBITRUM], "WETH", 6);
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
      hubPoolClient.mapTokenInfo(l2TokensForWeth[OPTIMISM], "WETH", 6);
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
      tokenClient.setTokenShortFallData(POLYGON, toAddressType(l2TokensForWeth[POLYGON], POLYGON), [6969], toWei(5)); // Mock the shortfall.
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
});
