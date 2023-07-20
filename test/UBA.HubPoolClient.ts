import { random } from "lodash";
import { UBAClient } from "../src/clients";
import { isDefined } from "../src/utils";
import {
  BigNumber,
  Contract,
  createSpyLogger,
  deployConfigStore,
  deploySpokePool,
  expect,
  ethers,
  hubPoolFixture,
  toBN,
  toBNWei,
} from "./utils";
import { MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient } from "./mocks";

type Event = ethers.Event;

let spokePoolClients: { [chainId: number]: MockSpokePoolClient };
let hubPool: Contract, dai: Contract, weth: Contract;
let uba: UBAClient;
let hubPoolClient: MockHubPoolClient;

const logger = createSpyLogger().spyLogger;

const chainIds = [10, 137];

describe("UBA: HubPool Events", async function () {
  beforeEach(async function () {
    const [owner] = await ethers.getSigners();
    const { configStore } = await deployConfigStore(owner, []);
    const configStoreClient = new MockConfigStoreClient(
      logger,
      configStore,
      { fromBlock: 0 },
      2, // @todo: UBA_MIN_CONFIG_STORE_VERSION ?
      chainIds
    );
    await configStoreClient.update();

    ({ hubPool, dai, weth } = await hubPoolFixture());
    hubPoolClient = new MockHubPoolClient(logger, hubPool, configStoreClient);
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

    // @todo: The RelayFeeCalculatorConfig should be mocked.
    const tokenSymbols = ["WETH", "DAI"];
    uba = new UBAClient(tokenSymbols, hubPoolClient, spokePoolClients, logger);

    await Promise.all(Object.values(spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
    await hubPoolClient.update();
  });

  it.skip("Defaults to SpokePool deployment block when no root bundles have been executed", async function () {
    for (const chainId of chainIds) {
      for (const token of [weth.address, dai.address]) {
        const result = uba.getOpeningBalance(chainId, token, spokePoolClients[chainId].latestBlockNumber);
        expect(result).to.not.be.undefined;
        if (isDefined(result)) {
          expect(result.spokePoolBalance.eq(0)).to.be.true;
          expect(result.blockNumber).to.be.equal(spokePoolClients[chainId].deploymentBlock);
        }
      }
    }
  });

  it.skip("Correctly identifies updated opening balances", async function () {
    let bundleEvaluationBlockNumbers: BigNumber[] = [];

    // Simulate leaf execution.
    const leafEvents: Event[] = [];
    for (let i = 0; i < 3; ++i) {
      bundleEvaluationBlockNumbers = Object.values(spokePoolClients).map((spokePoolClient) =>
        toBN(spokePoolClient.latestBlockNumber)
      );

      const rootBundleProposal = hubPoolClient.proposeRootBundle(
        Math.floor(Date.now() / 1000) - 1, // challengePeriodEndTimestamp
        chainIds.length, // poolRebalanceLeafCount
        bundleEvaluationBlockNumbers
      );
      hubPoolClient.addEvent(rootBundleProposal);
      await hubPoolClient.update();

      let leafId = 0;
      chainIds.forEach((chainId) => {
        const groupIndex = toBN(chainId === hubPoolClient.chainId ? 0 : 1);
        const leafEvent = hubPoolClient.executeRootBundle(
          groupIndex,
          leafId++,
          toBN(chainId),
          [dai.address], // l1Tokens
          [toBNWei(0)], // bundleLpFees
          [toBNWei(0)], // netSendAmounts
          [toBNWei(random(-1000, 1000).toPrecision(5))] // runningBalances
        );
        leafEvents.push(leafEvent);
        hubPoolClient.addEvent(leafEvent);
      });

      await hubPoolClient.update();
      await Promise.all(chainIds.map((chainId) => spokePoolClients[Number(chainId)].update()));
    }

    for (const chainId of chainIds) {
      // DAI has executed leaves, WETH does not (running balance should default to 0).
      for (const token of [dai.address, weth.address]) {
        let blockNumber = -1;
        let spokePoolBalance = toBN(-1);

        const result = uba.getOpeningBalance(chainId, token, spokePoolClients[chainId].latestBlockNumber);
        expect(result).to.not.be.undefined;
        if (isDefined(result)) {
          ({ blockNumber, spokePoolBalance } = result);
        }

        // Find the last executed leaf affecting `token` on this chain. If no leaf affecting `token`
        // has ever been executed, default tokenIdx to -1 to indicate an expected runningBalance of 0.
        const event = Array.from(leafEvents)
          .reverse()
          .find((event) => event["args"]["chainId"].eq(chainId) && event["args"]["l1Tokens"].includes(token));
        const tokenIdx = event ? event["args"]["l1Tokens"].indexOf(token) : -1;

        const expectedBalance = tokenIdx === -1 ? toBN(0) : event["args"]["runningBalances"][tokenIdx];
        expect(spokePoolBalance.eq(expectedBalance)).to.be.true;

        const chainIdx = chainIds.indexOf(chainId);
        // @todo: Opening block number is not correctly resolved. To be fixed.
        expect(bundleEvaluationBlockNumbers[chainIdx].eq(blockNumber - 1)).to.be.true;
      }
    }
  });
});
