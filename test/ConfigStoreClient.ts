import hre from "hardhat";
import { deploySpokePoolWithToken, repaymentChainId, originChainId, buildPoolRebalanceLeaves } from "./utils";
import { expect, ethers, Contract, SignerWithAddress, setupTokensForWallet } from "./utils";
import { toBNWei, toWei, buildPoolRebalanceLeafTree, createSpyLogger } from "./utils";
import { getContractFactory, hubPoolFixture, toBN, utf8ToHex } from "./utils";
import { amountToLp, destinationChainId, mockTreeRoot, refundProposalLiveness, totalBond } from "./constants";
import { MAX_REFUNDS_PER_RELAYER_REFUND_LEAF, MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF } from "./constants";
import { DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD } from "./constants";
import { HubPoolClient, GLOBAL_CONFIG_STORE_KEYS } from "../src/clients";
import { SpokePoolTargetBalance } from "../src/interfaces";
import { DEFAULT_CONFIG_STORE_VERSION, MockConfigStoreClient } from "./mocks";

let spokePool: Contract, hubPool: Contract, l2Token: Contract;
let configStore: Contract, l1Token: Contract, timer: Contract, weth: Contract;
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
  transferThreshold: DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD.toString(),
  spokeTargetBalances: sampleSpokeTargetBalances,
});

describe("AcrossConfigStoreClient", async function () {
  before(async function () {
    // This test can fail inexplicably due to underlying chain "stall" if it follows after another test.
    await hre.network.provider.request({ method: "hardhat_reset", params: [] });
  });

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spokePool, erc20: l2Token } = await deploySpokePoolWithToken(originChainId, repaymentChainId));
    ({ hubPool, timer, dai: l1Token, weth } = await hubPoolFixture());
    await hubPool.enableL1TokenForLiquidityProvision(l1Token.address);

    configStore = await (await getContractFactory("AcrossConfigStore", owner)).deploy();
    const receipt = await configStore.deployTransaction.wait();
    const eventSearchConfig = { fromBlock: receipt.blockNumber };
    configStoreClient = new MockConfigStoreClient(createSpyLogger().spyLogger, configStore, eventSearchConfig);
    configStoreClient.setConfigStoreVersion(0);

    await setupTokensForWallet(spokePool, owner, [l1Token], weth, 100); // Seed owner to LP.
  });

  it("update", async function () {
    // If ConfigStore has no events, stores nothing.
    await configStoreClient.update();
    expect(configStoreClient.cumulativeRateModelUpdates.length).to.equal(0);
    expect(configStoreClient.cumulativeTokenTransferUpdates.length).to.equal(0);
    expect(configStoreClient.cumulativeMaxL1TokenCountUpdates.length).to.equal(0);
    expect(configStoreClient.cumulativeMaxRefundCountUpdates.length).to.equal(0);

    // Add new TokenConfig events and check that updating again pulls in new events.
    await configStore.updateTokenConfig(l1Token.address, tokenConfigToUpdate);
    await configStoreClient.update();
    expect(configStoreClient.cumulativeRateModelUpdates.length).to.equal(1);
    expect(configStoreClient.cumulativeTokenTransferUpdates.length).to.equal(1);

    // Update ignores TokenConfig events that don't include all expected keys:
    await configStore.updateTokenConfig(l1Token.address, "gibberish");
    await configStore.updateTokenConfig(
      l1Token.address,
      JSON.stringify({ rateModel: sampleRateModel, routeRateModel: { "999-888": sampleRateModel2 } })
    );
    await configStore.updateTokenConfig(
      l1Token.address,
      JSON.stringify({ transferThreshold: DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD })
    );
    await configStoreClient.update();
    expect(configStoreClient.cumulativeRateModelUpdates.length).to.equal(1);
    expect(configStoreClient.cumulativeRouteRateModelUpdates.length).to.equal(1);
    expect(configStoreClient.cumulativeTokenTransferUpdates.length).to.equal(1);

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
    await configStore.updateGlobalConfig(utf8ToHex("gibberish"), MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF);
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

    it("computeRealizedLpFeePct", async function () {
      const hubPoolClient = new HubPoolClient(createSpyLogger().spyLogger, hubPool, configStoreClient);
      await l1Token.approve(hubPool.address, amountToLp);
      await hubPool.addLiquidity(l1Token.address, amountToLp);

      await configStore.updateTokenConfig(l1Token.address, tokenConfigToUpdate);
      await configStoreClient.update();
      await hubPoolClient.update();

      const initialRateModelUpdate = (await configStore.queryFilter(configStore.filters.UpdatedTokenConfig()))[0];
      const initialRateModelUpdateTime = (await ethers.provider.getBlock(initialRateModelUpdate.blockNumber)).timestamp;

      // Takes into account deposit amount's effect on utilization. This deposit uses 10% of the pool's liquidity
      // so the fee should reflect a 10% post deposit utilization.
      const depositData = {
        depositId: 0,
        depositor: owner.address,
        recipient: owner.address,
        originToken: l2Token.address,
        destinationToken: l1Token.address,
        realizedLpFeePct: toBN(0),
        amount: amountToLp.div(10),
        originChainId,
        destinationChainId: repaymentChainId,
        relayerFeePct: toBN(0),
        quoteTimestamp: initialRateModelUpdateTime,
        // Quote time needs to be >= first rate model event time
      };

      // Relayed amount being 10% of total LP amount should give exact same results as this test in v1:
      // - https://github.com/UMAprotocol/protocol/blob/3b1a88ead18088e8056ecfefb781c97fce7fdf4d/packages/financial-templates-lib/test/clients/InsuredBridgeL1Client.js#L1037
      expect((await hubPoolClient.computeRealizedLpFeePct(depositData, l1Token.address)).realizedLpFeePct).to.equal(
        toBNWei("0.000117987509354032")
      );

      // Next, let's increase the pool utilization from 0% to 60% by sending 60% of the pool's liquidity to
      // another chain.
      const leaves = buildPoolRebalanceLeaves(
        [repaymentChainId],
        [[l1Token.address]],
        [[toBN(0)]],
        [[amountToLp.div(10).mul(6)]], // Send 60% of total liquidity to spoke pool
        [[toBN(0)]],
        [0]
      );
      const tree = await buildPoolRebalanceLeafTree(leaves);
      await weth.approve(hubPool.address, totalBond);
      await hubPool.proposeRootBundle([1], 1, tree.getHexRoot(), mockTreeRoot, mockTreeRoot);
      await timer.setCurrentTime(Number(await timer.getCurrentTime()) + refundProposalLiveness + 1);
      await hubPool.executeRootBundle(...Object.values(leaves[0]), tree.getHexProof(leaves[0]));

      // Submit a deposit with a de minimis amount of tokens so we can isolate the computed realized lp fee % to the
      // pool utilization factor.
      expect(
        (
          await hubPoolClient.computeRealizedLpFeePct(
            {
              ...depositData,
              amount: toBNWei("0.0000001"),
              // Note: we need to set the deposit quote timestamp to one after the utilisation % jumped from 0% to 10%.
              // This is because the rate model uses the quote time to fetch the liquidity utilization at that quote time.
              quoteTimestamp: (await ethers.provider.getBlock("latest")).timestamp,
            },
            l1Token.address
          )
        ).realizedLpFeePct
      ).to.equal(toBNWei("0.001371068779697899"));

      // Relaying 10% of pool should give exact same result as this test, which sends a relay that is 10% of the pool's
      // size when the pool is already at 60% utilization. The resulting post-relay utilization is therefore 70%.
      // - https://github.com/UMAprotocol/protocol/blob/3b1a88ead18088e8056ecfefb781c97fce7fdf4d/packages/financial-templates-lib/test/clients/InsuredBridgeL1Client.js#L1064
      expect(
        (
          await hubPoolClient.computeRealizedLpFeePct(
            {
              ...depositData,
              // Same as before, we need to use a timestamp following the `executeRootBundle` call so that we can capture
              // the current pool utilization at 10%.
              quoteTimestamp: (await ethers.provider.getBlock("latest")).timestamp,
            },
            l1Token.address
          )
        ).realizedLpFeePct
      ).to.equal(toBNWei("0.002081296752280018"));
    });

    it("Get token transfer threshold for block", async function () {
      await configStore.updateTokenConfig(l1Token.address, tokenConfigToUpdate);
      await configStoreClient.update();
      const initialUpdate = (await configStore.queryFilter(configStore.filters.UpdatedTokenConfig()))[0];
      expect(configStoreClient.getTokenTransferThresholdForBlock(l1Token.address, initialUpdate.blockNumber)).to.equal(
        DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD
      );
      // Block number when there is no config
      expect(() =>
        configStoreClient.getTokenTransferThresholdForBlock(l1Token.address, initialUpdate.blockNumber - 1)
      ).to.throw(/Could not find TransferThreshold/);

      // L1 token where there is no config
      expect(() =>
        configStoreClient.getTokenTransferThresholdForBlock(l2Token.address, initialUpdate.blockNumber)
      ).to.throw(/Could not find TransferThreshold/);
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
  });
  describe("GlobalConfig", function () {
    it("Gets config store version for time", async function () {
      // Default false.
      expect(configStoreClient.hasLatestConfigStoreVersion).to.be.false;

      // Can't set first update to same value as default version:
      await configStore.updateGlobalConfig(utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.VERSION), DEFAULT_CONFIG_STORE_VERSION);
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
      await configStore.updateGlobalConfig(utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.DISABLED_CHAINS), JSON.stringify([19]));
      await configStore.updateGlobalConfig(utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.DISABLED_CHAINS), "invalid value");
      await configStore.updateGlobalConfig(
        utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.DISABLED_CHAINS),
        JSON.stringify([1.1, 21, "invalid value", 1])
      );
      await configStoreClient.update();
      const events = await configStore.queryFilter(configStore.filters.UpdatedGlobalConfig());
      const allPossibleChains = [1, 19, 21, 23];

      // When starting before first update, all chains were enabled once in range. Returns whatever is passed in as
      // `allPossibleChains`
      expect(
        configStoreClient.getEnabledChainsInBlockRange(0, events[0].blockNumber - 1, allPossibleChains)
      ).to.deep.equal(allPossibleChains);
      expect(configStoreClient.getEnabledChainsInBlockRange(0, events[2].blockNumber, allPossibleChains)).to.deep.equal(
        allPossibleChains
      );
      expect(configStoreClient.getEnabledChainsInBlockRange(0, events[0].blockNumber - 1, [])).to.deep.equal([]);

      // When calling with no to block, returns all enabled chains at from block.
      expect(configStoreClient.getEnabledChainsInBlockRange(0, undefined, allPossibleChains)).to.deep.equal(
        allPossibleChains
      );

      // When starting at first update, 19 is disabled and not re-enabled until the third update. The second
      // update is treated as a no-op since its not a valid chain ID list.
      expect(
        configStoreClient.getEnabledChainsInBlockRange(
          events[0].blockNumber,
          events[1].blockNumber - 1,
          allPossibleChains
        )
      ).to.deep.equal([1, 21, 23]);
      expect(
        configStoreClient.getEnabledChainsInBlockRange(events[0].blockNumber, events[1].blockNumber, allPossibleChains)
      ).to.deep.equal([1, 21, 23]);
      expect(
        configStoreClient.getEnabledChainsInBlockRange(
          events[0].blockNumber,
          events[2].blockNumber - 1,
          allPossibleChains
        )
      ).to.deep.equal([1, 21, 23]);
      expect(
        configStoreClient.getEnabledChainsInBlockRange(events[0].blockNumber, events[2].blockNumber, allPossibleChains)
      ).to.deep.equal(allPossibleChains);

      // When starting at second update, the initial enabled chain list doesn't include 19 since the second update
      // was a no-op.
      expect(
        configStoreClient.getEnabledChainsInBlockRange(
          events[1].blockNumber,
          events[2].blockNumber - 1,
          allPossibleChains
        )
      ).to.deep.equal([1, 21, 23]);
      expect(
        configStoreClient.getEnabledChainsInBlockRange(events[1].blockNumber, events[2].blockNumber, allPossibleChains)
      ).to.deep.equal(allPossibleChains);

      // When starting at third update, 19 is enabled and 21 is disabled.
      expect(
        configStoreClient.getEnabledChainsInBlockRange(events[2].blockNumber, events[2].blockNumber, allPossibleChains)
      ).to.deep.equal([1, 19, 23]);

      // Throws if fromBlock > toBlock
      expect(() => configStoreClient.getEnabledChainsInBlockRange(1, 0, allPossibleChains)).to.throw();

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
