import { AcrossConfigStore } from "@across-protocol/contracts-v2";
import { constants } from "@across-protocol/sdk-v2";
import { GLOBAL_CONFIG_STORE_KEYS } from "../src/clients";
import { SpokePoolTargetBalance } from "../src/interfaces";
import {
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  destinationChainId,
} from "./constants";
import { DEFAULT_CONFIG_STORE_VERSION, MockConfigStoreClient } from "./mocks";
import {
  Contract,
  SignerWithAddress,
  createSpyLogger,
  ethers,
  expect,
  getContractFactory,
  hubPoolFixture,
  mineRandomBlocks,
  originChainId,
  toBN,
  toWei,
  utf8ToHex,
} from "./utils";

let l1Token: Contract, l2Token: Contract, configStore: AcrossConfigStore;
let owner: SignerWithAddress;
let configStoreClient: MockConfigStoreClient;

// Same rate model used for across-v1 tests:
// - https://github.com/UMAprotocol/protocol/blob/3b1a88ead18088e8056ecfefb781c97fce7fdf4d/packages/financial-templates-lib/test/clients/InsuredBridgeL1Client.js#L77
const sampleRateModel = {
  UBar: toWei("0.65").toString(),
  R0: toWei("0.00").toString(),
  R1: toWei("0.08").toString(),
  R2: toWei("1.00").toString(),
};
const sampleRateModel2 = {
  UBar: toWei("0.5").toString(),
  R0: toWei("0.00").toString(),
  R1: toWei("0.1").toString(),
  R2: toWei("0.2").toString(),
};

const sampleSpokeTargetBalances = {
  [originChainId]: {
    target: toWei("100").toString(),
    threshold: toWei("200").toString(),
  },
  [destinationChainId]: {
    target: toWei("50").toString(),
    threshold: toWei("100").toString(),
  },
};

const tokenConfigToUpdate = JSON.stringify({
  rateModel: sampleRateModel,
  routeRateModel: { "999-888": sampleRateModel2 },
  spokeTargetBalances: sampleSpokeTargetBalances,
});

describe("AcrossConfigStoreClient", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ dai: l1Token, weth: l2Token } = await hubPoolFixture());

    configStore = (await (await getContractFactory("AcrossConfigStore", owner)).deploy()) as AcrossConfigStore;
    const { blockNumber: fromBlock } = await configStore.deployTransaction.wait();
    configStoreClient = new MockConfigStoreClient(createSpyLogger().spyLogger, configStore, { fromBlock });
    configStoreClient.setConfigStoreVersion(0);
  });

  it("should properly reason about chain id indices", async function () {
    const [owner] = await ethers.getSigners();
    const configStore = (await (await getContractFactory("AcrossConfigStore", owner)).deploy()) as AcrossConfigStore;
    const { blockNumber: fromBlock } = await configStore.deployTransaction.wait();
    const configStoreClient = new MockConfigStoreClient(createSpyLogger().spyLogger, configStore, { fromBlock });
    configStoreClient.setConfigStoreVersion(0);

    // Await the first update.
    await configStoreClient.update();

    // Sanity check to verify that the config store client is updated
    expect(configStoreClient.isUpdated).to.be.true;

    // Next, we can test the case where we submit an additional chain ID to our
    // list of chain IDs.
    const eventOne = await configStore.updateGlobalConfig(
      utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.CHAIN_ID_INDICES),
      JSON.stringify([1, 10, 137, 288, 42161, 100])
    );

    // We want to ensure that enough time has passed so that
    // we can be sure that the update is far enough away
    // from the previous update.
    await mineRandomBlocks();

    // We can submit a set of chain IDs that are not perfect
    // subsets of the protocol defaults. In this case, we would
    // expect this to be ignored during our update.
    const eventTwo = await configStore.updateGlobalConfig(
      utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.CHAIN_ID_INDICES),
      JSON.stringify([10, 137, 288, 42161, 100])
    );

    // We want to ensure that enough time has passed so that
    // we can be sure that the update is far enough away
    // from the previous update.
    await mineRandomBlocks();

    // Finally, let's submit a set of chain IDs that contain
    // duplicates. In this case, we would expect this to be
    // ignored during our update.
    const eventThree = await configStore.updateGlobalConfig(
      utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.CHAIN_ID_INDICES),
      JSON.stringify([1, 10, 137, 288, 42161, 100, 10])
    );

    // We can now update our client to reflect the changes we made previously
    await configStoreClient.update();

    // We should first test the case where no Chain ID Updates have been made.
    // In this case, we should default to a set of protocol defaults as defined
    // by the UMIP (https://github.com/UMAprotocol/UMIPs/pull/590).
    expect(configStoreClient.getChainIdIndicesForBlock(0)).to.deep.equal(constants.PROTOCOL_DEFAULT_CHAIN_ID_INDICES);

    // We should now expect that after event one, we have a set of chain IDs
    // that equals the protocol defaults + 100.
    expect(configStoreClient.getChainIdIndicesForBlock(eventOne.blockNumber)).to.deep.equal([
      ...constants.PROTOCOL_DEFAULT_CHAIN_ID_INDICES,
      100,
    ]);

    // We should now expect that after event two, we have a set of chain IDs
    // that equals the protocol defaults + 100. This is because the second
    // event is invalid and should be ignored.
    expect(configStoreClient.getChainIdIndicesForBlock(eventTwo.blockNumber)).to.deep.equal([
      ...constants.PROTOCOL_DEFAULT_CHAIN_ID_INDICES,
      100,
    ]);

    // We can also check that the chain IDs haven't changed after event 3 because
    // event three is invalid as it contains duplicates.
    expect(configStoreClient.getChainIdIndicesForBlock(eventThree.blockNumber)).to.deep.equal([
      ...constants.PROTOCOL_DEFAULT_CHAIN_ID_INDICES,
      100,
    ]);
  });

  it("update", async function () {
    [owner] = await ethers.getSigners();
    ({ dai: l1Token, weth: l2Token } = await hubPoolFixture());

    configStore = (await (await getContractFactory("AcrossConfigStore", owner)).deploy()) as AcrossConfigStore;
    const { blockNumber: fromBlock } = await configStore.deployTransaction.wait();
    configStoreClient = new MockConfigStoreClient(
      createSpyLogger().spyLogger,
      configStore,
      { fromBlock },
      undefined,
      undefined,
      undefined,
      false
    );
    configStoreClient.setConfigStoreVersion(0);

    // If ConfigStore has no events, stores nothing.
    await configStoreClient.update();
    expect(configStoreClient.cumulativeRateModelUpdates.length).to.equal(0);
    expect(configStoreClient.cumulativeMaxL1TokenCountUpdates.length).to.equal(0);
    expect(configStoreClient.cumulativeMaxRefundCountUpdates.length).to.equal(0);

    // Add new TokenConfig events and check that updating again pulls in new events.
    await configStore.updateTokenConfig(l1Token.address, tokenConfigToUpdate);
    await configStoreClient.update();

    expect(configStoreClient.cumulativeRateModelUpdates.length).to.equal(1);

    // Update ignores TokenConfig events that don't include a rate model:
    await configStore.updateTokenConfig(l1Token.address, "gibberish");
    await configStore.updateTokenConfig(l1Token.address, "");
    await configStoreClient.update();
    expect(configStoreClient.cumulativeRateModelUpdates.length).to.equal(1);
    expect(configStoreClient.cumulativeRouteRateModelUpdates.length).to.equal(1);

    // Add GlobalConfig events and check that updating pulls in events
    await configStore.updateGlobalConfig(
      utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_POOL_REBALANCE_LEAF_SIZE),
      MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF.toString()
    );
    await configStore.updateGlobalConfig(
      utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_RELAYER_REPAYMENT_LEAF_SIZE),
      MAX_REFUNDS_PER_RELAYER_REFUND_LEAF.toString()
    );
    await configStoreClient.update();
    expect(configStoreClient.cumulativeMaxRefundCountUpdates.length).to.equal(1);
    expect(configStoreClient.cumulativeMaxL1TokenCountUpdates.length).to.equal(1);

    // Update ignores GlobalConfig events that have unexpected key or value type.
    await configStore.updateGlobalConfig(utf8ToHex("gibberish"), String(MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF));
    await configStore.updateGlobalConfig(utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_POOL_REBALANCE_LEAF_SIZE), "gibberish");
    await configStore.updateGlobalConfig(
      utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_RELAYER_REPAYMENT_LEAF_SIZE),
      "gibberish"
    );
    await configStoreClient.update();
    expect(configStoreClient.cumulativeMaxRefundCountUpdates.length).to.equal(1);
    expect(configStoreClient.cumulativeMaxL1TokenCountUpdates.length).to.equal(1);
  });

  describe("TokenConfig", function () {
    it("getRateModelForBlockNumber", async function () {
      await configStore.updateTokenConfig(l1Token.address, tokenConfigToUpdate);
      await configStoreClient.update();

      const initialRateModelUpdate = (await configStore.queryFilter(configStore.filters.UpdatedTokenConfig()))[0];

      // Test with and without route rate model:
      expect(
        configStoreClient.getRateModelForBlockNumber(l1Token.address, 1, 2, initialRateModelUpdate.blockNumber)
      ).to.deep.equal(sampleRateModel);
      expect(
        configStoreClient.getRateModelForBlockNumber(l1Token.address, 999, 888, initialRateModelUpdate.blockNumber)
      ).to.deep.equal(sampleRateModel2);

      // Block number when there is no rate model
      expect(() =>
        configStoreClient.getRateModelForBlockNumber(l1Token.address, 1, 2, initialRateModelUpdate.blockNumber - 1)
      ).to.throw(/before first UpdatedRateModel event/);

      // L1 token where there is no rate model
      expect(() =>
        configStoreClient.getRateModelForBlockNumber(l2Token.address, 1, 2, initialRateModelUpdate.blockNumber)
      ).to.throw(/No updated rate model events for L1 token/);
    });

    // @note: expect(...)to.deep.equals() coerces BigNumbers incorrectly and fails. Why?
    it("Get spoke pool balance threshold for block", async function () {
      await configStore.updateTokenConfig(l1Token.address, tokenConfigToUpdate);
      await configStoreClient.update();

      const initialUpdate = (await configStore.queryFilter(configStore.filters.UpdatedTokenConfig()))[0];
      let targetBalance = configStoreClient.getSpokeTargetBalancesForBlock(
        l1Token.address,
        originChainId,
        initialUpdate.blockNumber
      );
      let expectedTargetBalance: SpokePoolTargetBalance = {
        target: toBN(sampleSpokeTargetBalances[originChainId].target),
        threshold: toBN(sampleSpokeTargetBalances[originChainId].threshold),
      };
      expect(Object.keys(targetBalance).length).to.equal(Object.keys(expectedTargetBalance).length);
      Object.entries(expectedTargetBalance).forEach(([k, v]) => {
        expect(v).to.deep.equal(expectedTargetBalance[k]);
      });

      // Block number when there is no config, should default to all 0s for back-compat.
      expectedTargetBalance = { target: toBN(0), threshold: toBN(0) };
      targetBalance = configStoreClient.getSpokeTargetBalancesForBlock(
        l1Token.address,
        originChainId,
        initialUpdate.blockNumber - 1
      );
      expect(Object.keys(targetBalance).length).to.equal(Object.keys(expectedTargetBalance).length);
      Object.entries(expectedTargetBalance).forEach(([k, v]) => {
        expect(v).to.deep.equal(expectedTargetBalance[k]);
      });

      // L1 token where there is no config, should default to all 0s.
      expectedTargetBalance = { target: toBN(0), threshold: toBN(0) };
      targetBalance = configStoreClient.getSpokeTargetBalancesForBlock(
        l2Token.address,
        originChainId,
        initialUpdate.blockNumber
      );
      expect(Object.keys(targetBalance).length).to.equal(Object.keys(expectedTargetBalance).length);
      Object.entries(expectedTargetBalance).forEach(([k, v]) => {
        expect(v).to.deep.equal(expectedTargetBalance[k]);
      });
    });

    it("Get UBA fee config", async function () {
      // Can have a mix of strings and numbers in config JSON.
      const realisticConfig = {
        alpha: {
          default: "400000000000000",
          "1-10": 100000000000000,
          "1-137": 100000000000000,
          "1-42161": 100000000000000,
        },
        gamma: {
          default: [
            [500000000000000000, 0],
            [650000000000000000, "500000000000000"],
            [750000000000000000, 1000000000000000],
            ["850000000000000000", 2500000000000000],
            [900000000000000000, 5000000000000000],
            [950000000000000000, 50000000000000000],
          ],
        },
        omega: { "10": [[0, 0]], "137": [[0, 0]], "42161": [[0, 0]], default: [[0, 0]] },
        rebalance: {
          "10": { threshold_upper: 200000000, target_upper: "100000000" },
          "137": { threshold_upper: 100000000, target_upper: 0 },
          "42161": { threshold_upper: "200000000", target_upper: 100000000 },
        },
      };
      const update = JSON.stringify({
        uba: realisticConfig,
      });
      await configStore.updateTokenConfig(l1Token.address, update);
      await configStoreClient.update();
      const initialUpdate = (await configStore.queryFilter(configStore.filters.UpdatedTokenConfig()))[0];
      const parsedConfig = configStoreClient.getUBAConfig(l1Token.address, initialUpdate.blockNumber);

      // Test a few objects
      expect(parsedConfig).to.not.be.undefined;

      // This is guaranteed to be defined as the expect above would have thrown if it was undefined.
      if (parsedConfig) {
        expect(parsedConfig.rebalance["137"].threshold_upper).to.equal("100000000");
        expect(parsedConfig.gamma.default.length).to.equal(6);
      }

      // If block number is set too low, returns undefined.
      expect(configStoreClient.getUBAConfig(l1Token.address, 0)).to.be.undefined;

      // Default returns latest.
      expect(configStoreClient.getUBAConfig(l1Token.address)).to.not.be.undefined;
    });
  });
  describe("GlobalConfig", function () {
    it("Gets config store version for time", async function () {
      // Default false.
      expect(configStoreClient.hasLatestConfigStoreVersion).to.be.false;

      // Can't set first update to same value as default version:
      await configStore.updateGlobalConfig(
        utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.VERSION),
        String(DEFAULT_CONFIG_STORE_VERSION)
      );
      // Can't set update to non-integer:
      await configStore.updateGlobalConfig(utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.VERSION), "1.6");
      // Set config store version to 6, making client think it doesn't have latest version, which is 0 in SDK.
      await configStore.updateGlobalConfig(utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.VERSION), "6");
      // Client ignores updates for versions that aren't greater than the previous version.
      await configStore.updateGlobalConfig(utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.VERSION), "5");
      await configStore.updateGlobalConfig(utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.VERSION), "6");
      await configStoreClient.update();

      // There was only one legitimate update.
      expect(configStoreClient.cumulativeConfigStoreVersionUpdates.length).to.equal(1);
      expect(configStoreClient.hasLatestConfigStoreVersion).to.be.false;
      const initialUpdate = (await configStore.queryFilter(configStore.filters.UpdatedGlobalConfig()))[2];
      const initialUpdateTime = (await ethers.provider.getBlock(initialUpdate.blockNumber)).timestamp;
      expect(configStoreClient.getConfigStoreVersionForTimestamp(initialUpdateTime)).to.equal(6);

      // Time when there was no update
      expect(configStoreClient.getConfigStoreVersionForTimestamp(initialUpdateTime - 1)).to.equal(0);
    });
    it("Validate config store version", async function () {
      expect(configStoreClient.configStoreVersion).to.equal(0);

      // Local config store version matches one in contract's global config:
      configStoreClient.setConfigStoreVersion(1);
      await configStore.updateGlobalConfig(utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.VERSION), "1");
      const initialUpdate = (await configStore.queryFilter(configStore.filters.UpdatedGlobalConfig()))[0];
      const initialUpdateTime = (await ethers.provider.getBlock(initialUpdate.blockNumber)).timestamp;
      await configStoreClient.update();
      expect(configStoreClient.hasLatestConfigStoreVersion).to.be.true;
      expect(configStoreClient.hasValidConfigStoreVersionForTimestamp(initialUpdateTime)).to.equal(true);

      // Before any config store version updates, the version is always valid because the default config
      // store version returned by the client is 0.
      expect(configStoreClient.hasValidConfigStoreVersionForTimestamp(0)).to.equal(true);
      expect(configStoreClient.hasValidConfigStoreVersionForTimestamp(initialUpdateTime - 1)).to.equal(true);

      // Now pretend we downgrade the local version such that it seems we are no longer up to date:
      configStoreClient.setConfigStoreVersion(0);
      await configStoreClient.update();
      expect(configStoreClient.hasValidConfigStoreVersionForTimestamp(initialUpdateTime)).to.equal(false);

      // All previous times before the first update are still fine.
      expect(configStoreClient.hasValidConfigStoreVersionForTimestamp(0)).to.equal(true);
      expect(configStoreClient.hasValidConfigStoreVersionForTimestamp(initialUpdateTime - 1)).to.equal(true);
    });
    it("Get max refund count for block", async function () {
      await configStore.updateGlobalConfig(
        utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_RELAYER_REPAYMENT_LEAF_SIZE),
        MAX_REFUNDS_PER_RELAYER_REFUND_LEAF.toString()
      );
      await configStoreClient.update();
      const initialUpdate = (await configStore.queryFilter(configStore.filters.UpdatedGlobalConfig()))[0];
      expect(configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(initialUpdate.blockNumber)).to.equal(
        MAX_REFUNDS_PER_RELAYER_REFUND_LEAF
      );

      // Block number when there is no config
      expect(() =>
        configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(initialUpdate.blockNumber - 1)
      ).to.throw(/Could not find MaxRefundCount/);
    });
    it("Get max l1 token count for block", async function () {
      await configStore.updateGlobalConfig(
        utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_POOL_REBALANCE_LEAF_SIZE),
        MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF.toString()
      );
      await configStoreClient.update();
      const initialUpdate = (await configStore.queryFilter(configStore.filters.UpdatedGlobalConfig()))[0];
      expect(configStoreClient.getMaxL1TokenCountForPoolRebalanceLeafForBlock(initialUpdate.blockNumber)).to.equal(
        MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF
      );

      // Block number when there is no config
      expect(() =>
        configStoreClient.getMaxL1TokenCountForPoolRebalanceLeafForBlock(initialUpdate.blockNumber - 1)
      ).to.throw(/Could not find MaxL1TokenCount/);
    });
    it("Get disabled chain IDs for block range", async function () {
      // set all possible chains for the next several tests
      const allPossibleChains = [1, 19, 21, 23];
      configStoreClient.setAvailableChains(allPossibleChains);

      await configStore.updateGlobalConfig(utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.DISABLED_CHAINS), JSON.stringify([19]));
      await configStore.updateGlobalConfig(utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.DISABLED_CHAINS), "invalid value");
      await configStore.updateGlobalConfig(
        utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.DISABLED_CHAINS),
        JSON.stringify([1.1, 21, "invalid value", 1])
      );
      await configStoreClient.update();
      const events = await configStore.queryFilter(configStore.filters.UpdatedGlobalConfig());

      // When starting before first update, all chains were enabled once in range. Returns whatever is passed in as
      // `allPossibleChains`
      expect(configStoreClient.getEnabledChainsInBlockRange(0, events[0].blockNumber - 1)).to.deep.equal(
        allPossibleChains
      );
      expect(configStoreClient.getEnabledChainsInBlockRange(0, events[2].blockNumber)).to.deep.equal(allPossibleChains);

      // When calling with no to block, returns all enabled chains at from block.
      expect(configStoreClient.getEnabledChainsInBlockRange(0, undefined)).to.deep.equal(allPossibleChains);

      // Expect that calling with no available chains returns an empty array.
      configStoreClient.setAvailableChains([]);
      expect(configStoreClient.getEnabledChainsInBlockRange(0, events[0].blockNumber - 1)).to.deep.equal([]);

      // set all possible chains for the next several tests
      configStoreClient.setAvailableChains(allPossibleChains);

      // When starting at first update, 19 is disabled and not re-enabled until the third update. The second
      // update is treated as a no-op since its not a valid chain ID list.
      expect(
        configStoreClient.getEnabledChainsInBlockRange(events[0].blockNumber, events[1].blockNumber - 1)
      ).to.deep.equal([1, 21, 23]);
      expect(
        configStoreClient.getEnabledChainsInBlockRange(events[0].blockNumber, events[1].blockNumber)
      ).to.deep.equal([1, 21, 23]);
      expect(
        configStoreClient.getEnabledChainsInBlockRange(events[0].blockNumber, events[2].blockNumber - 1)
      ).to.deep.equal([1, 21, 23]);

      expect(
        configStoreClient.getEnabledChainsInBlockRange(events[0].blockNumber, events[2].blockNumber)
      ).to.deep.equal(allPossibleChains);

      // When starting at second update, the initial enabled chain list doesn't include 19 since the second update
      // was a no-op.
      expect(
        configStoreClient.getEnabledChainsInBlockRange(events[1].blockNumber, events[2].blockNumber - 1)
      ).to.deep.equal([1, 21, 23]);

      expect(
        configStoreClient.getEnabledChainsInBlockRange(events[1].blockNumber, events[2].blockNumber)
      ).to.deep.equal(allPossibleChains);

      // When starting at third update, 19 is enabled and 21 is disabled.
      expect(
        configStoreClient.getEnabledChainsInBlockRange(events[2].blockNumber, events[2].blockNumber)
      ).to.deep.equal([1, 19, 23]);

      // Throws if fromBlock > toBlock
      expect(() => configStoreClient.getEnabledChainsInBlockRange(1, 0)).to.throw();

      // Tests for `getDisabledChainsForBlock)
      expect(configStoreClient.getDisabledChainsForBlock(events[0].blockNumber)).to.deep.equal([19]);

      // Block number when there is no valid config
      expect(configStoreClient.getDisabledChainsForBlock(events[0].blockNumber - 1)).to.deep.equal([]);
      // If config store update can't parse the value then it will not count it as an update. The last known
      // value will be used.
      expect(configStoreClient.getDisabledChainsForBlock(events[1].blockNumber)).to.deep.equal([19]);
      // If update can be parsed then only the valid integers will be used. Chain ID 1 is always thrown out.
      expect(configStoreClient.getDisabledChainsForBlock(events[2].blockNumber)).to.deep.equal([21]);
    });
  });
});
