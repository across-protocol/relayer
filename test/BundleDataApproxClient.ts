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
    const { spokePool: spokePool_MAINNET, deploymentBlock: deploymentBlock_MAINNET } = await deploySpokePoolWithToken(
      MAINNET
    );
    const { spokePool: spokePool_OPTIMISM, deploymentBlock: deploymentBlock_OPTIMISM } = await deploySpokePoolWithToken(
      OPTIMISM
    );
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
    it("Accumulates fills sent after the fromBlocks", async function () {
      // Returns object of refunds grouped by repayment chain:
      const fromBlocks = {
        [MAINNET]: 1,
        [OPTIMISM]: 1,
        [BSC]: 1,
        [POLYGON]: 1, // Add a chain we don't have a spoke pool client for to make sure no errors are thrown.
      };
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
      const highFromBlocks = {
        [MAINNET]: 1000000000000000000,
        [OPTIMISM]: 1000000000000000000,
        [BSC]: 1000000000000000000,
      };
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

  describe("getUnexecutedBundleStartBlocks", function () {
    it("Returns endBlocks+1 from last relayed bundle for chain", async function () {
      configStoreClient.setAvailableChains([MAINNET, OPTIMISM, BSC]);

      // When there are no RootBundleRelay/ProposedRootBundle events, returns 0 for all chains.
      const defaultFromBlocks = bundleDataClient.getUnexecutedBundleStartBlocks();
      expect(defaultFromBlocks[MAINNET]).to.equal(0);
      expect(defaultFromBlocks[OPTIMISM]).to.equal(0);
      expect(defaultFromBlocks[BSC]).to.equal(0);

      const rootBundleRelays = [
        {
          relayerRefundRoot: "0x1234",
          bundleEvaluationBlockNumbers: [toBN(3), toBN(4), toBN(5)],
        },
      ];
      (spokePoolClients[MAINNET] as unknown as MockSpokePoolClient).setRootBundleRelays(
        rootBundleRelays as unknown as RootBundleRelayWithBlock[]
      );
      hubPoolClient.setValidatedRootBundles(rootBundleRelays as unknown as ProposedRootBundle[]);

      const fromBlocks1 = bundleDataClient.getUnexecutedBundleStartBlocks();

      // Only the spoke pool clients that saw the RootBundleRelay events should have non-zero fromBlocks.
      expect(fromBlocks1[MAINNET]).to.equal(4);
      expect(fromBlocks1[OPTIMISM]).to.equal(0);
      expect(fromBlocks1[BSC]).to.equal(0);
    });
  });
});
