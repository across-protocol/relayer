import { ethers, expect } from "./utils";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";

// Tested
import { DataworkerClients } from "../src/dataworker/DataworkerClientHelper";
import { HubPoolClient, SpokePoolClient } from "../src/clients";
import { getWidestPossibleExpectedBlockRange } from "../src/dataworker/PoolRebalanceUtils";
import { CHAIN_ID_TEST_LIST, originChainId, toBN } from "./constants";
import { blockRangesAreInvalidForSpokeClients, getEndBlockBuffers } from "../src/dataworker/DataworkerUtils";
import { getDeployedBlockNumber } from "@across-protocol/contracts-v2";

let dataworkerClients: DataworkerClients;
let spokePoolClients: { [chainId: number]: SpokePoolClient };
let hubPoolClient: HubPoolClient;
let updateAllClients: () => Promise<void>;

describe("Dataworker block range-related utility methods", async function () {
  beforeEach(async function () {
    ({ dataworkerClients, spokePoolClients, updateAllClients, hubPoolClient } = await setupDataworker(
      ethers,
      1,
      1,
      toBN(0),
      0
    ));
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
    const chainIdListForBundleEvaluationBlockNumbers = CHAIN_ID_TEST_LIST;
    const defaultEndBlockBuffers = Array(chainIdListForBundleEvaluationBlockNumbers.length).fill(1);
    const latestBlocks = await Promise.all(
      chainIdListForBundleEvaluationBlockNumbers.map(async (chainId: number, index) =>
        Math.max(
          0,
          (await spokePoolClients[chainId].spokePool.provider.getBlockNumber()) - defaultEndBlockBuffers[index]
        )
      )
    );
    const latestMainnetBlock = hubPoolClient.latestBlockNumber;
    if (latestMainnetBlock === undefined) {
      throw new Error("hubPoolClient.latestBlockNumber is undefined");
    }
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
  it("DataworkerUtils.blockRangesAreInvalidForSpokeClients", async function () {
    // Only use public chain IDs because getDeploymentBlockNumber will only work for real chain ID's. This is a hack
    // and getDeploymentBlockNumber should be changed to work in test environments.
    const _spokePoolClients = { [1]: spokePoolClients[1] };
    const chainIds = [1];

    // Look if bundle range from block is before the latest invalid
    // bundle start block. If so, then the range is invalid.
    const mainnetDeploymentBlock = spokePoolClients[1].spokePoolDeploymentBlock;
    if (mainnetDeploymentBlock === undefined) {
      throw new Error("mainnetDeploymentBlock is undefined");
    }
    if (spokePoolClients[1].latestBlockNumber === undefined) {
      throw new Error("spokePoolClient[1].latestBlockNumber is undefined");
    }
    if (spokePoolClients[originChainId].latestBlockNumber === undefined) {
      throw new Error("spokePoolClient[originChainId].latestBlockNumber is undefined");
    }

    // latestInvalidBundleStartBlock is only used if its greater than the spoke pool deployment block, so in the
    // following tests, set latestInvalidBundleStartBlock > deployment blocks.

    // Additionally, set the bundle range toBlocks <= spoke pool client's latest block numbers so we only test the
    // condition: `bundleRangeFromBlock <= latestInvalidBundleStartBlock[chainId]`

    // Bundle block range fromBlocks are greater than
    // latest invalid bundle start blocks below and toBlocks are >= client's last block queried, return false meaning
    // that block ranges can be validated by spoke pool clients.
    expect(
      blockRangesAreInvalidForSpokeClients(
        _spokePoolClients,
        [[mainnetDeploymentBlock + 3, spokePoolClients[1].latestBlockNumber]],
        chainIds,
        { [1]: mainnetDeploymentBlock + 2 }
      )
    ).to.equal(false);
    // Set block range toBlock > client's last block queried. Clients can no longer validate this block range.
    expect(
      blockRangesAreInvalidForSpokeClients(
        _spokePoolClients,
        [[mainnetDeploymentBlock + 3, spokePoolClients[1].latestBlockNumber + 3]],
        chainIds,
        { [1]: mainnetDeploymentBlock + 2 }
      )
    ).to.equal(true);
    // Bundle block range toBlocks is less than
    // latest invalid bundle start blocks below, so block ranges can't be validated by clients.
    expect(
      blockRangesAreInvalidForSpokeClients(
        _spokePoolClients,
        [[mainnetDeploymentBlock + 1, spokePoolClients[1].latestBlockNumber]],
        chainIds,
        { [1]: mainnetDeploymentBlock + 2 }
      )
    ).to.equal(true);
    // Works even if the condition is true for one chain.
    const optimismDeploymentBlock = getDeployedBlockNumber("SpokePool", 10);
    expect(
      blockRangesAreInvalidForSpokeClients(
        { [1]: spokePoolClients[1], [10]: spokePoolClients[originChainId] },
        [
          [mainnetDeploymentBlock + 1, spokePoolClients[1].latestBlockNumber],
          [optimismDeploymentBlock + 3, spokePoolClients[originChainId].latestBlockNumber],
        ],
        [1, 10],
        { [1]: mainnetDeploymentBlock + 2, [10]: optimismDeploymentBlock + 2 }
      )
    ).to.equal(true);
    expect(
      blockRangesAreInvalidForSpokeClients(
        { [1]: spokePoolClients[1], [10]: spokePoolClients[originChainId] },
        [
          [mainnetDeploymentBlock + 3, spokePoolClients[1].latestBlockNumber],
          [optimismDeploymentBlock + 3, spokePoolClients[originChainId].latestBlockNumber],
        ],
        [1, 10],
        { [1]: mainnetDeploymentBlock + 2, [10]: optimismDeploymentBlock + 2 }
      )
    ).to.equal(false);

    // On these tests, set block range fromBlock < deployment block. The deployment block is now compared against
    // the latest invalid start block. This means that the dataworker will refuse to validate any bundles with clients
    // that don't have early enough data for the first bundle, which started at the deployment block height.
    expect(
      blockRangesAreInvalidForSpokeClients(_spokePoolClients, [[0, spokePoolClients[1].latestBlockNumber]], chainIds, {
        [1]: mainnetDeploymentBlock + 2,
      })
    ).to.equal(true);
    expect(
      blockRangesAreInvalidForSpokeClients(_spokePoolClients, [[0, spokePoolClients[1].latestBlockNumber]], chainIds, {
        [1]: mainnetDeploymentBlock - 1,
      })
    ).to.equal(false);
  });
});
