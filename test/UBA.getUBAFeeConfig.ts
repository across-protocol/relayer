import { clients, interfaces } from "@across-protocol/sdk-v2";
import { MockConfigStoreClient, MockHubPoolClient } from "./mocks";
import { ethers, createSpyLogger, hubPoolFixture, expect, deployConfigStore } from "./utils";
import { findLast, range } from "lodash";
import { L1Token } from "../src/interfaces";

describe("UBAClientUtilities.getUBAConfig", () => {
  let hubPoolClient: MockHubPoolClient;
  const validChainId = 1;
  const validToken: L1Token = {
    address: "0x0000000000000000000000000000000000000000",
    symbol: "DAI",
    decimals: 18,
  };

  function getUBAFeeConfig(
    chainId: number = validChainId,
    tokenSymbol: string = validToken.symbol,
    blockNumber?: number
  ) {
    return clients.getUBAFeeConfig(hubPoolClient, chainId, tokenSymbol, blockNumber);
  }

  beforeEach(async () => {
    const [owner] = await ethers.getSigners();
    const { spyLogger } = createSpyLogger();

    const { hubPool, dai: l1Token } = await hubPoolFixture();

    const { configStore, deploymentBlock } = await deployConfigStore(owner, [l1Token]);

    const configStoreClient = new MockConfigStoreClient(
      createSpyLogger().spyLogger,
      configStore,
      { fromBlock: deploymentBlock },
      0,
      undefined,
      undefined,
      true
    );

    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);

    hubPoolClient.addL1Token(validToken);
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
      const realisticConfigs: interfaces.UBAOnChainConfigType[] = [
        {
          alpha: {
            default: "10",
            "1-10": "100000000000000",
            "1-137": "100000000000000",
            "1-42161": "100000000000000",
          },
          gamma: {
            default: [
              ["500000000000000000", "0"],
              ["650000000000000000", "500000000000000"],
              ["750000000000000000", "1000000000000000"],
              ["850000000000000000", "2500000000000000"],
              ["900000000000000000", "5000000000000000"],
              ["950000000000000000", "50000000000000000"],
            ],
          },
          omega: { "10": [["0", "0"]], "137": [["0", "0"]], "42161": [["0", "0"]], default: [["0", "0"]] },
          rebalance: {
            "10": { threshold_upper: "200000000", target_upper: "100000000" },
            "137": { threshold_upper: "100000000", target_upper: "0" },
            "42161": { threshold_upper: "200000000", target_upper: "100000000" },
          },
        },
        {
          alpha: {
            default: "20",
            "1-10": "100000000000000",
            "1-137": "100000000000000",
            "1-42161": "100000000000000",
          },
          gamma: {
            default: [
              ["500000000000000000", "0"],
              ["650000000000000000", "500000000000000"],
              ["750000000000000000", "1000000000000000"],
              ["850000000000000000", "2500000000000000"],
              ["900000000000000000", "5000000000000000"],
              ["950000000000000000", "50000000000000000"],
            ],
          },
          omega: { "10": [["0", "0"]], "137": [["0", "0"]], "42161": [["0", "0"]], default: [["0", "0"]] },
          rebalance: {
            "10": { threshold_upper: "200000000", target_upper: "100000000" },
            "137": { threshold_upper: "100000000", target_upper: "0" },
            "42161": { threshold_upper: "200000000", target_upper: "100000000" },
          },
        },
        {
          alpha: {
            default: "30",
            "1-10": "100000000000000",
            "1-137": "100000000000000",
            "1-42161": "100000000000000",
          },
          gamma: {
            default: [
              ["500000000000000000", "0"],
              ["650000000000000000", "500000000000000"],
              ["750000000000000000", "1000000000000000"],
              ["850000000000000000", "2500000000000000"],
              ["900000000000000000", "5000000000000000"],
              ["950000000000000000", "50000000000000000"],
            ],
          },
          omega: { "10": [["0", "0"]], "137": [["0", "0"]], "42161": [["0", "0"]], default: [["0", "0"]] },
          rebalance: {
            "10": { threshold_upper: "200000000", target_upper: "100000000" },
            "137": { threshold_upper: "100000000", target_upper: "0" },
            "42161": { threshold_upper: "200000000", target_upper: "100000000" },
          },
        },
      ];

      const mockedConfigStore = hubPoolClient.configStoreClient as MockConfigStoreClient;

      const blockNumbers: number[] = [];
      for (const config of realisticConfigs) {
        const { blockNumber } = mockedConfigStore.updateTokenConfig(
          validToken.address,
          JSON.stringify({ uba: config })
        );
        blockNumbers.push(blockNumber);
        // Sleep for 1 second to ensure that the block number is different
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Find the starting and ending block range of all the block numbers
      // Add an additional 10 blocks to the end to ensure that the config is correctly resolved post update
      const startingBlock = Math.min(...blockNumbers);
      const endingBlock = Math.max(...blockNumbers) + 10;

      // Sort the configs by their respective block numbers. This is to ensure that the configs are correctly resolved
      // in the correct order
      const sortedConfigs = realisticConfigs
        .map((config, idx) => ({ config, block: blockNumbers[idx] }))
        .sort((a, b) => a.block - b.block);

      await hubPoolClient.configStoreClient.update();
      await hubPoolClient.update();

      // Ensure that their length is 3
      expect(hubPoolClient.configStoreClient.ubaConfigUpdates).to.be.lengthOf(3);

      // Iterate through 30 blocks and ensure that the config is correctly resolved
      for (const blockNumber of range(startingBlock, endingBlock)) {
        const correctConfig = findLast(sortedConfigs, ({ block }) => block <= blockNumber);
        expect(correctConfig).to.not.be.undefined;
        // Should never happen but just in case
        if (!correctConfig) {
          throw new Error("correctConfig is undefined");
        }
        const parsedConfig = clients.parseUBAFeeConfig(
          validChainId,
          validToken.symbol,
          clients.parseUBAConfigFromOnChain(correctConfig.config)
        );

        const resolvedConfig = getUBAFeeConfig(undefined, undefined, blockNumber);
        expect(resolvedConfig).to.deep.equal(parsedConfig);
      }
    });
  });
});
