import { random } from "lodash";
// import { PendingRootBundle } from "../../src/interfaces";
import { UBAClient } from "../src/utils";
import {
  Contract,
  createSpyLogger,
  deploySpokePool,
  expect,
  ethers,
  hubPoolFixture,
  // SignerWithAddress,
  toBN,
  toBNWei,
} from "./utils";
import { MockHubPoolClient, MockSpokePoolClient } from "./mocks";

type Event = ethers.Event;

let spokePoolClients: { [chainId: number]: MockSpokePoolClient };
let hubPool: Contract, dai: Contract, weth: Contract;
let uba: UBAClient;
let hubPoolClient: MockHubPoolClient;
let hubPoolDeploymentBlock: number;

const logger = createSpyLogger().spyLogger;

const chainIds = [10, 137];

describe("UBA: HubPool Events", async function () {
  beforeEach(async function () {

    ({ hubPool, dai, weth } = await hubPoolFixture());
    hubPoolDeploymentBlock = random(1, 100, false);
    hubPoolClient = new MockHubPoolClient(logger, hubPool, hubPoolDeploymentBlock);
    await hubPoolClient.update();

    spokePoolClients = {};
    for (const originChainId of chainIds) {
      const { spokePool } = await deploySpokePool(ethers);
      const deploymentBlock = await spokePool.provider.getBlockNumber();

      const spokePoolClient = new MockSpokePoolClient(logger, spokePool, originChainId, deploymentBlock);
      spokePoolClients[originChainId] = spokePoolClient;

      // Register deposit routes in HubPool and SpokePools.
      // Note: Each token uses the same address across all chains.
      const otherChainIds = chainIds.filter((otherChainId) => otherChainId !== originChainId);
      for (const destinationChainId of otherChainIds) {
        [dai.address, weth.address].forEach((originToken) => {
          let event = spokePoolClient.generateDepositRoute(originToken, destinationChainId, true);
          spokePoolClient.addEvent(event);

          event = hubPoolClient.setPoolRebalanceRoute(originChainId, originToken, originToken);
          hubPoolClient.addEvent(event);
        });
      }
    }

    uba = new UBAClient(chainIds, hubPoolClient, spokePoolClients);

    await Promise.all(Object.values(spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
    await hubPoolClient.update();
  });

  it("Defaults to deployment block when no root bundles have been executed", async function () {
    for (const chainId of chainIds) {
      for (const token of [weth.address, dai.address]) {
        const { balance, blockNumber } = uba.getOpeningBalance(chainId, token);
        expect(balance.eq(0)).to.be.true;
        expect(blockNumber).to.be.equal(hubPoolDeploymentBlock);
      }
    }
  });

  it("Correctly identifies updated opening balances", async function () {
    const bundleEvaluationBlockNumbers = Object.values(spokePoolClients).map((spokePoolClient) =>
      toBN(spokePoolClient.latestBlockNumber)
    );

    const rootBundleProposal = hubPoolClient.proposeRootBundle(
      Math.floor(Date.now() / 1000) - 1, // challengePeriodEndTimestamp
      chainIds.length, // poolRebalanceLeafCount
      bundleEvaluationBlockNumbers
    );
    hubPoolClient.addEvent(rootBundleProposal);
    await hubPoolClient.update();

    // Simulate leaf execution.
    const leafEvents: Event[] = [];
    chainIds.forEach((chainId) => {
      const groupIndex = toBN(chainId === hubPoolClient.chainId ? 0 : 1);
      let leafId = 0;
      const leafEvent = hubPoolClient.executeRootBundle(
        groupIndex,
        leafId++,
        toBN(chainId),
        [dai.address], // l1Tokens
        [toBNWei(0)], // bundleLpFees
        [toBNWei(0)], // netSendAmounts
        [toBNWei(random(0.0001, 1000).toPrecision(5))] // runningBalances
      );
      leafEvents.push(leafEvent);
      hubPoolClient.addEvent(leafEvent);
    });
    await hubPoolClient.update();
    await Promise.all(chainIds.map((chainId) => spokePoolClients[Number(chainId)].update()));

    const token = dai.address;
    for (const chainId of chainIds) {
      const { balance, blockNumber } = uba.getOpeningBalance(chainId, token);

      // Find the applicable leaf.
      const event = leafEvents.find((event) => event["args"]["chainId"].eq(chainId));

      const tokenIdx = event["args"]["l1Tokens"].indexOf(token);
      const expectedBalance = event["args"]["runningBalances"][tokenIdx];
      expect(balance.eq(expectedBalance)).to.be.true;

      const chainIdx = chainIds.indexOf(chainId);
      expect(bundleEvaluationBlockNumbers[chainIdx]).eq(blockNumber - 1);
    }
  });
});
