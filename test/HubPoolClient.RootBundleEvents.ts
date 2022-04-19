import { buildPoolRebalanceLeafTree, buildPoolRebalanceLeaves, createSpyLogger } from "./utils";
import { SignerWithAddress, expect, ethers, Contract, toBNWei } from "./utils";
import { HubPoolClient } from "../src/clients";
import * as constants from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";

let hubPool: Contract, timer: Contract;
let l1Token_1: Contract, l1Token_2: Contract;
let dataworker: SignerWithAddress;

let hubPoolClient: HubPoolClient;

async function constructSimpleTree() {
  const runningBalance = toBNWei(100);
  const netSendAmount = toBNWei(100);
  const bundleLpFees = toBNWei(1);
  const leaves = buildPoolRebalanceLeaves(
    [constants.originChainId, constants.destinationChainId], // Where funds are getting sent.
    [[l1Token_1.address, l1Token_2.address], []], // l1Token.
    [[bundleLpFees, bundleLpFees], []], // bundleLpFees.
    [[netSendAmount, netSendAmount], []], // netSendAmounts.
    [[runningBalance, runningBalance], []], // runningBalances.
    [0, 0]
  );
  const tree = await buildPoolRebalanceLeafTree(leaves);

  return { leaves, tree };
}

describe("HubPoolClient: RootBundle Events", async function () {
  beforeEach(async function () {
    ({ hubPool, l1Token_1, l1Token_2, dataworker, timer } = await setupDataworker(
      ethers,
      constants.MAX_REFUNDS_PER_LEAF
    ));
    hubPoolClient = new HubPoolClient(createSpyLogger().spyLogger, hubPool);
  });
  it("Fetches ProposeRootBundle events", async function () {
    const { tree } = await constructSimpleTree();

    await hubPoolClient.update();

    await hubPool.connect(dataworker).proposeRootBundle(
      [0, 0], // bundleEvaluationBlockNumbers used by bots to construct bundles. Length must equal the number of leaves.
      2, // poolRebalanceLeafCount.
      tree.getHexRoot(),
      constants.mockTreeRoot,
      constants.mockTreeRoot
    );

    await hubPoolClient.update();

    // TODO:
  });
  it("Fetches ExecuteRootBundle events", async function () {
    const { tree, leaves } = await constructSimpleTree();

    await hubPoolClient.update();

    await hubPool.connect(dataworker).proposeRootBundle(
      [0, 0], // bundleEvaluationBlockNumbers used by bots to construct bundles. Length must equal the number of leaves.
      2, // poolRebalanceLeafCount.
      tree.getHexRoot(),
      constants.mockTreeRoot,
      constants.mockTreeRoot
    );

    // Advance time so the request can be executed and execute first leaf.
    await timer.setCurrentTime(Number(await timer.getCurrentTime()) + constants.refundProposalLiveness + 1);
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves[0]), tree.getHexProof(leaves[0]));
    await hubPoolClient.update();

    // TODO:
  });
});
