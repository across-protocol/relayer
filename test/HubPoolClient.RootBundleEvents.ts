import { buildPoolRebalanceLeafTree, buildPoolRebalanceLeaves, createSpyLogger } from "./utils";
import { SignerWithAddress, expect, ethers, Contract, toBNWei } from "./utils";
import { HubPoolClient } from "../src/clients";
import * as constants from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";

let hubPool: Contract;
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
    ({ hubPool, l1Token_1, l1Token_2, dataworker } = await setupDataworker(ethers, constants.MAX_REFUNDS_PER_LEAF));
    hubPoolClient = new HubPoolClient(createSpyLogger().spyLogger, hubPool);
  });
  it("gets ProposeRootBundle event containing correct bundle block eval number", async function () {
    const { tree } = await constructSimpleTree();

    await hubPoolClient.update();

    await hubPool
      .connect(dataworker)
      .proposeRootBundle([11, 22], 2, tree.getHexRoot(), constants.mockTreeRoot, constants.mockTreeRoot);

    await hubPoolClient.update();

    // Happy case where `chainIdList` contains chain ID and block is <= than the bundle block range for that chain.
    expect(hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(22, 2, [1, 2])).to.equal(22);

    // `block` is greater than bundle block number for the chain.
    expect(() => hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(23, 2, [1, 2])).to.throw(
      /Can't find ProposeRootBundle event containing block/
    );

    // Chain ID list doesn't contain `chain`
    expect(() => hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(22, 2, [1, 3])).to.throw(
      /Can't find fill.destinationChainId in CHAIN_ID_LIST/
    );

    // Chain ID list length doesn't match bundle block range length
    expect(() => hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(22, 2, [1])).to.throw(
      /Chain ID list and bundle block eval range list length do not match/
    );
  });
});
