import { ethers, expect, Logger } from "./utils";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";

// Tested
import {
  constructSpokePoolClientsForFastDataworker,
  DataworkerClients,
} from "../src/dataworker/DataworkerClientHelper";
import { HubPoolClient, SpokePoolClient } from "../src/clients";
import { getWidestPossibleExpectedBlockRange } from "../src/dataworker/PoolRebalanceUtils";
import { CHAIN_ID_TEST_LIST, toBN, originChainId } from "./constants";
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
    const startingWidestBlocks = await getWidestPossibleExpectedBlockRange(
      chainIdListForBundleEvaluationBlockNumbers,
      spokePoolClients,
      defaultEndBlockBuffers,
      dataworkerClients,
      latestMainnetBlock
    );
    expect(startingWidestBlocks).to.deep.equal(latestBlocks.map((endBlock) => [0, endBlock]));

    // End block defaults to 0 if buffer is too large
    const largeBuffers = Array(chainIdListForBundleEvaluationBlockNumbers.length).fill(1000);
    const zeroRange = await getWidestPossibleExpectedBlockRange(
      chainIdListForBundleEvaluationBlockNumbers,
      spokePoolClients,
      largeBuffers,
      dataworkerClients,
      latestMainnetBlock
    );
    expect(zeroRange).to.deep.equal(latestBlocks.map((_) => [0, 0]));
  });
  it("DataworkerUtils.blockRangesAreInvalidForSpokeClients", async function () {
    const chainId = originChainId;
    const spokeClient = spokePoolClients[chainId];

    // latestInvalidBundleStartBlock is not defined, return invalid iff block range to block is > spoke client's
    // latest blocks. If `eventSearchConfig.toBlock` is null, then the client's latest block defaults to the latest
    // block on the network as opposed to its eventSearchConfig.toBlock.
    expect(spokeClient.eventSearchConfig.toBlock).to.equal(null);
    expect(
      blockRangesAreInvalidForSpokeClients(
        spokePoolClients,
        Array(CHAIN_ID_TEST_LIST.length).fill([0, spokeClient.latestBlockNumber + 1]),
        CHAIN_ID_TEST_LIST,
        {}
      )
    ).to.equal(true);
    expect(
      blockRangesAreInvalidForSpokeClients(
        spokePoolClients,
        Array(CHAIN_ID_TEST_LIST.length).fill([0, spokeClient.latestBlockNumber]),
        CHAIN_ID_TEST_LIST,
        {}
      )
    ).to.equal(false);

    // latestInvalidBundleStartBlock is defined, so look if bundle range from block is before the latest invalid
    // bundle start block. If so, then the range is invalid.
    const mainnetDeploymentBlock = getDeployedBlockNumber("SpokePool", 1);
    // latestInvalidBundleStartBlock is only used if its greater than the spoke pool deployment block
    const latestInvalidStartBlock = mainnetDeploymentBlock + 100;
    expect(
      blockRangesAreInvalidForSpokeClients(
        spokePoolClients,
        Array(CHAIN_ID_TEST_LIST.length).fill([latestInvalidStartBlock, latestInvalidStartBlock + 1]),
        CHAIN_ID_TEST_LIST,
        { [1]: latestInvalidStartBlock } // Can only set a value for chain ID 1 since getDeploymentBlockNumber will only
        // successfully fetch real networks.
      )
    ).to.equal(true);
    expect(
      blockRangesAreInvalidForSpokeClients(
        spokePoolClients,
        // This block range is obviously nonsensical since toBlock > fromBlock but its a workaround since
        // getDeployedBlockNumber only works for real networks like chainId 1.
        Array(CHAIN_ID_TEST_LIST.length).fill([latestInvalidStartBlock + 1, spokeClient.latestBlockNumber]),
        CHAIN_ID_TEST_LIST,
        { [1]: latestInvalidStartBlock }
      )
    ).to.equal(false);
    // Returns range is invalid if toBlock is greater than client's last block queried
    expect(
      blockRangesAreInvalidForSpokeClients(
        spokePoolClients,
        Array(CHAIN_ID_TEST_LIST.length).fill([latestInvalidStartBlock + 1, spokeClient.latestBlockNumber + 1]),
        CHAIN_ID_TEST_LIST,
        { [1]: latestInvalidStartBlock }
      )
    ).to.equal(true);
  });
});
