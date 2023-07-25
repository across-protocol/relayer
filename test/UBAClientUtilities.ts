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
import { CHAIN_ID_TEST_LIST, expect, randomAddress, toBN, toBNWei } from "./constants";
import { SpokePoolClientsByChain } from "../src/interfaces";
import { clients } from "@across-protocol/sdk-v2";
import { MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient } from "./mocks";
import { UBA_MIN_CONFIG_STORE_VERSION } from "../src/common";
const { getMostRecentBundleBlockRanges, getUbaActivationBundleStartBlocks, getOpeningRunningBalanceForEvent } = clients;

let hubPoolClient: MockHubPoolClient;
let hubPool: Contract;
let spokePoolClients: SpokePoolClientsByChain;
let configStoreClient: MockConfigStoreClient;

const logger = createSpyLogger().spyLogger;

const chainIds = CHAIN_ID_TEST_LIST;
const l1Tokens = [randomAddress(), randomAddress()];
const runningBalances = [toBNWei("10"), toBNWei("20")];
const incentiveBalances = [toBNWei("1"), toBNWei("2")];

describe("UBAClientUtilities", function () {
  beforeEach(async function () {
    const [owner] = await ethers.getSigners();
    const { configStore } = await deployConfigStore(owner, []);
    configStoreClient = new MockConfigStoreClient(
      logger,
      configStore,
      { fromBlock: 0 },
      UBA_MIN_CONFIG_STORE_VERSION,
      chainIds
    );
    configStoreClient.setConfigStoreVersion(UBA_MIN_CONFIG_STORE_VERSION);
    configStoreClient.setUBAActivationBlock(0);
    await configStoreClient.update();

    ({ hubPool } = await hubPoolFixture());
    hubPoolClient = new MockHubPoolClient(logger, hubPool, configStoreClient);
    await hubPoolClient.update();
    const latestBlockNumber = await hubPool.provider.getBlockNumber();
    hubPoolClient.setLatestBlockNumber(latestBlockNumber);

    spokePoolClients = {};
    for (const originChainId of chainIds) {
      const { spokePool } = await deploySpokePool(ethers);
      const deploymentBlock = await spokePool.provider.getBlockNumber();

      // Construct generic spoke pool clients with large event search configs. This should never trigger
      // `blockRangesAreInvalidForSpokeClients` to be true.
      const spokePoolClient = new MockSpokePoolClient(logger, spokePool, originChainId, deploymentBlock);
      spokePoolClients[originChainId] = spokePoolClient;
      hubPoolClient.setCrossChainContracts(originChainId, spokePool.address, deploymentBlock);
      spokePoolClient.setLatestBlockSearched(deploymentBlock + 1000);
    }
  });

  // Propose and validate `numberOfBundles` bundles, each with random size block ranges. The block range size
  // can be hardcoded by providing a `randomJumpOverride` parameter.
  async function publishValidatedBundles(
    numberOfBundles: number,
    randomJumpOverride?: number
  ): Promise<Record<number, { start: number; end: number }[]>> {
    // Create a sets of unique block ranges per chain so that we have a lower chance of false positives
    // when fetching the block ranges for a specific chain.
    const expectedBlockRanges: Record<number, { start: number; end: number }[]> = {}; // Save expected ranges here
    let nextBlockRangesForChain = Object.fromEntries(
      chainIds.map((chainId) => {
        const randomJump = randomJumpOverride ?? Math.floor(Math.random() * 3);
        const _blockRange = [chainId, { start: 0, end: randomJump }];
        return _blockRange;
      })
    );
    for (let i = 0; i < numberOfBundles; i++) {
      const bundleEvaluationBlockNumbers = chainIds.map((chainId) => {
        if (!expectedBlockRanges[chainId]) {
          expectedBlockRanges[chainId] = [];
        }
        return toBN(nextBlockRangesForChain[chainId].end);
      });

      const rootBundleProposal = hubPoolClient.proposeRootBundle(
        Date.now(), // challengePeriodEndTimestamp
        chainIds.length, // poolRebalanceLeafCount
        bundleEvaluationBlockNumbers,
        createRandomBytes32() // Random pool rebalance root we can check.
      );
      hubPoolClient.addEvent(rootBundleProposal);
      await hubPoolClient.update();
      chainIds.forEach((chainId) => {
        expectedBlockRanges[chainId].push({
          ...nextBlockRangesForChain[chainId],
        });
      });
      chainIds.forEach((chainId, leafIndex) => {
        const leafEvent = hubPoolClient.executeRootBundle(
          toBN(0),
          leafIndex,
          toBN(chainId),
          l1Tokens, // l1Tokens
          runningBalances, // bundleLpFees
          runningBalances, // netSendAmounts
          runningBalances.concat(incentiveBalances) // runningBalances
        );
        hubPoolClient.addEvent(leafEvent);
      });

      await hubPoolClient.update();

      // Make next block range span a random number of blocks:
      const nextBlockRangeSize = Math.ceil(Math.random() * 10);
      nextBlockRangesForChain = Object.fromEntries(
        chainIds.map((chainId) => [
          chainId,
          {
            start: nextBlockRangesForChain[chainId].end + 1,
            end: nextBlockRangesForChain[chainId].end + nextBlockRangeSize,
          },
        ])
      );
    }
    await Promise.all(chainIds.map((chainId) => spokePoolClients[Number(chainId)].update()));

    // Make the last bundle to cover until the last spoke client searched block, unless a spoke pool
    // client was provided for the chain. In this case we assume that chain is disabled.
    chainIds.forEach((chainId) => {
      expectedBlockRanges[chainId][expectedBlockRanges[chainId].length - 1].end =
        spokePoolClients[chainId].latestBlockSearched;
    });
    return expectedBlockRanges;
  }
  describe("getUbaActivationBundleStartBlocks", function () {
    it("If uba activation block is not set", async function () {
      configStoreClient.setUBAActivationBlock(undefined);
      expect(() => getUbaActivationBundleStartBlocks(hubPoolClient)).to.throw(/UBA was not activated yet/);
    });
    it("Returns next validated bundle start blocks after UBA activation block", async function () {
      const expectedBlockRanges = await publishValidatedBundles(3);

      // Set UBA activation block to block right after first bundle was proposed.
      const proposalBlocks = hubPoolClient.getProposedRootBundles().map((bundle) => bundle.blockNumber);
      configStoreClient.setUBAActivationBlock(proposalBlocks[0] + 1);

      // Start blocks should be second bundle start blocks
      const result = getUbaActivationBundleStartBlocks(hubPoolClient);
      deepEqualsWithBigNumber(
        result,
        chainIds.map((chainId) => expectedBlockRanges[chainId][1].start)
      );

      // If UBA activation block was same block as a proposal block number, uses that proposed bundle start blocks
      configStoreClient.setUBAActivationBlock(proposalBlocks[0]);
      deepEqualsWithBigNumber(
        getUbaActivationBundleStartBlocks(hubPoolClient),
        chainIds.map((chainId) => expectedBlockRanges[chainId][0].start)
      );
    });
    it("If no validated proposals after UBA activation block, returns next bundle start blocks", async function () {
      const result = getUbaActivationBundleStartBlocks(hubPoolClient);
      deepEqualsWithBigNumber(
        result,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        Array(chainIds.length).fill(0)
      );
    });
  });
  describe("getMostRecentBundleBlockRanges", function () {
    it("Request maxBundleState 0", async function () {
      // Should return by default single bundle range.
      const result = getMostRecentBundleBlockRanges(chainIds[0], 0, hubPoolClient, spokePoolClients);
      deepEqualsWithBigNumber(result, [
        {
          start: getUbaActivationBundleStartBlocks(hubPoolClient)[0],
          end: spokePoolClients[chainIds[0]].latestBlockSearched,
        },
      ]);
    });
    it("No bundles", async function () {
      // If no bundles in memory, returns a single bundle range spanning from the spoke pool activation block
      // until the last block searched.

      const defaultResult = getMostRecentBundleBlockRanges(chainIds[0], 10, hubPoolClient, spokePoolClients);
      deepEqualsWithBigNumber(defaultResult, [
        {
          start: getUbaActivationBundleStartBlocks(hubPoolClient)[0],
          end: spokePoolClients[chainIds[0]].latestBlockSearched,
        },
      ]);
    });
    it("Correctly returns n most recent validated bundles", async function () {
      // Generate 3 valid bundles.
      const expectedBlockRanges = await publishValidatedBundles(3);
      for (const chainId of chainIds) {
        // Get 2 most recent bundles.
        const result = getMostRecentBundleBlockRanges(chainId, 2, hubPoolClient, spokePoolClients);
        // Should only return 2 most recent bundles.
        expect(result.length).to.equal(2);
        deepEqualsWithBigNumber(result, expectedBlockRanges[chainId].slice(1));
      }
    });
  });
  describe("getOpeningRunningBalances", function () {
    it("No valid bundles", async function () {
      const result = getOpeningRunningBalanceForEvent(
        hubPoolClient,
        0,
        chainIds[0],
        l1Tokens[0],
        Number.MAX_SAFE_INTEGER
      );
      expect(result.runningBalance).to.equal(0);
      expect(result.incentiveBalance).to.equal(0);
    });
    it("Selects running balance from bundle before event block", async function () {
      const expectedBlockRanges = await publishValidatedBundles(3);

      // Test 1: UBA is active for all bundles tested, should return running balance and incentive balance as
      // published on chain.
      configStoreClient.setUBAActivationBlock(0);
      for (const chain of chainIds) {
        for (let i = 0; i < l1Tokens.length; i++) {
          const result1 = getOpeningRunningBalanceForEvent(
            hubPoolClient,
            // Start block of bundle should select running balance from previous bundle
            expectedBlockRanges[chain][1].start,
            chain,
            l1Tokens[i],
            Number.MAX_SAFE_INTEGER
          );
          expect(result1.runningBalance).to.equal(runningBalances[i]);
          expect(result1.incentiveBalance).to.equal(incentiveBalances[i]);

          const result2 = getOpeningRunningBalanceForEvent(
            hubPoolClient,
            // Block before all bundle should return 0
            0,
            chain,
            l1Tokens[i],
            Number.MAX_SAFE_INTEGER
          );
          expect(result2.runningBalance).to.equal(0);
          expect(result2.incentiveBalance).to.equal(0);
        }
      }

      // Test 2: UBA is not activated at time of input block, running balances should be negated and incentive
      // balance should be 0
      configStoreClient.setUBAActivationBlock(Number.MAX_SAFE_INTEGER);
      for (const chain of chainIds) {
        for (let i = 0; i < l1Tokens.length; i++) {
          const result1 = getOpeningRunningBalanceForEvent(
            hubPoolClient,
            // Start block of bundle should select running balance from previous bundle
            expectedBlockRanges[chain][1].start,
            chain,
            l1Tokens[i],
            Number.MAX_SAFE_INTEGER
          );
          expect(result1.runningBalance).to.equal(runningBalances[i].mul(-1));
          expect(result1.incentiveBalance).to.equal(0);
        }
      }
    });
  });
  describe("getBundleStartBlocksForProposalContainingBlock", function () {
    it("No validated bundles", async function () {
      // Should return 0 for all chains.
      const result = hubPoolClient.getBundleStartBlocksForProposalContainingBlock(0, chainIds[0]);
      deepEqualsWithBigNumber(result, Array(chainIds.length).fill(0));
    });
    it("Selects bundle start blocks from range containing block", async function () {
      const expectedBlockRanges = await publishValidatedBundles(3);
      const chainId = chainIds[0];
      for (let i = 0; i < expectedBlockRanges[chainId].length; i++) {
        const blockRange = expectedBlockRanges[chainId][i];
        const result = hubPoolClient.getBundleStartBlocksForProposalContainingBlock(blockRange.start, chainId);
        const expectedBundleStartBlocks = chainIds.map((chainId) => expectedBlockRanges[chainId][i].start);
        deepEqualsWithBigNumber(result, expectedBundleStartBlocks);

        // If searching for block after end, will select next block range start:
        const result2 = hubPoolClient.getBundleStartBlocksForProposalContainingBlock(blockRange.end + 1, chainId);

        // If event block is beyond latest block range, then uses the latest fully executed bundle end blocks + 1
        if (i === expectedBlockRanges[chainId].length - 1) {
          const latestExecutedBundleForBlockRange = hubPoolClient.getLatestFullyExecutedRootBundle(
            hubPoolClient.latestBlockNumber!
          );
          const nextStartBlocks = latestExecutedBundleForBlockRange!.bundleEvaluationBlockNumbers.map(
            (blockNumber) => blockNumber.toNumber() + 1
          );
          deepEqualsWithBigNumber(result2, nextStartBlocks);
        } else {
          const expectedBundleStartBlock2 = chainIds.map((_chainId) => expectedBlockRanges[_chainId][i].end + 1);
          deepEqualsWithBigNumber(result2, expectedBundleStartBlock2);
        }

        // If less than start block, will select previous block, unless its the first block range then returns
        // all 0's
        const result3 = hubPoolClient.getBundleStartBlocksForProposalContainingBlock(blockRange.start - 1, chainId);
        const expectedBundleStartBlock3 =
          i > 0
            ? chainIds.map((_chainId) => expectedBlockRanges[_chainId][i - 1].start)
            : Array(chainIds.length).fill(0);
        deepEqualsWithBigNumber(result3, expectedBundleStartBlock3);
      }
    });
  });
});
