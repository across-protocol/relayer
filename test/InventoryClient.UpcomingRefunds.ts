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

import { InventoryClient, SpokePoolClient } from "../src/clients"; // Tested
import { CrossChainTransferClient } from "../src/clients/bridges";
import { CHAIN_IDs, bnZero, TOKEN_SYMBOLS_MAP, toAddressType, getCurrentTime, ZERO_BYTES, toBN } from "../src/utils";
import {
  MockAdapterManager,
  MockConfigStoreClient,
  MockHubPoolClient,
  MockInventoryClient,
  MockSpokePoolClient,
  MockTokenClient,
} from "./mocks";
import { interfaces } from "@across-protocol/sdk";
import { originChainId } from "./constants";
import { ProposedRootBundle, RootBundleRelayWithBlock } from "../src/interfaces";

describe("InventoryClient: Accounting for upcoming relayer refunds", async function () {
  const { MAINNET, OPTIMISM, BSC } = CHAIN_IDs;
  const enabledChainIds = [MAINNET, OPTIMISM, BSC];
  const mainnetWeth = TOKEN_SYMBOLS_MAP.WETH.addresses[MAINNET];
  const mainnetUsdc = TOKEN_SYMBOLS_MAP.USDC.addresses[MAINNET];

  let hubPoolClient: MockHubPoolClient, adapterManager: MockAdapterManager, tokenClient: MockTokenClient;
  let owner: SignerWithAddress, spyLogger: winston.Logger;
  let inventoryClient: InventoryClient; // tested
  let crossChainTransferClient: CrossChainTransferClient;
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

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spyLogger } = createSpyLogger());

    const { hubPool, dai: l1Token } = await hubPoolFixture();
    const { configStore } = await deployConfigStore(owner, [l1Token]);
    const { spokePool, deploymentBlock } = await deploySpokePoolWithToken(originChainId);

    configStoreClient = new MockConfigStoreClient(spyLogger, configStore);
    await configStoreClient.update();

    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);
    hubPoolClient.setDefaultRealizedLpFeePct(bnZero);
    await hubPoolClient.update();

    const spokePoolClient_MAINNET = new MockSpokePoolClient(
      spyLogger,
      spokePool.connect(owner),
      originChainId,
      deploymentBlock
    );
    const spokePoolClient_OPTIMISM = new MockSpokePoolClient(
      spyLogger,
      spokePool.connect(owner),
      originChainId,
      deploymentBlock
    );
    const spokePoolClient_BSC = new MockSpokePoolClient(
      spyLogger,
      spokePool.connect(owner),
      originChainId,
      deploymentBlock
    );

    adapterManager = new MockAdapterManager(null, null, null, null);
    spokePoolClients = {
      [MAINNET]: spokePoolClient_MAINNET,
      [OPTIMISM]: spokePoolClient_OPTIMISM,
      [BSC]: spokePoolClient_BSC,
    };
    tokenClient = new MockTokenClient(null, null, null, spokePoolClients);
    crossChainTransferClient = new CrossChainTransferClient(spyLogger, enabledChainIds, adapterManager);
    inventoryClient = new MockInventoryClient(
      toAddressType(owner.address, MAINNET),
      spyLogger,
      {},
      tokenClient,
      enabledChainIds,
      hubPoolClient,
      adapterManager,
      crossChainTransferClient
    );
    (inventoryClient as MockInventoryClient).setTokenMapping({
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
      outputToken: toAddressType(randomAddress(), destinationChainId),
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

  describe("getApproximateRefundsForToken", function () {
    it("Accumulates fills sent after the fromBlocks", async function () {
      // Ignores fills that:
      // - are not sent by the relayer
      // - are not sent after the fromBlocks
      // - are not mapped to the passed in L1 token

      // Returns object of refunds grouped by repayment chain:
      const fromBlocks = {
        [MAINNET]: 1,
        [OPTIMISM]: 1,
        [BSC]: 1,
      };
      // Send two fills that should be counted:
      const fill1 = await generateFill("WETH", MAINNET, MAINNET, owner.address);
      const fill2 = await generateFill("WETH", MAINNET, OPTIMISM, owner.address);
      const fill3 = await generateFill("USDC", MAINNET, MAINNET, owner.address, toBNWei(1, 6));
      // Send a fill for a different relayer:
      await generateFill("WETH", MAINNET, MAINNET, randomAddress());
      const wethRefunds = (inventoryClient as unknown as MockInventoryClient).getApproximateRefundsForToken(
        toAddressType(mainnetWeth, MAINNET),
        fromBlocks
      );
      expect(wethRefunds[MAINNET]).to.equal(fill1.args.inputAmount);
      expect(wethRefunds[OPTIMISM]).to.equal(fill2.args.inputAmount);
      expect(wethRefunds[BSC]).to.equal(bnZero);

      // Check fills for other L1 token:
      const usdcRefunds = (inventoryClient as unknown as MockInventoryClient).getApproximateRefundsForToken(
        toAddressType(mainnetUsdc, MAINNET),
        fromBlocks
      );
      expect(usdcRefunds[MAINNET]).to.equal(fill3.args.inputAmount);
      expect(usdcRefunds[OPTIMISM]).to.equal(bnZero);
      expect(usdcRefunds[BSC]).to.equal(bnZero);

      // Ignores fills if block number is less than fromBlocks:
      const highFromBlocks = {
        [MAINNET]: 1000000000000000000,
        [OPTIMISM]: 1000000000000000000,
        [BSC]: 1000000000000000000,
      };
      const wethRefunds3 = (inventoryClient as unknown as MockInventoryClient).getApproximateRefundsForToken(
        toAddressType(mainnetWeth, MAINNET),
        highFromBlocks
      );
      expect(wethRefunds3[MAINNET]).to.equal(bnZero);
      expect(wethRefunds3[OPTIMISM]).to.equal(bnZero);
      expect(wethRefunds3[BSC]).to.equal(bnZero);
    });
  });

  describe("getUpcomingRefundsQueryFromBlocks", function () {
    it("Returns endBlocks+1 from last relayed bundle for chain", async function () {
      configStoreClient.setAvailableChains([MAINNET, OPTIMISM, BSC]);

      // When there are no RootBundleRelay/ProposedRootBundle events, returns 0 for all chains.
      const defaultFromBlocks = (inventoryClient as unknown as MockInventoryClient).getUpcomingRefundsQueryFromBlocks();
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

      const fromBlocks1 = (inventoryClient as unknown as MockInventoryClient).getUpcomingRefundsQueryFromBlocks();

      // Only the spoke pool clients that saw the RootBundleRelay events should have non-zero fromBlocks.
      expect(fromBlocks1[MAINNET]).to.equal(4);
      expect(fromBlocks1[OPTIMISM]).to.equal(0);
      expect(fromBlocks1[BSC]).to.equal(0);
    });
  });
});
