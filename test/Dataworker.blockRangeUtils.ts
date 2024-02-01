import { ethers, expect } from "./utils";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";

// Tested
import { DataworkerClients } from "../src/dataworker/DataworkerClientHelper";
import { HubPoolClient, SpokePoolClient } from "../src/clients";
import { getWidestPossibleExpectedBlockRange } from "../src/dataworker/PoolRebalanceUtils";
import { originChainId } from "./constants";
import { blockRangesAreInvalidForSpokeClients, getEndBlockBuffers } from "../src/dataworker/DataworkerUtils";
import { getDeployedBlockNumber } from "@across-protocol/contracts-v2";
import { MockHubPoolClient } from "./mocks";

let dataworkerClients: DataworkerClients;
let spokePoolClients: { [chainId: number]: SpokePoolClient };
let hubPoolClient: HubPoolClient;
let updateAllClients: () => Promise<void>;

describe("Dataworker block range-related utility methods", async function () {
  beforeEach(async function () {
    ({ dataworkerClients, spokePoolClients, updateAllClients, hubPoolClient } = await setupDataworker(ethers, 1, 1, 0));
    await updateAllClients();
  });
  it("DataworkerUtils.getEndBlockBuffers", async function () {
    const defaultBuffer = {
      2: 2,
      3: 3,
    };
    const chainIdList = [2, 3];

    // Gets buffer if it exists for chain, or returns 0
    expect(getEndBlockBuffers(chainIdList, defaultBuffer)).to.deep.equal([2, 3]);
    expect(getEndBlockBuffers([2, 4], defaultBuffer)).to.deep.equal([2, 0]);
  });
  it("PoolRebalanceUtils.getWidestPossibleExpectedBlockRange", async function () {
    // End blocks equal to latest spoke client block, start block for first bundle equal to 0:
    const chainIdListForBundleEvaluationBlockNumbers = Object.keys(spokePoolClients).map((_chainId) =>
      Number(_chainId)
    );
    const defaultEndBlockBuffers = Array(chainIdListForBundleEvaluationBlockNumbers.length).fill(1);
    const latestBlocks = await Promise.all(
      chainIdListForBundleEvaluationBlockNumbers.map(async (chainId: number, index) =>
        Math.max(
          0,
          (await spokePoolClients[chainId].spokePool.provider.getBlockNumber()) - defaultEndBlockBuffers[index]
        )
      )
    );
    const latestMainnetBlock = hubPoolClient.latestBlockSearched;
    const startingWidestBlocks = getWidestPossibleExpectedBlockRange(
      chainIdListForBundleEvaluationBlockNumbers,
      spokePoolClients,
      defaultEndBlockBuffers,
      dataworkerClients,
      latestMainnetBlock,
      chainIdListForBundleEvaluationBlockNumbers
    );
    expect(startingWidestBlocks).to.deep.equal(latestBlocks.map((endBlock) => [0, endBlock]));

    // Sets end block to start block if chain is not on enabled chain list.
    const disabledChainEndBlocks = getWidestPossibleExpectedBlockRange(
      chainIdListForBundleEvaluationBlockNumbers,
      spokePoolClients,
      defaultEndBlockBuffers,
      dataworkerClients,
      latestMainnetBlock,
      chainIdListForBundleEvaluationBlockNumbers.slice(1)
    );
    expect(disabledChainEndBlocks).to.deep.equal(
      latestBlocks.map((endBlock, i) => {
        if (i === 0) {
          return [0, 0];
        } else {
          return [0, endBlock];
        }
      })
    );

    // End block defaults to 0 if buffer is too large
    const largeBuffers = Array(chainIdListForBundleEvaluationBlockNumbers.length).fill(1000);
    const zeroRange = getWidestPossibleExpectedBlockRange(
      chainIdListForBundleEvaluationBlockNumbers,
      spokePoolClients,
      largeBuffers,
      dataworkerClients,
      latestMainnetBlock,
      chainIdListForBundleEvaluationBlockNumbers
    );
    expect(zeroRange).to.deep.equal(latestBlocks.map(() => [0, 0]));
  });
  it("PoolRebalanceUtils.getWidestPossibleExpectedBlockRange: chain is paused", async function () {
    const mockHubPoolClient = new MockHubPoolClient(
      hubPoolClient.logger,
      hubPoolClient.hubPool,
      dataworkerClients.configStoreClient,
      hubPoolClient.deploymentBlock,
      hubPoolClient.chainId
    );

    const chainIdListForBundleEvaluationBlockNumbers = Object.keys(spokePoolClients).map((_chainId) =>
      Number(_chainId)
    );

    // Set bundle end blocks equal to spoke pool clients latest blocks to simulate a chain being paused:
    // - Buffers are 0:
    let defaultEndBlockBuffers = Array(chainIdListForBundleEvaluationBlockNumbers.length).fill(0);
    chainIdListForBundleEvaluationBlockNumbers.forEach((_chainId) => {
      mockHubPoolClient.setLatestBundleEndBlockForChain(_chainId, spokePoolClients[_chainId].latestBlockSearched);
    });
    expect(
      getWidestPossibleExpectedBlockRange(
        chainIdListForBundleEvaluationBlockNumbers,
        spokePoolClients,
        defaultEndBlockBuffers,
        {
          ...dataworkerClients,
          hubPoolClient: mockHubPoolClient,
        },
        0,
        chainIdListForBundleEvaluationBlockNumbers
      )
    ).to.deep.equal(
      chainIdListForBundleEvaluationBlockNumbers.map((_chainId) => [
        spokePoolClients[_chainId].latestBlockSearched,
        spokePoolClients[_chainId].latestBlockSearched,
      ])
    );

    // - Works with Buffers > 0 such that the latest blocks minus buffers are < latest bundle end blocks.
    defaultEndBlockBuffers = Array(chainIdListForBundleEvaluationBlockNumbers.length).fill(10);
    expect(
      getWidestPossibleExpectedBlockRange(
        chainIdListForBundleEvaluationBlockNumbers,
        spokePoolClients,
        defaultEndBlockBuffers,
        {
          ...dataworkerClients,
          hubPoolClient: mockHubPoolClient,
        },
        0,
        chainIdListForBundleEvaluationBlockNumbers
      )
    ).to.deep.equal(
      chainIdListForBundleEvaluationBlockNumbers.map((_chainId) => [
        spokePoolClients[_chainId].latestBlockSearched,
        spokePoolClients[_chainId].latestBlockSearched,
      ])
    );
  });
  it("DataworkerUtils.blockRangesAreInvalidForSpokeClients", async function () {
    const chainId = hubPoolClient.chainId;

    // Only use public chain IDs because getDeploymentBlockNumber will only work for real chain ID's. This is a hack
    // and getDeploymentBlockNumber should be changed to work in test environments.
    const _spokePoolClients = { [chainId]: spokePoolClients[chainId] };
    const chainIds = [chainId];

    // Look if bundle range from block is before the latest invalid
    // bundle start block. If so, then the range is invalid.

    const mainnetDeploymentBlock = spokePoolClients[chainId].deploymentBlock;
    if (mainnetDeploymentBlock === 0) {
      throw new Error("Mainnet SpokePoolClient has not been updated");
    }
    if (spokePoolClients[chainId].latestBlockSearched === 0) {
      throw new Error(`Chain ${spokePoolClients[1].chainId} SpokePoolClient has not been updated`);
    } else if (spokePoolClients[originChainId].latestBlockSearched === 0) {
      throw new Error(`Chain ${originChainId} SpokePoolClient has not been updated`);
    }

    // latestInvalidBundleStartBlock is only used if its greater than the spoke pool deployment block, so in the
    // following tests, set latestInvalidBundleStartBlock > deployment blocks.

    // Additionally, set the bundle range toBlocks <= spoke pool client's latest block numbers so we only test the
    // condition: `bundleRangeFromBlock <= latestInvalidBundleStartBlock[chainId]`

    // Bundle block range fromBlocks are greater than
    // latest invalid bundle start blocks below and toBlocks are >= client's last block queried, return false meaning
    // that block ranges can be validated by spoke pool clients.
    expect(
      await blockRangesAreInvalidForSpokeClients(
        _spokePoolClients,
        [[mainnetDeploymentBlock + 3, spokePoolClients[chainId].latestBlockSearched]],
        chainIds,
        { [chainId]: mainnetDeploymentBlock + 2 }
      )
    ).to.equal(false);
    // Set block range toBlock > client's last block queried. Clients can no longer validate this block range.
    expect(
      await blockRangesAreInvalidForSpokeClients(
        _spokePoolClients,
        [[mainnetDeploymentBlock + 3, spokePoolClients[chainId].latestBlockSearched + 3]],
        chainIds,
        { [chainId]: mainnetDeploymentBlock + 2 }
      )
    ).to.equal(true);
    // Bundle block range toBlocks is less than
    // latest invalid bundle start blocks below, so block ranges can't be validated by clients.
    expect(
      await blockRangesAreInvalidForSpokeClients(
        _spokePoolClients,
        [[mainnetDeploymentBlock + 1, spokePoolClients[chainId].latestBlockSearched]],
        chainIds,
        { [chainId]: mainnetDeploymentBlock + 2 }
      )
    ).to.equal(true);
    // Works even if the condition is true for one chain.
    const optimismDeploymentBlock = getDeployedBlockNumber("SpokePool", 10);
    expect(
      await blockRangesAreInvalidForSpokeClients(
        { [chainId]: spokePoolClients[chainId], [10]: spokePoolClients[originChainId] },
        [
          [mainnetDeploymentBlock + 1, spokePoolClients[chainId].latestBlockSearched],
          [optimismDeploymentBlock + 3, spokePoolClients[originChainId].latestBlockSearched],
        ],
        [chainId, 10],
        { [chainId]: mainnetDeploymentBlock + 2, [10]: optimismDeploymentBlock + 2 }
      )
    ).to.equal(true);
    expect(
      await blockRangesAreInvalidForSpokeClients(
        { [chainId]: spokePoolClients[chainId], [10]: spokePoolClients[originChainId] },
        [
          [mainnetDeploymentBlock + 3, spokePoolClients[chainId].latestBlockSearched],
          [optimismDeploymentBlock + 3, spokePoolClients[originChainId].latestBlockSearched],
        ],
        [chainId, 10],
        { [chainId]: mainnetDeploymentBlock + 2, [10]: optimismDeploymentBlock + 2 }
      )
    ).to.equal(false);

    // On these tests, set block range fromBlock < deployment block. The deployment block is now compared against
    // the latest invalid start block. This means that the dataworker will refuse to validate any bundles with clients
    // that don't have early enough data for the first bundle, which started at the deployment block height.
    expect(
      await blockRangesAreInvalidForSpokeClients(
        _spokePoolClients,
        [[0, spokePoolClients[chainId].latestBlockSearched]],
        chainIds,
        {
          [chainId]: mainnetDeploymentBlock + 2,
        }
      )
    ).to.equal(true);
    expect(
      await blockRangesAreInvalidForSpokeClients(
        _spokePoolClients,
        [[0, spokePoolClients[chainId].latestBlockSearched]],
        chainIds,
        {
          [chainId]: mainnetDeploymentBlock - 1,
        }
      )
    ).to.equal(false);

    // Override spoke pool client fill deadline buffer and oldest time searched and check that it returns false
    // buffer is not great enough to cover the time between the end block and the oldest time searched by
    // the client.
    // TODO:
  });
});
