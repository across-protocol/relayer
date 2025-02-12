import hre from "hardhat";
import { HubPoolClient, MultiCallerClient, SpokePoolClient } from "../src/clients";
import { EMPTY_MERKLE_ROOT, MAX_UINT_VAL, utf8ToHex } from "../src/utils";
import {
  BUNDLE_END_BLOCK_BUFFER,
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  amountToDeposit,
  destinationChainId,
} from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import {
  Contract,
  createRandomBytes32,
  SignerWithAddress,
  ethers,
  expect,
  lastSpyLogIncludes,
  lastSpyLogLevel,
  sinon,
  spyLogIncludes,
  depositV3,
  fillV3Relay,
} from "./utils";

// Tested
import { Dataworker } from "../src/dataworker/Dataworker";
import { MockConfigStoreClient } from "./mocks";

let spy: sinon.SinonSpy;
let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, hubPool: Contract, configStore: Contract;
let depositor: SignerWithAddress, dataworker: SignerWithAddress;

let hubPoolClient: HubPoolClient, configStoreClient: MockConfigStoreClient;
let dataworkerInstance: Dataworker, multiCallerClient: MultiCallerClient;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let updateAllClients: () => Promise<void>;

describe("Dataworker: Validate pending root bundle", async function () {
  beforeEach(async function () {
    ({
      hubPool,
      spokePool_1,
      erc20_1,
      erc20_2,
      spokePool_2,
      mockedConfigStoreClient: configStoreClient,
      configStore,
      hubPoolClient,
      l1Token_1,
      depositor,
      dataworker,
      dataworkerInstance,
      spokePoolClients,
      multiCallerClient,
      updateAllClients,
      spy,
    } = await setupDataworker(
      ethers,
      MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
      MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
      BUNDLE_END_BLOCK_BUFFER
    ));
  });
  it("Simple lifecycle", async function () {
    await updateAllClients();

    // Send a deposit and a fill so that dataworker builds simple roots.
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    await updateAllClients();
    await fillV3Relay(spokePool_2, deposit, depositor, destinationChainId);
    // Mine blocks so event blocks are less than latest minus buffer.
    for (let i = 0; i < BUNDLE_END_BLOCK_BUFFER; i++) {
      await hre.network.provider.send("evm_mine");
    }
    await updateAllClients();
    const latestBlock2 = await hubPool.provider.getBlockNumber();
    const blockRange2 = Object.keys(spokePoolClients).map(() => [0, latestBlock2]);

    // Construct expected roots before we propose new root so that last log contains logs about submitted txn.
    const expectedPoolRebalanceRoot2 = await dataworkerInstance.buildPoolRebalanceRoot(blockRange2, spokePoolClients);
    await dataworkerInstance.buildRelayerRefundRoot(
      blockRange2,
      spokePoolClients,
      expectedPoolRebalanceRoot2.leaves,
      expectedPoolRebalanceRoot2.runningBalances
    );
    await dataworkerInstance.buildSlowRelayRoot(blockRange2, spokePoolClients);
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTxnQueues();

    // Exit early if no pending bundle. There shouldn't be a bundle seen yet because we haven't passed enough blocks
    // beyond the block buffer.
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(lastSpyLogIncludes(spy, "No pending proposal, nothing to validate")).to.be.true;

    // Exit early if pending bundle but challenge period has passed
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(lastSpyLogIncludes(spy, "Challenge period passed, cannot dispute")).to.be.true;

    // Propose new valid root bundle
    await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    for (const leaf of expectedPoolRebalanceRoot2.leaves) {
      await hubPool.executeRootBundle(
        leaf.chainId,
        leaf.groupIndex,
        leaf.bundleLpFees,
        leaf.netSendAmounts,
        leaf.runningBalances,
        leaf.leafId,
        leaf.l1Tokens,
        expectedPoolRebalanceRoot2.tree.getHexProof(leaf)
      );
    }
    for (let i = 0; i < BUNDLE_END_BLOCK_BUFFER; i++) {
      await hre.network.provider.send("evm_mine");
    }
    await updateAllClients();
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    await multiCallerClient.executeTxnQueues();

    // Constructs same roots as proposed root bundle
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(lastSpyLogIncludes(spy, "Pending root bundle matches with expected")).to.be.true;

    // Now let's test with some invalid root bundles:

    // Delete the proposal so we can submit invalid roots:
    await hubPool.emergencyDeleteProposal();
    await updateAllClients();
    const latestBlock4 = await hubPool.provider.getBlockNumber();
    const blockRange4 = Object.keys(spokePoolClients).map(() => [latestBlock2 + 1, latestBlock4]);
    const expectedPoolRebalanceRoot4 = await dataworkerInstance.buildPoolRebalanceRoot(blockRange4, spokePoolClients);
    const expectedRelayerRefundRoot4 = await dataworkerInstance.buildRelayerRefundRoot(
      blockRange4,
      spokePoolClients,
      expectedPoolRebalanceRoot4.leaves,
      expectedPoolRebalanceRoot4.runningBalances
    );
    const expectedSlowRelayRefundRoot4 = await dataworkerInstance.buildSlowRelayRoot(blockRange4, spokePoolClients);

    await hubPool.proposeRootBundle(
      Array(Object.keys(spokePoolClients).length).fill(await hubPool.provider.getBlockNumber()),
      expectedPoolRebalanceRoot4.leaves.length,
      expectedPoolRebalanceRoot4.tree.getHexRoot(),
      expectedRelayerRefundRoot4.tree.getHexRoot(),
      expectedSlowRelayRefundRoot4.tree.getHexRoot()
    );
    // Mine blocks so root bundle end blocks are not within latest - buffer range
    for (let i = 0; i < BUNDLE_END_BLOCK_BUFFER; i++) {
      await hre.network.provider.send("evm_mine");
    }
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(lastSpyLogIncludes(spy, "Pending root bundle matches with expected")).to.be.true;

    // Bundle range end blocks are too low.
    await hubPool.emergencyDeleteProposal();
    await updateAllClients();
    await hubPool.proposeRootBundle(
      Array(Object.keys(spokePoolClients).length).fill(0),
      expectedPoolRebalanceRoot4.leaves.length,
      expectedPoolRebalanceRoot4.tree.getHexRoot(),
      expectedRelayerRefundRoot4.tree.getHexRoot(),
      expectedSlowRelayRefundRoot4.tree.getHexRoot()
    );
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(spy.getCall(-2).lastArg.message).to.equal(
      "A bundle end block is < expected start block, submitting dispute"
    );
    await multiCallerClient.executeTxnQueues();

    // Bundle range end blocks are above latest block but within buffer, should skip.
    await updateAllClients();
    await hubPool.proposeRootBundle(
      // Since the dataworker sets the end block to latest minus buffer, setting the bundle end blocks to HEAD
      // should fall within buffer.
      Object.keys(spokePoolClients).map((chainId) => spokePoolClients[chainId].latestBlockSearched),
      expectedPoolRebalanceRoot4.leaves.length,
      expectedPoolRebalanceRoot4.tree.getHexRoot(),
      expectedRelayerRefundRoot4.tree.getHexRoot(),
      expectedSlowRelayRefundRoot4.tree.getHexRoot()
    );
    await hubPoolClient.update(); // Update only HubPool client, not spoke pool clients so we can simulate them
    // "lagging" and their latest block is behind the proposed bundle end blocks.
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(spyLogIncludes(spy, -2, "Cannot validate because a bundle end block is > latest block but within buffer")).to
      .be.true;
    expect(lastSpyLogIncludes(spy, "Skipping dispute")).to.be.true;

    await updateAllClients();
    expect(hubPoolClient.hasPendingProposal()).to.equal(true);

    // Bundle range end blocks are too high, more than the buffer past latest.
    await hubPool.emergencyDeleteProposal();
    await updateAllClients();
    await hubPool.proposeRootBundle(
      Object.keys(spokePoolClients).map(
        (chainId) => spokePoolClients[chainId].latestBlockSearched + BUNDLE_END_BLOCK_BUFFER + 1
      ),
      expectedPoolRebalanceRoot4.leaves.length,
      expectedPoolRebalanceRoot4.tree.getHexRoot(),
      expectedRelayerRefundRoot4.tree.getHexRoot(),
      expectedSlowRelayRefundRoot4.tree.getHexRoot()
    );
    await hubPoolClient.update();
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(spy.getCall(-2).lastArg.message).to.equal(
      "A bundle end block is > latest block + buffer for its chain, submitting dispute"
    );
    await multiCallerClient.executeTxnQueues();

    // Bundle range length doesn't match expected chain ID list.
    await updateAllClients();
    await hubPool.proposeRootBundle(
      // @todo: XXX Confirm the intent of this!
      Array(Object.keys(spokePoolClients).length).fill(1).concat(1), // Add an extra chain.
      expectedPoolRebalanceRoot4.leaves.length,
      expectedPoolRebalanceRoot4.tree.getHexRoot(),
      expectedRelayerRefundRoot4.tree.getHexRoot(),
      expectedSlowRelayRefundRoot4.tree.getHexRoot()
    );
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(spy.getCall(-2).lastArg.message).to.equal("Unexpected bundle block range length, disputing");
    await multiCallerClient.executeTxnQueues();

    // PoolRebalance root is empty
    await updateAllClients();
    await hubPool.proposeRootBundle(
      blockRange4.map((range) => range[1] + 10),
      expectedPoolRebalanceRoot4.leaves.length,
      EMPTY_MERKLE_ROOT,
      expectedRelayerRefundRoot4.tree.getHexRoot(),
      expectedSlowRelayRefundRoot4.tree.getHexRoot()
    );
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(spy.getCall(-2).lastArg.message).to.equal("Empty pool rebalance root, submitting dispute");
    await multiCallerClient.executeTxnQueues();

    // PoolRebalance leaf count is too high
    await updateAllClients();
    await hubPool.proposeRootBundle(
      blockRange4.map((range) => range[1]),
      expectedPoolRebalanceRoot4.leaves.length + 1, // Dataworker expects 1 fewer leaf than actually pending, meaning
      // that the unclaimed leaf count can never drop to 0.
      expectedPoolRebalanceRoot4.tree.getHexRoot(),
      expectedRelayerRefundRoot4.tree.getHexRoot(),
      expectedSlowRelayRefundRoot4.tree.getHexRoot()
    );
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(spy.getCall(-2).lastArg.message).to.equal("Unexpected pool rebalance root, submitting dispute");
    await multiCallerClient.executeTxnQueues();

    // PoolRebalance root is off
    await updateAllClients();
    await hubPool.proposeRootBundle(
      blockRange4.map((range) => range[1]),
      expectedPoolRebalanceRoot4.leaves.length,
      utf8ToHex("BogusRoot"),
      expectedRelayerRefundRoot4.tree.getHexRoot(),
      expectedSlowRelayRefundRoot4.tree.getHexRoot()
    );
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(spy.getCall(-2).lastArg.message).to.equal("Unexpected pool rebalance root, submitting dispute");
    await multiCallerClient.executeTxnQueues();

    // RelayerRefund root is off
    await updateAllClients();
    await hubPool.proposeRootBundle(
      blockRange4.map((range) => range[1]),
      expectedPoolRebalanceRoot4.leaves.length,
      expectedPoolRebalanceRoot4.tree.getHexRoot(),
      utf8ToHex("BogusRoot"),
      expectedSlowRelayRefundRoot4.tree.getHexRoot()
    );
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(spy.getCall(-2).lastArg.message).to.equal("Unexpected relayer refund root, submitting dispute");
    await multiCallerClient.executeTxnQueues();

    // SlowRelay root is off
    await updateAllClients();
    await hubPool.proposeRootBundle(
      blockRange4.map((range) => range[1]),
      expectedPoolRebalanceRoot4.leaves.length,
      expectedPoolRebalanceRoot4.tree.getHexRoot(),
      expectedRelayerRefundRoot4.tree.getHexRoot(),
      utf8ToHex("BogusRoot")
    );
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(spy.getCall(-2).lastArg.message).to.equal("Unexpected slow relay root, submitting dispute");
    await multiCallerClient.executeTxnQueues();
  });
  it("Validates root bundle with large bundleEvaluationBlockNumbers", async function () {
    await updateAllClients();

    // propose root bundle with larger bundleEvaluationBlockNumbers than blockNumber.toNumber() can handle.
    // This simulates a DOS attack vector on the HubPoolClient's ability to parse a pending proposal.
    await hubPool
      .connect(dataworker)
      .proposeRootBundle(
        ["0x" + "ff".repeat(32)],
        1,
        "0x" + "00".repeat(32),
        "0x" + "00".repeat(32),
        "0x" + "00".repeat(32)
      );

    let success = false;
    try {
      await updateAllClients();
      success = true;
      // eslint-disable-next-line no-empty
    } catch {}

    expect(success).to.be.true;
  });
  it("Exits early if config store version is out of date", async function () {
    // Propose trivial bundle.
    await updateAllClients();

    const latestBlock = await hubPool.provider.getBlockNumber();
    await hubPool.connect(dataworker).proposeRootBundle(
      Object.keys(spokePoolClients).map(() => latestBlock),
      Object.keys(spokePoolClients).length,
      createRandomBytes32(),
      createRandomBytes32(),
      createRandomBytes32()
    );
    await updateAllClients();

    // Set up test so that the latest version in the config store contract is higher than
    // the version in the config store client.
    await configStore.updateGlobalConfig(utf8ToHex("VERSION"), "3");
    configStoreClient.setConfigStoreVersion(1);
    await updateAllClients();
    // Mine blocks so root bundle end blocks are not within latest - buffer range
    for (let i = 0; i < BUNDLE_END_BLOCK_BUFFER; i++) {
      await hre.network.provider.send("evm_mine");
    }
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);

    expect(lastSpyLogIncludes(spy, "Skipping dispute")).to.be.true;
    expect(spy.getCall(-1).lastArg.reason).to.equal("out-of-date-config-store-version");
    expect(lastSpyLogLevel(spy)).to.equal("error");
  });
});
