import { ethers, expect } from "./utils";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";

// Tested
import { DataworkerClients } from "../src/dataworker/DataworkerClientHelper";
import { HubPoolClient, SpokePoolClient } from "../src/clients";
import { getWidestPossibleExpectedBlockRange } from "../src/dataworker/PoolRebalanceUtils";
import { CHAIN_ID_TEST_LIST, toBN } from "./constants";
import { getEndBlockBuffers } from "../src/dataworker/DataworkerUtils";

let dataworkerClients: DataworkerClients;
let spokePoolClients: { [chainId: number]: SpokePoolClient };
let hubPoolClient: HubPoolClient;
let updateAllClients: () => Promise<void>;

describe.only("Dataworker block range-related utility methods", async function () {
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
    expect(zeroRange).to.deep.equal(latestBlocks.map((endBlock) => [0, 0]));
  });
});
