import { clients } from "@across-protocol/sdk-v2";
import { MockConfigStoreClient, MockHubPoolClient } from "./mocks";
import { ethers, createSpyLogger, deployConfigStore, hubPoolFixture, expect } from "./utils";

describe("UBAClientUtilities.getUBAConfig", () => {
  let hubPoolClient: MockHubPoolClient;
  const validChainId = 1;
  let validTokenSymbol;

  function getUBAFeeConfig(
    chainId: number = validChainId,
    tokenSymbol: string = validTokenSymbol,
    blockNumber?: number
  ) {
    return clients.getUBAFeeConfig(hubPoolClient, chainId, tokenSymbol, blockNumber);
  }

  beforeEach(async () => {
    const [owner] = await ethers.getSigners();
    const { spyLogger } = createSpyLogger();

    const { hubPool, dai: l1Token } = await hubPoolFixture();
    validTokenSymbol = await l1Token.symbol();
    const { configStore } = await deployConfigStore(owner, [l1Token]);

    const configStoreClient = new MockConfigStoreClient(spyLogger, configStore);
    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);
  });

  describe("Failing Conditions", () => {
    it("should fail if the config is not updated", () => {
      expect(() => getUBAFeeConfig()).to.throw(/Config client not updated/);
    });
    it("should fail if an invalid token symbol is provided", async () => {
      const invalidTokenSymbol = "INVALID";
      await hubPoolClient.configStoreClient.update();
      expect(() => getUBAFeeConfig(validChainId, invalidTokenSymbol)).to.throw(/L1 token can't be found/);
    });
  });
});
