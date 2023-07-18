import { clients } from "@across-protocol/sdk-v2";
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

    ubaClient = new MockUBAClient(
      [1],
      ["DAI"],
      hubPoolClient,
      {
        "1": spokePoolClient,
      },
      spyLogger
    );
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
      await hubPoolClient.configStoreClient.update();
      await hubPoolClient.update();
      await spokePoolClient.update();
      hubPoolClient.setLatestBlockNumber(50000);
      await ubaClient.update(
        {
          "1": {} as clients.UBAChainState,
        },
        false
      );
      expect(ubaClient.isUpdated).to.be.true;
    });
    it("should return false if the client is not updated", async () => {
      await hubPoolClient.configStoreClient.update();
      await hubPoolClient.update();
      await ubaClient.update(
        {
          "1": {} as clients.UBAChainState,
        },
        false
      );
      expect(ubaClient.isUpdated).to.be.false;
    });
  });
});
