import { clients, interfaces, utils } from "@across-protocol/sdk-v2";
import { MockConfigStoreClient, MockHubPoolClient } from "./mocks";
import { ethers, createSpyLogger, deployConfigStore, hubPoolFixture, expect } from "./utils";

describe("UBAClientUtilities.getUBAConfig", () => {
  let hubPoolClient: MockHubPoolClient;
  const validChainId = 1;
  let validTokenSymbol: string;

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
    const { configStore } = await deployConfigStore(owner, [l1Token]);

    const configStoreClient = new MockConfigStoreClient(spyLogger, configStore);
    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);

    hubPoolClient.addL1Token({
      address: "0x",
      symbol: "DAI",
      decimals: 18,
    });
    validTokenSymbol = hubPoolClient.getL1Tokens()[0].symbol;
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
  describe("Passing Conditions", () => {
    it("should return the correct UBA config", async () => {
      await hubPoolClient.configStoreClient.update();
      await hubPoolClient.update();

      const mockedConfigStore = hubPoolClient.configStoreClient as MockConfigStoreClient;

      const rawConfig = (
        utils.parseJSONWithNumericString(
          '{"rateModel":{"UBar":"750000000000000000","R0":"21000000000000000","R1":"0","R2":"600000000000000000"},"routeRateModel":{"1-10":{"UBar":"0","R0":"0","R1":"0","R2":"0"},"1-137":{"UBar":"0","R0":"0","R1":"0","R2":"0"},"1-288":{"UBar":"0","R0":"0","R1":"0","R2":"0"},"1-42161":{"UBar":"0","R0":"0","R1":"0","R2":"0"}},"transferThreshold":"0","spokeTargetBalances":{"10":{"threshold":"500000000000000000000","target":"350000000000000000000"},"137":{"target":"0","threshold":"10000000000000000000"},"42161":{"threshold":"600000000000000000000","target":"400000000000000000000"}},"uba":{"incentivePoolAdjustment": {}, "ubaRewardMultiplier": {}, "alpha":{"default":200000000000000,"1-10":0,"1-137":0,"1-42161":0},"gamma":{"default":[[500000000000000000,0],[650000000000000000,500000000000000],[750000000000000000,1000000000000000],[850000000000000000,2500000000000000],[900000000000000000,5000000000000000],[950000000000000000,50000000000000000]]},"omega":{"10":[[0,0]],"137":[[0,0]],"42161":[[0,0]],"default":[[0,0]]},"rebalance":{"10":{"threshold_lower":0,"target_lower":0,"threshold_upper":500000000000000000000,"target_upper":350000000000000000000},"137":{"threshold_lower":0,"target_lower":0,"threshold_upper":25000000000000000000,"target_upper":15000000000000000000},"42161":{"threshold_lower":0,"target_lower":0,"threshold_upper":600000000000000000000,"target_upper":400000000000000000000},"default":{"threshold_lower":0,"target_lower":0,"threshold_upper":0,"target_upper":0}}}}'
        ) as Record<string, unknown>
      )["uba"];

      const config = clients.parseUBAConfigFromOnChain(rawConfig as interfaces.UBAOnChainConfigType);
      mockedConfigStore.setUBAConfig(config);

      const ubaConfig = getUBAFeeConfig();

      expect(ubaConfig).to.not.be.undefined;
    });
  });
});
