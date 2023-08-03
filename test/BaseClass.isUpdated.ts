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
    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);

    const { spokePool } = await deploySpokePool(ethers);
    const deploymentBlock = await spokePool.provider.getBlockNumber();

    spokePoolClient = new MockSpokePoolClient(spyLogger, spokePool, 1, deploymentBlock);

    ubaClient = new MockUBAClient([], hubPoolClient, {
      "1": spokePoolClient,
    });
  });

  describe("HubPoolClient", () => {
    it("should return true if the client is updated", async () => {
      await hubPoolClient.configStoreClient.update();
      await hubPoolClient.update();
      expect(hubPoolClient.isUpdated).to.be.true;
    });

    it("should return false if the client is not updated", async () => {
      expect(hubPoolClient.isUpdated).to.be.false;
    });
  });
  describe("SpokePoolClient", () => {
    it("should return true if the client is updated", async () => {
      await spokePoolClient.update();
      expect(spokePoolClient.isUpdated).to.be.true;
    });

    it("should return false if the client is not updated", async () => {
      expect(spokePoolClient.isUpdated).to.be.false;
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
    it("should return false if the client is not updated", async () => {
      expect(ubaClient.isUpdated).to.be.false;
    });
  });
});
