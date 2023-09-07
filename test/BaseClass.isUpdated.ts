import { MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient, MockUBAClient } from "./mocks";
import { ethers, createSpyLogger, deployConfigStore, hubPoolFixture, deploySpokePool, expect } from "./utils";

describe("BaseAbstractClient.isUpdated", () => {
  let hubPoolClient: MockHubPoolClient;
  let spokePoolClient: MockSpokePoolClient;
  let ubaClient: MockUBAClient;

  beforeEach(async () => {
    const [owner] = await ethers.getSigners();
    const { spyLogger } = createSpyLogger();

    const { hubPool, dai: l1Token } = await hubPoolFixture();
    const { configStore } = await deployConfigStore(owner, [l1Token]);

    const configStoreClient = new MockConfigStoreClient(spyLogger, configStore);
    await configStoreClient.update();

    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    configStoreClient.setAvailableChains([1]);
    await configStoreClient.update();

    const { spokePool } = await deploySpokePool(ethers);
    const deploymentBlock = await spokePool.provider.getBlockNumber();

    spokePoolClient = new MockSpokePoolClient(spyLogger, spokePool, 1, deploymentBlock);

    await spokePoolClient.update();

    ubaClient = new MockUBAClient([], hubPoolClient, {
      "1": spokePoolClient,
    });
  });

  describe("UBAClient", () => {
    it("should return true if the client is updated", async () => {
      (hubPoolClient.configStoreClient as MockConfigStoreClient).setUBAActivationBlock(0);
      await hubPoolClient.configStoreClient.update();
      await hubPoolClient.update();
      await spokePoolClient.update();
      hubPoolClient.setLatestBlockNumber(50000);
      await ubaClient.update();
      expect(ubaClient.isUpdated).to.be.true;
    });
    it("should return false if the client is not updated", () => {
      expect(ubaClient.isUpdated).to.be.false;
    });
  });
});
