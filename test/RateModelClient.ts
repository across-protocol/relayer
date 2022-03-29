import {
  deploySpokePoolWithToken,
  repaymentChainId,
  originChainId,
  buildPoolRebalanceLeaves,
  buildPoolRebalanceLeafTree,
} from "./utils";
import {
  assert,
  expect,
  ethers,
  Contract,
  SignerWithAddress,
  setupTokensForWallet,
  assertPromiseError,
  toBNWei,
  toWei,
} from "./utils";
import { getContractFactory, hubPoolFixture, toBN } from "./utils";
import { amountToLp, mockTreeRoot, refundProposalLiveness, totalBond } from "./constants";

import { HubPoolClient } from "../src/clients/HubPoolClient";
import { RateModelClient } from "../src/clients/RateModelClient";

let spokePool: Contract, hubPool: Contract, l2Token: Contract;
let rateModelStore: Contract, l1Token: Contract, timer: Contract, weth: Contract;
let owner: SignerWithAddress;

let rateModelClient: RateModelClient, hubPoolClient: HubPoolClient;

// Same rate model used for across-v1 tests:
// - https://github.com/UMAprotocol/protocol/blob/3b1a88ead18088e8056ecfefb781c97fce7fdf4d/packages/financial-templates-lib/test/clients/InsuredBridgeL1Client.js#L77
const sampleRateModel = {
  UBar: toWei("0.65").toString(),
  R0: toWei("0.00").toString(),
  R1: toWei("0.08").toString(),
  R2: toWei("1.00").toString(),
};

describe("RateModelClient", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spokePool, erc20: l2Token } = await deploySpokePoolWithToken(originChainId, repaymentChainId));
    ({ hubPool, timer, dai: l1Token, weth } = await hubPoolFixture());
    await hubPool.enableL1TokenForLiquidityProvision(l1Token.address);

    rateModelStore = await (await getContractFactory("RateModelStore", owner)).deploy();
    hubPoolClient = new HubPoolClient(hubPool);
    rateModelClient = new RateModelClient(rateModelStore, hubPoolClient);

    await setupTokensForWallet(spokePool, owner, [l1Token], weth, 100); // Seed owner to LP.
    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);
  });

  it("update", async function () {
    // Throws if HubPool isn't updated.
    assertPromiseError(rateModelClient.update(), "hubpool not updated");
    await hubPoolClient.update();

    // If RateModelStore has no events, stores nothing.
    await rateModelClient.update();
    expect(rateModelClient.cumulativeRateModelEvents.length).to.equal(0);

    // Add new RateModelEvents and check that updating again pulls in new events.
    await rateModelStore.updateRateModel(l1Token.address, JSON.stringify(sampleRateModel));
    await rateModelClient.update();
    expect(rateModelClient.cumulativeRateModelEvents.length).to.equal(1);
  });

  it("getRateModelForBlockNumber", async function () {
    await rateModelStore.updateRateModel(l1Token.address, JSON.stringify(sampleRateModel));
    await updateAllClients();

    const initialRateModelUpdate = (await rateModelStore.queryFilter(rateModelStore.filters.UpdatedRateModel()))[0];

    expect(
      rateModelClient.getRateModelForBlockNumber(l1Token.address, initialRateModelUpdate.blockNumber)
    ).to.deep.equal(sampleRateModel);

    // Block number when there is no rate model
    try {
      rateModelClient.getRateModelForBlockNumber(l1Token.address, initialRateModelUpdate.blockNumber - 1);
      assert(false);
    } catch (err) {
      assert.isTrue(err.message.includes("before first UpdatedRateModel event"));
    }

    // L1 token where there is no rate model
    try {
      rateModelClient.getRateModelForBlockNumber(l2Token.address, initialRateModelUpdate.blockNumber);
      assert(false);
    } catch (err) {
      assert.isTrue(err.message.includes("No updated rate model"));
    }
  });

  it("computeRealizedLpFeePct", async function () {
    await rateModelStore.updateRateModel(l1Token.address, JSON.stringify(sampleRateModel));
    await updateAllClients();

    const initialRateModelUpdate = (await rateModelStore.queryFilter(rateModelStore.filters.UpdatedRateModel()))[0];
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
    await rateModelClient.update();

    // Relayed amount being 10% of total LP amount should give exact same results as this test in v1:
    // - https://github.com/UMAprotocol/protocol/blob/3b1a88ead18088e8056ecfefb781c97fce7fdf4d/packages/financial-templates-lib/test/clients/InsuredBridgeL1Client.js#L1037
    expect(await rateModelClient.computeRealizedLpFeePct(depositData, l1Token.address)).to.equal(
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
      await rateModelClient.computeRealizedLpFeePct(
        {
          ...depositData,
          amount: toBNWei("0.0000001"),
          // Note: we need to set the deposit quote timestamp to one after the utilisation % jumped from 0% to 10%.
          // This is because the rate model uses the quote time to fetch the liquidity utilization at that quote time.
          quoteTimestamp: (await ethers.provider.getBlock("latest")).timestamp,
        },
        l1Token.address
      )
    ).to.equal(toBNWei("0.001371068779697899"));

    // Relaying 10% of pool should give exact same result as this test, which sends a relay that is 10% of the pool's
    // size when the pool is already at 60% utilization. The resulting post-relay utilization is therefore 70%.
    // - https://github.com/UMAprotocol/protocol/blob/3b1a88ead18088e8056ecfefb781c97fce7fdf4d/packages/financial-templates-lib/test/clients/InsuredBridgeL1Client.js#L1064
    expect(
      await rateModelClient.computeRealizedLpFeePct(
        {
          ...depositData,
          // Same as before, we need to use a timestamp following the `executeRootBundle` call so that we can capture
          // the current pool utilization at 10%.
          quoteTimestamp: (await ethers.provider.getBlock("latest")).timestamp,
        },
        l1Token.address
      )
    ).to.equal(toBNWei("0.002081296752280018"));
  });
});

async function updateAllClients() {
  // Note: Must update upstream clients first, for example hubPool before rateModel store
  await hubPoolClient.update();
  await rateModelClient.update();
}
