import {
  SignerWithAddress,
  createSpyLogger,
  deployConfigStore,
  ethers,
  expect,
  hubPoolFixture,
  toBNWei,
  toWei,
  winston,
  randomAddress,
  deploySpokePoolWithToken,
} from "./utils";

import { BundleDataApproxClient, SpokePoolClient } from "../src/clients"; // Tested
import {
  CHAIN_IDs,
  bnZero,
  TOKEN_SYMBOLS_MAP,
  toAddressType,
  getCurrentTime,
  ZERO_BYTES,
  toBN,
  EvmAddress,
} from "../src/utils";
import { MockBundleDataApproxClient, MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient } from "./mocks";
import { interfaces } from "@across-protocol/sdk";
import { ProposedRootBundle, RootBundleRelayWithBlock } from "../src/interfaces";

describe("BundleDataApproxClient: Accounting for unexecuted, upcoming relayer refunds and deposits", async function () {
  const { MAINNET, OPTIMISM, BSC, POLYGON } = CHAIN_IDs;
  const enabledChainIds = [MAINNET, OPTIMISM, BSC];
  const mainnetWeth = TOKEN_SYMBOLS_MAP.WETH.addresses[MAINNET];
  const mainnetUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[MAINNET];

  let hubPoolClient: MockHubPoolClient;
  let owner: SignerWithAddress, spyLogger: winston.Logger;
  let bundleDataClient: BundleDataApproxClient; // tested
  let spokePoolClients: { [chainId: number]: SpokePoolClient } = {};
  let configStoreClient: MockConfigStoreClient;

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

  let l1Weth: EvmAddress, relayer: EvmAddress, l1Usdc: EvmAddress;

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spyLogger } = createSpyLogger());
    l1Weth = toAddressType(mainnetWeth, MAINNET);
    relayer = toAddressType(owner.address, MAINNET);
    l1Usdc = toAddressType(mainnetUsdc, MAINNET);

    const { hubPool, dai: l1Token } = await hubPoolFixture();
    const { configStore } = await deployConfigStore(owner, [l1Token]);
    const { spokePool: spokePool_MAINNET, deploymentBlock: deploymentBlock_MAINNET } =
      await deploySpokePoolWithToken(MAINNET);
    const { spokePool: spokePool_OPTIMISM, deploymentBlock: deploymentBlock_OPTIMISM } =
      await deploySpokePoolWithToken(OPTIMISM);
    const { spokePool: spokePool_BSC, deploymentBlock: deploymentBlock_BSC } = await deploySpokePoolWithToken(BSC);

    configStoreClient = new MockConfigStoreClient(spyLogger, configStore);
    await configStoreClient.update();

    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);
    hubPoolClient.setDefaultRealizedLpFeePct(bnZero);
    await hubPoolClient.update();

    const spokePoolClient_MAINNET = new MockSpokePoolClient(
      spyLogger,
      spokePool_MAINNET.connect(owner),
      MAINNET,
      deploymentBlock_MAINNET
    );
    const spokePoolClient_OPTIMISM = new MockSpokePoolClient(
      spyLogger,
      spokePool_OPTIMISM.connect(owner),
      OPTIMISM,
      deploymentBlock_OPTIMISM
    );
    const spokePoolClient_BSC = new MockSpokePoolClient(
      spyLogger,
      spokePool_BSC.connect(owner),
      BSC,
      deploymentBlock_BSC
    );

    spokePoolClients = {
      [MAINNET]: spokePoolClient_MAINNET,
      [OPTIMISM]: spokePoolClient_OPTIMISM,
      [BSC]: spokePoolClient_BSC,
    };
    bundleDataClient = new MockBundleDataApproxClient(
      spokePoolClients,
      hubPoolClient,
      enabledChainIds,
      [toAddressType(mainnetWeth, MAINNET), toAddressType(mainnetUsdc, MAINNET)],
      spyLogger
    );
    (bundleDataClient as MockBundleDataApproxClient).setTokenMapping({
      [mainnetWeth]: {
        [MAINNET]: mainnetWeth,
        [OPTIMISM]: l2TokensForWeth[OPTIMISM],
        [BSC]: l2TokensForWeth[BSC],
      },
      [mainnetUsdc]: {
        [MAINNET]: mainnetUsdc,
        [OPTIMISM]: l2TokensForUsdc[OPTIMISM],
        [BSC]: l2TokensForUsdc[BSC],
      },
    });

    // Set up token mappings on the hub pool client so getL2TokenForL1TokenAtBlock works.
    for (const chainId of enabledChainIds) {
      hubPoolClient.setTokenMapping(mainnetWeth, chainId, l2TokensForWeth[chainId]);
      hubPoolClient.setTokenMapping(mainnetUsdc, chainId, l2TokensForUsdc[chainId]);
    }
  });

  async function generateFill(
    inputTokenSymbol: "USDC" | "WETH",
    originChainId: number,
    repaymentChainId: number,
    relayer = owner.address,
    inputAmount = toWei(1)
  ): Promise<interfaces.Log> {
    const destinationChainId = repaymentChainId;
    const spokePoolClient = spokePoolClients[repaymentChainId];
    const newEvent = (spokePoolClient as unknown as MockSpokePoolClient).fillRelay({
      message: "0x",
      messageHash: ZERO_BYTES,
      inputToken: toAddressType(
        inputTokenSymbol === "USDC" ? l2TokensForUsdc[originChainId] : l2TokensForWeth[originChainId],
        originChainId
      ),
      outputToken: toAddressType(
        inputTokenSymbol === "USDC" ? l2TokensForUsdc[destinationChainId] : l2TokensForWeth[destinationChainId],
        destinationChainId
      ),
      destinationChainId,
      depositor: toAddressType(owner.address, originChainId),
      recipient: toAddressType(owner.address, destinationChainId),
      exclusivityDeadline: getCurrentTime() + 14400,
      depositId: bnZero,
      exclusiveRelayer: toAddressType(relayer, originChainId),
      inputAmount,
      outputAmount: inputAmount,
      fillDeadline: getCurrentTime() + 14400,
      blockNumber: spokePoolClient.latestHeightSearched,
      txnIndex: 0,
      logIndex: 0,
      txnRef: "0x",
      relayer: toAddressType(relayer, MAINNET),
      originChainId,
      repaymentChainId,
      relayExecutionInfo: {
        updatedRecipient: toAddressType(owner.address, destinationChainId),
        updatedMessage: "0x",
        updatedMessageHash: ZERO_BYTES,
        updatedOutputAmount: toWei(1),
        fillType: interfaces.FillType.FastFill,
      },
    } as interfaces.FillWithBlock);
    await spokePoolClient.update(["FilledRelay"]);
    return newEvent;
  }

  async function generateDeposit(
    inputTokenSymbol: "USDC" | "WETH",
    inputChainId: number,
    inputAmount = toWei(1)
  ): Promise<interfaces.Log> {
    const spokePoolClient = spokePoolClients[inputChainId];
    const newEvent = (spokePoolClient as unknown as MockSpokePoolClient).deposit({
      inputToken: toAddressType(
        inputTokenSymbol === "USDC" ? l2TokensForUsdc[inputChainId] : l2TokensForWeth[inputChainId],
        inputChainId
      ),
      inputAmount,
      depositor: toAddressType(owner.address, inputChainId),
      recipient: toAddressType(owner.address, inputChainId),
      outputToken: toAddressType(randomAddress(), inputChainId),
      outputAmount: inputAmount,
      quoteTimestamp: getCurrentTime(),
      fillDeadline: getCurrentTime() + 14400,
      exclusivityDeadline: getCurrentTime() + 14400,
      exclusiveRelayer: toAddressType(owner.address, inputChainId),
      originChainId: inputChainId,
      blockNumber: spokePoolClient.latestHeightSearched,
      txnIndex: 0,
      logIndex: 0,
    } as interfaces.DepositWithBlock);
    await spokePoolClient.update(["FundsDeposited"]);
    return newEvent;
  }

  describe("getApproximateRefundsForToken", function () {
    // Helper to create 2D fromBlocks where every [repaymentChain][fillChain] has the same value.
    function uniformFromBlocks(
      chains: number[],
      value: number
    ): { [repaymentChainId: number]: { [fillChainId: number]: number } } {
      return Object.fromEntries(chains.map((r) => [r, Object.fromEntries(chains.map((f) => [f, value]))]));
    }

    it("Accumulates fills sent after the fromBlocks", async function () {
      // Returns object of refunds grouped by repayment chain:
      const fromBlocks = uniformFromBlocks([MAINNET, OPTIMISM, BSC, POLYGON], 1);
      // Send two fills that should be counted:
      const fill1 = await generateFill("WETH", MAINNET, MAINNET, owner.address);
      const fill2 = await generateFill("WETH", MAINNET, OPTIMISM, owner.address);
      const wethRefunds = bundleDataClient.getApproximateRefundsForToken(
        toAddressType(mainnetWeth, MAINNET),
        fromBlocks
      );
      expect(wethRefunds[MAINNET][owner.address]).to.equal(fill1.args.inputAmount);
      expect(wethRefunds[OPTIMISM][owner.address]).to.equal(fill2.args.inputAmount);

      // Ignores fills if block number is less than fromBlocks:
      const highFromBlocks = uniformFromBlocks([MAINNET, OPTIMISM, BSC], 1000000000000000000);
      const wethRefunds3 = bundleDataClient.getApproximateRefundsForToken(
        toAddressType(mainnetWeth, MAINNET),
        highFromBlocks
      );
      expect(wethRefunds3[MAINNET][owner.address]).to.be.undefined;
      expect(wethRefunds3[OPTIMISM][owner.address]).to.be.undefined;
      expect(wethRefunds3[BSC][owner.address]).to.be.undefined;
    });
  });

  describe("getUpcomingRefunds", function () {
    it("Must be initialized before use", async function () {
      expect(() => bundleDataClient.getUpcomingRefunds(MAINNET, l1Weth)).to.throw(/not initialized/);
    });

    it("Default returns bnZero", async function () {
      bundleDataClient.initialize();
      const upcomingRefunds = bundleDataClient.getUpcomingRefunds(MAINNET, l1Weth);
      expect(upcomingRefunds).to.equal(bnZero);
    });

    it("Returns the upcoming refunds for a given L1 token", async function () {
      // Send two fills that should be counted:
      const fill1 = await generateFill("WETH", MAINNET, MAINNET, owner.address);
      const fill2 = await generateFill("WETH", MAINNET, OPTIMISM, owner.address);
      const fill3 = await generateFill("USDC", MAINNET, MAINNET, owner.address, toBNWei(1, 6));
      // Send a fill for a different relayer:
      const fill4 = await generateFill("WETH", MAINNET, MAINNET, randomAddress());
      bundleDataClient.initialize();
      expect(bundleDataClient.getUpcomingRefunds(MAINNET, l1Weth, relayer)).to.equal(fill1.args.inputAmount);
      expect(bundleDataClient.getUpcomingRefunds(MAINNET, l1Weth)).to.equal(
        fill1.args.inputAmount.add(fill4.args.inputAmount)
      );
      expect(bundleDataClient.getUpcomingRefunds(OPTIMISM, l1Weth)).to.equal(fill2.args.inputAmount);
      expect(bundleDataClient.getUpcomingRefunds(MAINNET, l1Usdc)).to.equal(fill3.args.inputAmount);
      expect(bundleDataClient.getUpcomingRefunds(BSC, l1Weth)).to.equal(bnZero);
      expect(bundleDataClient.getUpcomingRefunds(MAINNET, l1Weth, toAddressType(randomAddress(), MAINNET))).to.equal(
        bnZero
      );
      expect(bundleDataClient.getUpcomingRefunds(OPTIMISM, l1Usdc)).to.equal(bnZero);
    });
  });

  describe("getUpcomingDeposits", function () {
    it("Must be initialized before use", async function () {
      expect(() => bundleDataClient.getUpcomingDeposits(MAINNET, l1Weth)).to.throw(/not initialized/);
    });
    it("Returns the upcoming deposits for a given L1 token", async function () {
      const deposit1 = await generateDeposit("WETH", MAINNET);
      const deposit2 = await generateDeposit("USDC", MAINNET);
      const deposit3 = await generateDeposit("WETH", OPTIMISM);
      bundleDataClient.initialize();
      expect(bundleDataClient.getUpcomingDeposits(MAINNET, l1Weth)).to.equal(deposit1.args.inputAmount);
      expect(bundleDataClient.getUpcomingDeposits(OPTIMISM, l1Weth)).to.equal(deposit3.args.inputAmount);
      expect(bundleDataClient.getUpcomingDeposits(MAINNET, l1Usdc)).to.equal(deposit2.args.inputAmount);
      expect(bundleDataClient.getUpcomingDeposits(OPTIMISM, l1Usdc)).to.equal(bnZero);
      expect(bundleDataClient.getUpcomingRefunds(BSC, l1Weth)).to.equal(bnZero);
    });
  });

  describe("Aggregates balances across multiple inventory contributor tokens", function () {
    // Test that when two different L2 tokens on the same chain both map to the same L1 token
    // (e.g. USDC.e and native USDC both mapping to L1 USDC on Optimism), getUpcomingRefunds and
    // getUpcomingDeposits correctly aggregate balances from both contributor tokens.
    const nativeUsdcOnOptimism = TOKEN_SYMBOLS_MAP.USDC.addresses[OPTIMISM];

    beforeEach(function () {
      // Update the token mapping so both USDC.e and native USDC on Optimism map to L1 USDC.
      (bundleDataClient as MockBundleDataApproxClient).setTokenMapping({
        [mainnetWeth]: {
          [MAINNET]: mainnetWeth,
          [OPTIMISM]: l2TokensForWeth[OPTIMISM],
          [BSC]: l2TokensForWeth[BSC],
        },
        [mainnetUsdc]: {
          [MAINNET]: mainnetUsdc,
          [OPTIMISM]: [l2TokensForUsdc[OPTIMISM], nativeUsdcOnOptimism],
          [BSC]: l2TokensForUsdc[BSC],
        },
      });
    });

    it("getUpcomingRefunds aggregates fills from both contributor tokens", async function () {
      const fillAmount1 = toBNWei(100, 6);
      const fillAmount2 = toBNWei(50, 6);

      // Fill with the primary USDC.e token on Optimism, repaid on Optimism.
      await generateFill("USDC", OPTIMISM, OPTIMISM, owner.address, fillAmount1);

      // Fill with the second contributor token on Optimism, repaid on Optimism.
      // Use the raw MockSpokePoolClient.fillRelay to specify a custom inputToken.
      const spokePoolClient = spokePoolClients[OPTIMISM];
      (spokePoolClient as unknown as MockSpokePoolClient).fillRelay({
        message: "0x",
        messageHash: ZERO_BYTES,
        inputToken: toAddressType(nativeUsdcOnOptimism, OPTIMISM),
        outputToken: toAddressType(l2TokensForUsdc[OPTIMISM], OPTIMISM),
        destinationChainId: OPTIMISM,
        depositor: toAddressType(owner.address, OPTIMISM),
        recipient: toAddressType(owner.address, OPTIMISM),
        exclusivityDeadline: getCurrentTime() + 14400,
        depositId: bnZero,
        exclusiveRelayer: toAddressType(owner.address, OPTIMISM),
        inputAmount: fillAmount2,
        outputAmount: fillAmount2,
        fillDeadline: getCurrentTime() + 14400,
        blockNumber: spokePoolClient.latestHeightSearched,
        txnIndex: 0,
        logIndex: 1,
        txnRef: "0x",
        relayer: toAddressType(owner.address, MAINNET),
        originChainId: OPTIMISM,
        repaymentChainId: OPTIMISM,
        relayExecutionInfo: {
          updatedRecipient: toAddressType(owner.address, OPTIMISM),
          updatedMessage: "0x",
          updatedMessageHash: ZERO_BYTES,
          updatedOutputAmount: fillAmount2,
          fillType: interfaces.FillType.FastFill,
        },
      } as interfaces.FillWithBlock);
      await spokePoolClient.update(["FilledRelay"]);

      bundleDataClient.initialize();

      // Refunds should aggregate both fills.
      const totalRefunds = bundleDataClient.getUpcomingRefunds(OPTIMISM, l1Usdc);
      expect(totalRefunds).to.equal(fillAmount1.add(fillAmount2));
    });

    it("getUpcomingDeposits aggregates deposits from both contributor tokens", async function () {
      const depositAmount1 = toBNWei(200, 6);
      const depositAmount2 = toBNWei(75, 6);

      // Deposit with the primary USDC.e token on Optimism.
      await generateDeposit("USDC", OPTIMISM, depositAmount1);

      // Deposit with the second contributor token on Optimism.
      const spokePoolClient = spokePoolClients[OPTIMISM];
      (spokePoolClient as unknown as MockSpokePoolClient).deposit({
        inputToken: toAddressType(nativeUsdcOnOptimism, OPTIMISM),
        inputAmount: depositAmount2,
        depositor: toAddressType(owner.address, OPTIMISM),
        recipient: toAddressType(owner.address, OPTIMISM),
        outputToken: toAddressType(randomAddress(), OPTIMISM),
        outputAmount: depositAmount2,
        quoteTimestamp: getCurrentTime(),
        fillDeadline: getCurrentTime() + 14400,
        exclusivityDeadline: getCurrentTime() + 14400,
        exclusiveRelayer: toAddressType(owner.address, OPTIMISM),
        originChainId: OPTIMISM,
        blockNumber: spokePoolClient.latestHeightSearched,
        txnIndex: 0,
        logIndex: 1,
      } as interfaces.DepositWithBlock);
      await spokePoolClient.update(["FundsDeposited"]);

      bundleDataClient.initialize();

      // Deposits should aggregate both deposit amounts.
      const totalDeposits = bundleDataClient.getUpcomingDeposits(OPTIMISM, l1Usdc);
      expect(totalDeposits).to.equal(depositAmount1.add(depositAmount2));
    });
  });

  describe("Cross-chain refund counting with relay delay", function () {
    // Regression test for a bug where fills on chain X with repaymentChainId = chain Y were incorrectly
    // excluded from upcoming refunds when chain X had processed a bundle but chain Y had not yet received
    // the relay (due to cross-chain propagation delay). For example, 16 fills of 100K USDT each on Ethereum
    // with repayment on BSC were dropped (~1.6M USDT) because Ethereum's bundle execution advanced
    // fromBlocks[MAINNET] past those fills, even though BSC hadn't received the refund leaf yet.
    it("Counts fills toward repayment chain when fill chain has executed the bundle but repayment chain has not", async function () {
      configStoreClient.setAvailableChains([MAINNET, OPTIMISM, BSC]);

      // Recreate bundleDataClient so protocolChainIdIndices picks up the new chain list.
      bundleDataClient = new MockBundleDataApproxClient(
        spokePoolClients,
        hubPoolClient,
        enabledChainIds,
        [toAddressType(mainnetWeth, MAINNET)],
        spyLogger
      );
      (bundleDataClient as MockBundleDataApproxClient).setTokenMapping({
        [mainnetWeth]: {
          [MAINNET]: mainnetWeth,
          [OPTIMISM]: l2TokensForWeth[OPTIMISM],
          [BSC]: l2TokensForWeth[BSC],
        },
      });

      // Set up Bundle A with known end blocks for each chain.
      const bundleEndBlocks = [toBN(1000), toBN(2000), toBN(3000)];
      const rootBundleRelays = [
        {
          rootBundleId: 0,
          relayerRefundRoot: "0xabc",
          bundleEvaluationBlockNumbers: bundleEndBlocks,
        },
      ];
      hubPoolClient.setValidatedRootBundles(rootBundleRelays as unknown as ProposedRootBundle[]);

      // Bundle A is relayed and executed on MAINNET (simulates same-chain instant execution).
      (spokePoolClients[MAINNET] as unknown as MockSpokePoolClient).setRootBundleRelays(
        rootBundleRelays as unknown as RootBundleRelayWithBlock[]
      );
      (spokePoolClients[MAINNET] as unknown as MockSpokePoolClient).addRelayerRefundExecution({
        rootBundleId: 0,
        leafId: 0,
        chainId: MAINNET,
        amountToReturn: bnZero,
        l2TokenAddress: toAddressType(mainnetWeth, MAINNET),
        refundAddresses: [],
        refundAmounts: [],
        blockNumber: 0,
        txnIndex: 0,
        logIndex: 0,
        txnRef: "0x",
      });

      // Bundle A is NOT relayed to BSC — simulates the ~17 minute cross-chain relay delay.
      // (no setRootBundleRelays on BSC spoke pool client)

      // Create a fill on MAINNET at block 500 (within Bundle A's MAINNET range) with repayment on BSC.
      // This simulates a fill like the 100K USDT deposits from BSC→Ethereum with BSC repayment.
      const fillAmount = toWei(1);
      const mainnetSpokePoolClient = spokePoolClients[MAINNET] as unknown as MockSpokePoolClient;
      mainnetSpokePoolClient.fillRelay({
        message: "0x",
        messageHash: ZERO_BYTES,
        inputToken: toAddressType(l2TokensForWeth[BSC], BSC),
        outputToken: toAddressType(mainnetWeth, MAINNET),
        destinationChainId: MAINNET,
        depositor: toAddressType(owner.address, BSC),
        recipient: toAddressType(owner.address, MAINNET),
        exclusivityDeadline: getCurrentTime() + 14400,
        depositId: bnZero,
        exclusiveRelayer: toAddressType(owner.address, BSC),
        inputAmount: fillAmount,
        outputAmount: fillAmount,
        fillDeadline: getCurrentTime() + 14400,
        blockNumber: 500, // Within Bundle A's MAINNET end block of 1000
        txnIndex: 0,
        logIndex: 0,
        txnRef: "0x",
        relayer: toAddressType(owner.address, MAINNET),
        originChainId: BSC,
        repaymentChainId: BSC, // Relayer chose BSC for repayment
        relayExecutionInfo: {
          updatedRecipient: toAddressType(owner.address, MAINNET),
          updatedMessage: "0x",
          updatedMessageHash: ZERO_BYTES,
          updatedOutputAmount: fillAmount,
          fillType: interfaces.FillType.FastFill,
        },
      } as interfaces.FillWithBlock);
      await spokePoolClients[MAINNET].update(["FilledRelay"]);

      bundleDataClient.initialize();

      // The fill's refund on BSC should be counted as upcoming because BSC hasn't executed Bundle A yet.
      // Before this fix, fromBlocks[MAINNET] (= 1001) would have been used to filter the fill at block 500,
      // incorrectly excluding it. Now fromBlocks[BSC][MAINNET] (= 0, since BSC has no executed bundle) is
      // used, so the fill is correctly included.
      expect(bundleDataClient.getUpcomingRefunds(BSC, toAddressType(mainnetWeth, MAINNET))).to.equal(fillAmount);
    });
  });

  describe("getUnexecutedBundleStartBlocks", function () {
    it("Returns endBlocks+1 from last relayed bundle for chain", async function () {
      configStoreClient.setAvailableChains([MAINNET, OPTIMISM, BSC]);

      // When there are no RootBundleRelay/ProposedRootBundle events, returns 0 for all chains.
      const defaultFromBlocks = (bundleDataClient as MockBundleDataApproxClient).getUnexecutedBundleStartBlocks(
        l1Weth,
        true
      );
      expect(defaultFromBlocks[MAINNET][MAINNET]).to.equal(0);
      expect(defaultFromBlocks[OPTIMISM][OPTIMISM]).to.equal(0);
      expect(defaultFromBlocks[BSC][BSC]).to.equal(0);

      const rootBundleRelays = [
        {
          rootBundleId: 0,
          relayerRefundRoot: "0x1234",
          bundleEvaluationBlockNumbers: [toBN(3), toBN(4), toBN(5)],
        },
      ];
      (spokePoolClients[MAINNET] as unknown as MockSpokePoolClient).setRootBundleRelays(
        rootBundleRelays as unknown as RootBundleRelayWithBlock[]
      );
      hubPoolClient.setValidatedRootBundles(rootBundleRelays as unknown as ProposedRootBundle[]);

      // Add a matching execution so getUnexecutedBundleStartBlocks can verify the leaf was executed.
      // Directly push to the internal array to avoid event parsing issues in the mock.
      (spokePoolClients[MAINNET] as unknown as MockSpokePoolClient).addRelayerRefundExecution({
        rootBundleId: 0,
        leafId: 0,
        chainId: MAINNET,
        amountToReturn: bnZero,
        l2TokenAddress: toAddressType(mainnetWeth, MAINNET),
        refundAddresses: [],
        refundAmounts: [],
        blockNumber: 0,
        txnIndex: 0,
        logIndex: 0,
        txnRef: "0x",
      });

      const fromBlocks1 = (bundleDataClient as MockBundleDataApproxClient).getUnexecutedBundleStartBlocks(l1Weth, true);

      // Only the spoke pool clients that saw the RootBundleRelay events should have non-zero fromBlocks.
      // The MAINNET entry returns end blocks for all chains from the matched bundle.
      expect(fromBlocks1[MAINNET][MAINNET]).to.equal(4); // bundleEvaluationBlockNumbers[0] + 1
      // Chains without relays still return 0 for all fill chains.
      expect(fromBlocks1[OPTIMISM][OPTIMISM]).to.equal(0);
      expect(fromBlocks1[BSC][BSC]).to.equal(0);
    });
  });
});
