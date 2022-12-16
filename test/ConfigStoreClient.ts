import { deploySpokePoolWithToken, repaymentChainId, originChainId, buildPoolRebalanceLeaves } from "./utils";
import { expect, ethers, Contract, SignerWithAddress, setupTokensForWallet } from "./utils";
import { toBNWei, toWei, buildPoolRebalanceLeafTree, createSpyLogger } from "./utils";
import { getContractFactory, hubPoolFixture, toBN, utf8ToHex } from "./utils";
import { amountToLp, destinationChainId, mockTreeRoot, refundProposalLiveness, totalBond } from "./constants";
import { MAX_REFUNDS_PER_RELAYER_REFUND_LEAF, MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF } from "./constants";
import { DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD } from "./constants";
import { HubPoolClient, AcrossConfigStoreClient, GLOBAL_CONFIG_STORE_KEYS } from "../src/clients";

let spokePool: Contract, hubPool: Contract, l2Token: Contract;
let configStore: Contract, l1Token: Contract, timer: Contract, weth: Contract;
let owner: SignerWithAddress;

let configStoreClient: AcrossConfigStoreClient, hubPoolClient: HubPoolClient;

// Same rate model used for across-v1 tests:
// - https://github.com/UMAprotocol/protocol/blob/3b1a88ead18088e8056ecfefb781c97fce7fdf4d/packages/financial-templates-lib/test/clients/InsuredBridgeL1Client.js#L77
const sampleRateModel = {
  UBar: toWei("0.65").toString(),
  R0: toWei("0.00").toString(),
  R1: toWei("0.08").toString(),
  R2: toWei("1.00").toString(),
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
  transferThreshold: DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD.toString(),
  spokeTargetBalances: sampleSpokeTargetBalances,
});

describe("AcrossConfigStoreClient", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spokePool, erc20: l2Token } = await deploySpokePoolWithToken(originChainId, repaymentChainId));
    ({ hubPool, timer, dai: l1Token, weth } = await hubPoolFixture());
    await hubPool.enableL1TokenForLiquidityProvision(l1Token.address);

    configStore = await (await getContractFactory("AcrossConfigStore", owner)).deploy();
    hubPoolClient = new HubPoolClient(
      createSpyLogger().spyLogger,
      hubPool,
      (await hubPool.provider.getNetwork()).chainId
    );
    configStoreClient = new AcrossConfigStoreClient(createSpyLogger().spyLogger, configStore, hubPoolClient);

    await setupTokensForWallet(spokePool, owner, [l1Token], weth, 100); // Seed owner to LP.
    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);
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
    await configStore.updateTokenConfig(l1Token.address, JSON.stringify({ rateModel: sampleRateModel }));
    await configStore.updateTokenConfig(
      l1Token.address,
      JSON.stringify({ transferThreshold: DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD })
    );
    await configStoreClient.update();
    expect(configStoreClient.cumulativeRateModelUpdates.length).to.equal(1);
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
      await updateAllClients();

      const initialRateModelUpdate = (await configStore.queryFilter(configStore.filters.UpdatedTokenConfig()))[0];

      expect(
        configStoreClient.getRateModelForBlockNumber(l1Token.address, initialRateModelUpdate.blockNumber)
      ).to.deep.equal(sampleRateModel);

      // Block number when there is no rate model
      expect(() =>
        configStoreClient.getRateModelForBlockNumber(l1Token.address, initialRateModelUpdate.blockNumber - 1)
      ).to.throw(/before first UpdatedRateModel event/);

      // L1 token where there is no rate model
      expect(() =>
        configStoreClient.getRateModelForBlockNumber(l2Token.address, initialRateModelUpdate.blockNumber)
      ).to.throw(/No updated rate model events for L1 token/);
    });

    it("computeRealizedLpFeePct", async function () {
      await configStore.updateTokenConfig(l1Token.address, tokenConfigToUpdate);
      await updateAllClients();

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
      await configStoreClient.update();

      // Relayed amount being 10% of total LP amount should give exact same results as this test in v1:
      // - https://github.com/UMAprotocol/protocol/blob/3b1a88ead18088e8056ecfefb781c97fce7fdf4d/packages/financial-templates-lib/test/clients/InsuredBridgeL1Client.js#L1037
      expect((await configStoreClient.computeRealizedLpFeePct(depositData, l1Token.address)).realizedLpFeePct).to.equal(
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
          await configStoreClient.computeRealizedLpFeePct(
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
          await configStoreClient.computeRealizedLpFeePct(
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
      await updateAllClients();
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

    it("Get spoke pool balance threshold for block", async function () {
      await configStore.updateTokenConfig(l1Token.address, tokenConfigToUpdate);
      await updateAllClients();
      const initialUpdate = (await configStore.queryFilter(configStore.filters.UpdatedTokenConfig()))[0];
      expect(
        configStoreClient.getSpokeTargetBalancesForBlock(l1Token.address, originChainId, initialUpdate.blockNumber)
      ).to.deep.equal({
        target: toBN(sampleSpokeTargetBalances[originChainId].target),
        threshold: toBN(sampleSpokeTargetBalances[originChainId].threshold),
      });
      // Block number when there is no config, should default to all 0s for back-compat.
      expect(
        configStoreClient.getSpokeTargetBalancesForBlock(l1Token.address, originChainId, initialUpdate.blockNumber - 1)
      ).to.deep.equal({
        target: toBN(0),
        threshold: toBN(0),
      });

      // L1 token where there is no config, should default to all 0s.
      expect(
        configStoreClient.getSpokeTargetBalancesForBlock(l2Token.address, originChainId, initialUpdate.blockNumber)
      ).to.deep.equal({
        target: toBN(0),
        threshold: toBN(0),
      });
    });
  });
  describe("GlobalConfig", function () {
    it("Get max refund count for block", async function () {
      await configStore.updateGlobalConfig(
        utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_RELAYER_REPAYMENT_LEAF_SIZE),
        MAX_REFUNDS_PER_RELAYER_REFUND_LEAF.toString()
      );
      await updateAllClients();
      const initialUpdate = (await configStore.queryFilter(configStore.filters.UpdatedGlobalConfig()))[0];
      expect(configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(initialUpdate.blockNumber)).to.equal(
        MAX_REFUNDS_PER_RELAYER_REFUND_LEAF.toString()
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
      await updateAllClients();
      const initialUpdate = (await configStore.queryFilter(configStore.filters.UpdatedGlobalConfig()))[0];
      expect(configStoreClient.getMaxL1TokenCountForPoolRebalanceLeafForBlock(initialUpdate.blockNumber)).to.equal(
        MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF.toString()
      );

      // Block number when there is no config
      expect(() =>
        configStoreClient.getMaxL1TokenCountForPoolRebalanceLeafForBlock(initialUpdate.blockNumber - 1)
      ).to.throw(/Could not find MaxL1TokenCount/);
    });
  });
});

async function updateAllClients() {
  // Note: Must update upstream clients first, for example hubPool before rateModel store
  await hubPoolClient.update();
  await configStoreClient.update();
}
