import { HubPoolClient } from "../src/clients";
import {
  amountToLp,
  destinationChainId,
  mockTreeRoot,
  randomAddress,
  refundProposalLiveness,
  totalBond,
} from "./constants";
import { DEFAULT_CONFIG_STORE_VERSION, MockConfigStoreClient } from "./mocks";
import {
  Contract,
  SignerWithAddress,
  buildPoolRebalanceLeafTree,
  buildPoolRebalanceLeaves,
  createSpyLogger,
  deployConfigStore,
  deploySpokePoolWithToken,
  ethers,
  expect,
  hubPoolFixture,
  originChainId,
  repaymentChainId,
  setupTokensForWallet,
  toBN,
  toBNWei,
  toWei,
} from "./utils";

let configStore: Contract, hubPool: Contract;
let l1Token: Contract, l2Token: Contract, timer: Contract, weth: Contract;
let configStoreClient: MockConfigStoreClient, hubPoolClient: HubPoolClient;
let owner: SignerWithAddress;

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

describe("HubPool Utilization", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    const getNetwork = owner?.provider?.getNetwork();
    const chainId = getNetwork ? (await getNetwork).chainId : 1;

    let spokePool: Contract;
    ({ spokePool, erc20: l2Token } = await deploySpokePoolWithToken(originChainId, repaymentChainId));
    ({ hubPool, timer, dai: l1Token, weth } = await hubPoolFixture());
    await hubPool.setCrossChainContracts(1, randomAddress(), randomAddress());
    await hubPool.enableL1TokenForLiquidityProvision(l1Token.address);

    let fromBlock: number;
    ({ configStore, deploymentBlock: fromBlock } = await deployConfigStore(owner, []));
    configStoreClient = new MockConfigStoreClient(
      createSpyLogger().spyLogger,
      configStore,
      { fromBlock },
      DEFAULT_CONFIG_STORE_VERSION,
      [originChainId, repaymentChainId, 1],
      chainId,
      false
    );
    configStoreClient.setConfigStoreVersion(0);

    await setupTokensForWallet(spokePool, owner, [l1Token], weth, 100); // Seed owner to LP.
    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);
    await configStore.updateTokenConfig(l1Token.address, tokenConfigToUpdate);

    await configStoreClient.update();

    hubPoolClient = new HubPoolClient(createSpyLogger().spyLogger, hubPool, configStoreClient);
    await configStoreClient.update();
    await hubPoolClient.update();
  });

  it("computeRealizedLpFeePct", async function () {
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
      blockNumber: initialRateModelUpdate.blockNumber,
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
});
