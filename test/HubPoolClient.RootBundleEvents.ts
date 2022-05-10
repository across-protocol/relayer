import { buildPoolRebalanceLeafTree, buildPoolRebalanceLeaves, createSpyLogger, randomAddress } from "./utils";
import { SignerWithAddress, expect, ethers, Contract, toBNWei, toBN, BigNumber, hre } from "./utils";
import { HubPoolClient } from "../src/clients";
import * as constants from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";

let hubPool: Contract, timer: Contract;
let l1Token_1: Contract, l1Token_2: Contract;
let dataworker: SignerWithAddress, owner: SignerWithAddress;

let hubPoolClient: HubPoolClient;

async function constructSimpleTree(runningBalance: BigNumber) {
  const netSendAmount = runningBalance.mul(toBN(-1));
  const bundleLpFees = toBNWei(1);
  const leaves = buildPoolRebalanceLeaves(
    [constants.originChainId, constants.destinationChainId], // Where funds are getting sent.
    [[l1Token_1.address, l1Token_2.address], [l1Token_2.address]], // l1Token.
    [[bundleLpFees, bundleLpFees.mul(toBN(2))], [bundleLpFees.mul(toBN(2))]], // bundleLpFees.
    [[netSendAmount, netSendAmount.mul(toBN(2))], [netSendAmount.mul(toBN(2))]], // netSendAmounts.
    [[runningBalance, runningBalance.mul(toBN(2))], [runningBalance.mul(toBN(3))]], // runningBalances.
    [0, 0] // groupId. Doesn't matter for this test.
  );

  const tree = await buildPoolRebalanceLeafTree(leaves);
  return { leaves, tree };
}

describe("HubPoolClient: RootBundle Events", async function () {
  beforeEach(async function () {
    ({ hubPool, l1Token_1, l1Token_2, dataworker, timer, owner } = await setupDataworker(
      ethers,
      constants.MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
      constants.MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
      constants.DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD
    ));
    hubPoolClient = new HubPoolClient(createSpyLogger().spyLogger, hubPool);
  });
  it("gets ProposeRootBundle event containing correct bundle block eval number", async function () {
    const { tree } = await constructSimpleTree(toBNWei(100));

    await hubPoolClient.update();

    await hubPool
      .connect(dataworker)
      .proposeRootBundle([11, 22], 2, tree.getHexRoot(), constants.mockTreeRoot, constants.mockTreeRoot);

    expect(hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(22, 2, [1, 2])).to.equal(undefined);
    await hubPoolClient.update();

    // Happy case where `chainIdList` contains chain ID and block is <= than the bundle block range for that chain.
    expect(hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(22, 2, [1, 2])).to.equal(22);

    // `block` is greater than bundle block number for the chain.
    expect(hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(23, 2, [1, 2])).to.equal(undefined);

    // Chain ID list doesn't contain `chain`
    expect(() => hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(22, 2, [1, 3])).to.throw(
      /Can't find chainId/
    );

    // Chain ID list length doesn't match bundle block range length
    expect(() => hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(22, 2, [1])).to.throw(
      /Chain ID list and bundle block eval range list length do not match/
    );
  });
  it("gets most recent RootBundleExecuted event for chainID and L1 token", async function () {
    const { tree: tree1, leaves: leaves1 } = await constructSimpleTree(toBNWei(100));
    const { tree: tree2, leaves: leaves2 } = await constructSimpleTree(toBNWei(200));

    await hubPoolClient.update();

    // Propose one root bundle with two leaves for two different L2 chains.
    await hubPool
      .connect(dataworker)
      .proposeRootBundle([11, 22], 2, tree1.getHexRoot(), constants.mockTreeRoot, constants.mockTreeRoot);
    await timer.setCurrentTime(Number(await timer.getCurrentTime()) + constants.refundProposalLiveness + 1);
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves1[0]), tree1.getHexProof(leaves1[0]));
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves1[1]), tree1.getHexProof(leaves1[1]));
    const firstRootBundleBlockNumber = await hubPool.provider.getBlockNumber();

    expect(
      hubPoolClient.getRunningBalanceBeforeBlockForChain(
        firstRootBundleBlockNumber,
        constants.originChainId,
        l1Token_1.address
      )
    ).to.equal(toBN(0));
    await hubPoolClient.update();

    // Happy case where client returns most recent running balance for chain ID and l1 token.
    expect(
      hubPoolClient.getRunningBalanceBeforeBlockForChain(
        firstRootBundleBlockNumber,
        constants.originChainId,
        l1Token_1.address
      )
    ).to.equal(toBNWei(100));

    // Target block is before event.
    expect(hubPoolClient.getRunningBalanceBeforeBlockForChain(0, constants.originChainId, l1Token_1.address)).to.equal(
      toBN(0)
    );

    // chain ID and L1 token combination not found.
    expect(
      hubPoolClient.getRunningBalanceBeforeBlockForChain(
        firstRootBundleBlockNumber,
        constants.destinationChainId,
        l1Token_1.address
      )
    ).to.equal(toBN(0));
    expect(
      hubPoolClient.getRunningBalanceBeforeBlockForChain(
        firstRootBundleBlockNumber,
        constants.originChainId,
        timer.address
      )
    ).to.equal(toBN(0));

    // Running balance at index of L1 token returned:
    expect(
      hubPoolClient.getRunningBalanceBeforeBlockForChain(
        firstRootBundleBlockNumber,
        constants.originChainId,
        l1Token_2.address
      )
    ).to.equal(toBNWei(200));

    // Propose and execute another root bundle:
    await hubPool
      .connect(dataworker)
      .proposeRootBundle([11, 22], 2, tree2.getHexRoot(), constants.mockTreeRoot, constants.mockTreeRoot);
    await timer.setCurrentTime(Number(await timer.getCurrentTime()) + constants.refundProposalLiveness + 1);
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves2[0]), tree2.getHexProof(leaves2[0]));
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves2[1]), tree2.getHexProof(leaves2[1]));
    const secondRootBundleBlockNumber = await hubPool.provider.getBlockNumber();
    await hubPoolClient.update();

    // Grabs most up to date running balance for block:
    expect(
      hubPoolClient.getRunningBalanceBeforeBlockForChain(
        secondRootBundleBlockNumber,
        constants.originChainId,
        l1Token_1.address
      )
    ).to.equal(toBNWei(200)); // Grabs second running balance
    expect(
      hubPoolClient.getRunningBalanceBeforeBlockForChain(
        firstRootBundleBlockNumber,
        constants.originChainId,
        l1Token_1.address
      )
    ).to.equal(toBNWei(100)); // Grabs first running balance
  });
  it("returns next root bundle start block", async function () {
    const { tree: tree1, leaves: leaves1 } = await constructSimpleTree(toBNWei(100));
    const { tree: tree2, leaves: leaves2 } = await constructSimpleTree(toBNWei(100));

    await hubPoolClient.update();

    // Propose one root bundle with two leaves for two different L2 chains.
    const bundleBlockEvalNumbers = [11, 22];
    await hubPool
      .connect(dataworker)
      .proposeRootBundle(bundleBlockEvalNumbers, 2, tree1.getHexRoot(), constants.mockTreeRoot, constants.mockTreeRoot);
    const proposalBlockNumber = await hubPool.provider.getBlockNumber();

    // Mine blocks so proposal and execution are at different blocks, so we can test what happens if either is not
    // found.
    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_mine");

    await timer.setCurrentTime(Number(await timer.getCurrentTime()) + constants.refundProposalLiveness + 1);
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves1[0]), tree1.getHexProof(leaves1[0]));
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves1[1]), tree1.getHexProof(leaves1[1]));
    const executionBlockNumber = await hubPool.provider.getBlockNumber();

    const chainIdList = [leaves1[0].chainId.toNumber(), leaves1[1].chainId.toNumber()];

    // Default case when client is unaware of events pre-update.
    expect(hubPoolClient.getNextBundleStartBlockNumber(chainIdList, executionBlockNumber, chainIdList[0])).to.equal(0);
    await hubPoolClient.update();

    // Mine more blocks and Propose and execute another root bundle:
    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_mine");

    const secondBundleBlockEvalNumbers = [66, 77];
    await hubPool
      .connect(dataworker)
      .proposeRootBundle([66, 77], 2, tree2.getHexRoot(), constants.mockTreeRoot, constants.mockTreeRoot);
    await timer.setCurrentTime(Number(await timer.getCurrentTime()) + constants.refundProposalLiveness + 1);
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves2[0]), tree2.getHexProof(leaves2[0]));
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves2[1]), tree2.getHexProof(leaves2[1]));
    const secondExecutionBlockNumber = await hubPool.provider.getBlockNumber();
    await hubPoolClient.update();

    // Happy case, latest block is equal to or greater than execution block number, returns bundle eval block + 1
    // for chain at correct index.
    for (const chain of chainIdList) {
      expect(hubPoolClient.getNextBundleStartBlockNumber(chainIdList, secondExecutionBlockNumber, chain)).to.equal(
        secondBundleBlockEvalNumbers[chainIdList.indexOf(chain)] + 1
      );
      expect(hubPoolClient.getNextBundleStartBlockNumber(chainIdList, executionBlockNumber, chain)).to.equal(
        bundleBlockEvalNumbers[chainIdList.indexOf(chain)] + 1
      );
    }

    // No ExecuteRootBundle events before block.
    expect(hubPoolClient.getNextBundleStartBlockNumber(chainIdList, proposalBlockNumber, chainIdList[0])).to.equal(0);

    // No ProposeRootBundle events before block.
    expect(hubPoolClient.getNextBundleStartBlockNumber(chainIdList, 0, chainIdList[0])).to.equal(0);
  });
  it("gets most recent CrossChainContractsSet event for chainID", async function () {
    const adapter = randomAddress();
    const spokePool1 = randomAddress();
    const spokePool2 = randomAddress();
    await hubPool.connect(owner).setCrossChainContracts([11], adapter, spokePool1);
    const firstUpdateBlockNumber = await hubPool.provider.getBlockNumber();
    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_mine");
    await hubPool.connect(owner).setCrossChainContracts([11], adapter, spokePool2);
    const secondUpdateBlockNumber = await hubPool.provider.getBlockNumber();

    // Default case when there are no events for a chain.
    expect(() => hubPoolClient.getSpokePoolForBlock(firstUpdateBlockNumber, 11)).to.throw(
      /No cross chain contracts set/
    );
    await hubPoolClient.update();

    // Happy case where latest spoke pool at block is returned
    expect(hubPoolClient.getSpokePoolForBlock(firstUpdateBlockNumber, 11)).to.equal(spokePool1);
    expect(hubPoolClient.getSpokePoolForBlock(secondUpdateBlockNumber, 11)).to.equal(spokePool2);

    // Chain has events but none before block
    expect(() => hubPoolClient.getSpokePoolForBlock(firstUpdateBlockNumber - 1, 11)).to.throw(
      /No cross chain contract found before block/
    );
  });
});
