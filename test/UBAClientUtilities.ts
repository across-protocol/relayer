import {
  Contract,
  createRandomBytes32,
  createSpyLogger,
  deepEqualsWithBigNumber,
  deployConfigStore,
  deploySpokePool,
  ethers,
  hubPoolFixture,
} from "./utils";
import { expect, randomAddress, toBN, toBNWei } from "./constants";
import { SpokePoolClientsByChain } from "../src/interfaces";
import { clients } from "@across-protocol/sdk-v2";
import { MockConfigStoreClient, MockHubPoolClient } from "./mocks";
import { CHAIN_ID_LIST_INDICES, UBA_MIN_CONFIG_STORE_VERSION } from "../src/common";
import { SpokePoolClient } from "../src/clients";
const { getMostRecentBundleBlockRanges, getOpeningBalances } = clients;

let hubPoolClient: MockHubPoolClient;
let hubPool: Contract;
let spokePoolClients: SpokePoolClientsByChain;

const logger = createSpyLogger().spyLogger;

const chainIds = CHAIN_ID_LIST_INDICES;

const tokenAddresses = chainIds.map(() => randomAddress());

describe("UBAClientUtilities", function () {
  beforeEach(async function () {
    const [owner] = await ethers.getSigners();
    const { configStore } = await deployConfigStore(owner, []);
    const configStoreClient = new MockConfigStoreClient(
      logger,
      configStore,
      { fromBlock: 0 },
      UBA_MIN_CONFIG_STORE_VERSION,
      chainIds
    );
    configStoreClient.setConfigStoreVersion(UBA_MIN_CONFIG_STORE_VERSION);
    // await configStore.updateGlobalConfig(utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.VERSION), UBA_MIN_CONFIG_STORE_VERSION.toString());
    await configStoreClient.update();
    ({ hubPool } = await hubPoolFixture());
    const latestBlockNumber = await hubPool.provider.getBlockNumber();
    hubPoolClient = new MockHubPoolClient(logger, hubPool, configStoreClient);
    await hubPoolClient.update();
    hubPoolClient.setLatestBlockNumber(latestBlockNumber);

    spokePoolClients = {};
    for (const originChainId of chainIds) {
      const { spokePool } = await deploySpokePool(ethers);
      const deploymentBlock = await spokePool.provider.getBlockNumber();

      // Construct generic spoke pool clients with large event search configs. This should never trigger
      // `blockRangesAreInvalidForSpokeClients` to be true.
      const spokePoolClient = new SpokePoolClient(logger, spokePool, hubPoolClient, originChainId, deploymentBlock);
      spokePoolClients[originChainId] = spokePoolClient;
      await spokePoolClient.update();
    }
  });
  // Propose and validate `numberOfBundles` bundles, each with random size block ranges. The block range size
  // can be hardcoded by providing a `randomJumpOverride` parameter.
  async function publishValidatedBundles(
    numberOfBundles: number,
    randomJumpOverride?: number,
    startingRunningBalance = ethers.constants.Zero,
    startingIncentiveBalance = ethers.constants.Zero
  ): Promise<Record<number, { start: number; end: number; proposalBlock: number }[]>> {
    // Create a sets of unique block ranges per chain so that we have a lower chance of false positives
    // when fetching the block ranges for a specific chain.
    const expectedBlockRanges: Record<number, { start: number; end: number; proposalBlock: number }[]> = {}; // Save expected ranges here
    let nextBlockRangesForChain = Object.fromEntries(
      CHAIN_ID_LIST_INDICES.map((chainId) => {
        const randomJump = randomJumpOverride ?? Math.floor(Math.random() * 3);
        const _blockRange = [chainId, { start: 0, end: randomJump }];
        return _blockRange;
      })
    );
    for (let i = 0; i < numberOfBundles; i++) {
      const bundleEvaluationBlockNumbers = CHAIN_ID_LIST_INDICES.map((chainId) => {
        if (!expectedBlockRanges[chainId]) {
          expectedBlockRanges[chainId] = [];
        }
        return toBN(nextBlockRangesForChain[chainId].end);
      });

      const rootBundleProposal = hubPoolClient.proposeRootBundle(
        Date.now(), // challengePeriodEndTimestamp
        CHAIN_ID_LIST_INDICES.length, // poolRebalanceLeafCount
        bundleEvaluationBlockNumbers,
        createRandomBytes32() // Random pool rebalance root we can check.
      );
      hubPoolClient.addEvent(rootBundleProposal);
      await hubPoolClient.update();
      const proposedRootBundle =
        hubPoolClient.getProposedRootBundles()[hubPoolClient.getProposedRootBundles().length - 1];
      CHAIN_ID_LIST_INDICES.forEach((chainId) => {
        expectedBlockRanges[chainId].push({
          ...nextBlockRangesForChain[chainId],
          proposalBlock: proposedRootBundle.blockNumber,
        });
      });
      chainIds.forEach((chainId, leafIndex) => {
        const leafEvent = hubPoolClient.executeRootBundle(
          toBN(0),
          leafIndex,
          toBN(chainId),
          [tokenAddresses[leafIndex]], // l1Tokens
          [], // bundleLpFees
          [], // netSendAmounts
          [startingRunningBalance, startingIncentiveBalance] // runningBalances
        );
        hubPoolClient.addEvent(leafEvent);
      });

      await hubPoolClient.update();

      // Make next block range span a random number of blocks:
      const nextBlockRangeSize = Math.ceil(Math.random() * 10);
      nextBlockRangesForChain = Object.fromEntries(
        CHAIN_ID_LIST_INDICES.map((chainId) => [
          chainId,
          {
            start: nextBlockRangesForChain[chainId].end + 1,
            end: nextBlockRangesForChain[chainId].end + nextBlockRangeSize,
          },
        ])
      );
    }
    await Promise.all(chainIds.map((chainId) => spokePoolClients[Number(chainId)].update()));
    return expectedBlockRanges;
  }
  describe("getMostRecentBundleBlockRanges", function () {
    it("Request maxBundleState 0", async function () {
      const result = getMostRecentBundleBlockRanges(
        chainIds[0],
        0,
        Number(hubPoolClient.latestBlockNumber),
        hubPoolClient,
        spokePoolClients
      );
      deepEqualsWithBigNumber(result, []);
    });
    it("No bundles", async function () {
      // Returns 1 default bundle, even though we requested more than 1, spanning deployment block to latest.
      const result = getMostRecentBundleBlockRanges(
        chainIds[0],
        3,
        Number(hubPoolClient.latestBlockNumber),
        hubPoolClient,
        spokePoolClients
      );
      const spokePoolClient = spokePoolClients[chainIds[0]];
      deepEqualsWithBigNumber(result, [
        {
          proposalBlock: hubPoolClient.latestBlockNumber,
          start: spokePoolClient.deploymentBlock,
          end: spokePoolClient.latestBlockNumber,
        },
      ]);
    });
    it("Correctly returns n most recent validated bundles", async function () {
      // Generate 3 valid bundles.
      const expectedBlockRanges = await publishValidatedBundles(3);
      for (const chainId of CHAIN_ID_LIST_INDICES) {
        // Get 2 most recent bundles.
        const result = getMostRecentBundleBlockRanges(
          chainId,
          2,
          Number(hubPoolClient.latestBlockNumber),
          hubPoolClient,
          spokePoolClients
        );
        // Should only return 2 most recent bundles.
        expect(result.length).to.equal(2);
        deepEqualsWithBigNumber(result, expectedBlockRanges[chainId].slice(1));
      }
    });
    it("Returns only bundles before `mostRecentHubPoolBlockNumber`", async function () {
      const expectedBlockRanges = await publishValidatedBundles(3);
      // Returns only bundles before `mostRecentHubPoolBlockNumber`
      const latestExecutedRootBundle = hubPoolClient.getLatestFullyExecutedRootBundle(
        Number(hubPoolClient.latestBlockNumber)
      );
      if (!latestExecutedRootBundle || latestExecutedRootBundle.blockNumber === 0) {
        throw new Error("No latest executed root bundle");
      }
      const result = getMostRecentBundleBlockRanges(
        chainIds[0],
        1,
        latestExecutedRootBundle?.blockNumber,
        hubPoolClient,
        spokePoolClients
      );
      // Should return the second most recent bundle for chain.
      deepEqualsWithBigNumber(result, [expectedBlockRanges[chainIds[0]][expectedBlockRanges[chainIds[0]].length - 2]]);
    });
    it("Throws if spoke pool clients don't have event search ranges to validate any of the bundles", async function () {
      // Create block ranges that end at block heights much larger than last spoke pool client blocks searched.
      await publishValidatedBundles(3, 10_000_000);
      expect(() =>
        getMostRecentBundleBlockRanges(
          chainIds[0],
          1,
          Number(hubPoolClient.latestBlockNumber),
          hubPoolClient,
          spokePoolClients
        )
      ).to.throw(/Spoke pool clients do not have the block ranges necessary/);
    });
  });
  describe("getOpeningBalances", function () {
    it("No bundles", async function () {
      const result = getOpeningBalances(
        hubPoolClient,
        chainIds[0],
        tokenAddresses[0],
        Number(hubPoolClient.latestBlockNumber)
      );
      deepEqualsWithBigNumber(result, {
        runningBalance: ethers.constants.Zero,
        incentiveBalance: ethers.constants.Zero,
      });
    });
    it("One bundles", async function () {
      // Getting opening balances before latest block returns first bundle running balances
      await publishValidatedBundles(1, undefined, toBNWei("11"), toBNWei("22"));
      const result1 = getOpeningBalances(
        hubPoolClient,
        chainIds[0],
        tokenAddresses[0],
        Number(hubPoolClient.latestBlockNumber)
      );
      deepEqualsWithBigNumber(result1, {
        runningBalance: toBNWei("11"),
        incentiveBalance: toBNWei("22"),
      });

      // Execute another bundle. Getting opening balances before latest block now returns second
      // bundle running balances
      const bundle2 = await publishValidatedBundles(1, undefined, toBNWei("33"), toBNWei("44"));
      const result2 = getOpeningBalances(
        hubPoolClient,
        chainIds[0],
        tokenAddresses[0],
        Number(hubPoolClient.latestBlockNumber)
      );
      deepEqualsWithBigNumber(result2, {
        runningBalance: toBNWei("33"),
        incentiveBalance: toBNWei("44"),
      });

      // Now try getting the opening balances as of the second bundle's proposal block. This should return
      // the first bundle's balances.
      const result3 = getOpeningBalances(
        hubPoolClient,
        chainIds[0],
        tokenAddresses[0],
        bundle2[chainIds[0]][0].proposalBlock
      );
      deepEqualsWithBigNumber(result3, {
        runningBalance: toBNWei("11"),
        incentiveBalance: toBNWei("22"),
      });
    });
  });
});
