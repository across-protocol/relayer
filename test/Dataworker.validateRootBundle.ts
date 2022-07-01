import { buildFillForRepaymentChain, lastSpyLogIncludes, hre } from "./utils";
import { SignerWithAddress, expect, ethers, Contract, buildDeposit } from "./utils";
import { HubPoolClient, AcrossConfigStoreClient, SpokePoolClient, MultiCallerClient } from "../src/clients";
import { amountToDeposit, destinationChainId, BUNDLE_END_BLOCK_BUFFER } from "./constants";
import { MAX_REFUNDS_PER_RELAYER_REFUND_LEAF, MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF } from "./constants";
import { CHAIN_ID_TEST_LIST, DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import { MAX_UINT_VAL, EMPTY_MERKLE_ROOT, utf8ToHex } from "../src/utils";

// Tested
import { Dataworker } from "../src/dataworker/Dataworker";

let spy: sinon.SinonSpy;
let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract;
let l1Token_1: Contract, hubPool: Contract;
let depositor: SignerWithAddress;

let hubPoolClient: HubPoolClient, configStoreClient: AcrossConfigStoreClient;
let dataworkerInstance: Dataworker, multiCallerClient: MultiCallerClient;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let updateAllClients: () => Promise<void>;

describe("Dataworker: Validate pending root bundle", async function () {
  beforeEach(async function () {
    ({
      hubPool,
      spokePool_1,
      erc20_1,
      spokePool_2,
      configStoreClient,
      hubPoolClient,
      l1Token_1,
      depositor,
      dataworkerInstance,
      spokePoolClients,
      multiCallerClient,
      updateAllClients,
      spy,
    } = await setupDataworker(
      ethers,
      MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
      MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
      DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD,
      BUNDLE_END_BLOCK_BUFFER
    ));
  });
  it("Simple lifecycle", async function () {
    await updateAllClients();

    // Send a deposit and a fill so that dataworker builds simple roots.
    const deposit = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    await updateAllClients();
    await buildFillForRepaymentChain(spokePool_2, depositor, deposit, 0.5, destinationChainId);
    // Mine blocks so event blocks are less than latest minus buffer.
    for (let i = 0; i < BUNDLE_END_BLOCK_BUFFER; i++) await hre.network.provider.send("evm_mine");
    await updateAllClients();
    const latestBlock2 = await hubPool.provider.getBlockNumber();
    const blockRange2 = CHAIN_ID_TEST_LIST.map((_) => [0, latestBlock2]);

    // Construct expected roots before we propose new root so that last log contains logs about submitted txn.
    const expectedPoolRebalanceRoot2 = dataworkerInstance.buildPoolRebalanceRoot(blockRange2, spokePoolClients);
    dataworkerInstance.buildRelayerRefundRoot(
      blockRange2,
      spokePoolClients,
      expectedPoolRebalanceRoot2.leaves,
      expectedPoolRebalanceRoot2.runningBalances
    );
    dataworkerInstance.buildSlowRelayRoot(blockRange2, spokePoolClients);
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTransactionQueue();

    // Exit early if no pending bundle. There shouldn't be a bundle seen yet because we haven't passed enough blocks
    // beyond the block buffer.
    await dataworkerInstance.validatePendingRootBundle();
    expect(lastSpyLogIncludes(spy, "No pending proposal, nothing to validate")).to.be.true;

    // Exit early if pending bundle but challenge period has passed
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle();
    expect(lastSpyLogIncludes(spy, "Challenge period passed, cannot dispute")).to.be.true;

    // Propose new valid root bundle
    await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
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
    for (let i = 0; i < BUNDLE_END_BLOCK_BUFFER; i++) await hre.network.provider.send("evm_mine");
    await updateAllClients();
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    await multiCallerClient.executeTransactionQueue();

    // Constructs same roots as proposed root bundle
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(lastSpyLogIncludes(spy, "Pending root bundle matches with expected")).to.be.true;

    // Now let's test with some invalid root bundles:

    // Delete the proposal so we can submit invalid roots:
    await hubPool.emergencyDeleteProposal();
    await updateAllClients();
    const latestBlock4 = await hubPool.provider.getBlockNumber();
    const blockRange4 = CHAIN_ID_TEST_LIST.map((_) => [latestBlock2 + 1, latestBlock4]);
    const expectedPoolRebalanceRoot4 = dataworkerInstance.buildPoolRebalanceRoot(blockRange4, spokePoolClients);
    const expectedRelayerRefundRoot4 = dataworkerInstance.buildRelayerRefundRoot(
      blockRange4,
      spokePoolClients,
      expectedPoolRebalanceRoot4.leaves,
      expectedPoolRebalanceRoot4.runningBalances
    );
    const expectedSlowRelayRefundRoot4 = dataworkerInstance.buildSlowRelayRoot(blockRange4, spokePoolClients);

    await hubPool.proposeRootBundle(
      Array(CHAIN_ID_TEST_LIST.length).fill(await hubPool.provider.getBlockNumber()),
      expectedPoolRebalanceRoot4.leaves.length,
      expectedPoolRebalanceRoot4.tree.getHexRoot(),
      expectedRelayerRefundRoot4.tree.getHexRoot(),
      expectedSlowRelayRefundRoot4.tree.getHexRoot()
    );
    // Mine blocks so root bundle end blocks are not within latest - buffer range
    for (let i = 0; i < BUNDLE_END_BLOCK_BUFFER; i++) await hre.network.provider.send("evm_mine");
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(lastSpyLogIncludes(spy, "Pending root bundle matches with expected")).to.be.true;

    // Bundle range end blocks are too low.
    await hubPool.emergencyDeleteProposal();
    await updateAllClients();
    await hubPool.proposeRootBundle(
      Array(CHAIN_ID_TEST_LIST.length).fill(0),
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
    await multiCallerClient.executeTransactionQueue();

    // Bundle range end blocks are above latest block but within buffer, should skip.
    await updateAllClients();
    await hubPool.proposeRootBundle(
      // Since the dataworker sets the end block to latest minus buffer, setting the bundle end blocks to HEAD
      // should fall within buffer.
      Object.keys(spokePoolClients).map((chainId) => spokePoolClients[chainId].latestBlockNumber),
      expectedPoolRebalanceRoot4.leaves.length,
      expectedPoolRebalanceRoot4.tree.getHexRoot(),
      expectedRelayerRefundRoot4.tree.getHexRoot(),
      expectedSlowRelayRefundRoot4.tree.getHexRoot()
    );
    await hubPoolClient.update(); // Update only HubPool client, not spoke pool clients so we can simulate them
    // "lagging" and their latest block is behind the proposed bundle end blocks.
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(lastSpyLogIncludes(spy, "A bundle end block is > latest block but within buffer, skipping")).to.be.true;
    await updateAllClients();
    expect(hubPoolClient.hasPendingProposal()).to.equal(true);

    // Bundle range end blocks are too high, more than the buffer past latest.
    await hubPool.emergencyDeleteProposal();
    await updateAllClients();
    await hubPool.proposeRootBundle(
      Object.keys(spokePoolClients).map(
        (chainId) => spokePoolClients[chainId].latestBlockNumber + BUNDLE_END_BLOCK_BUFFER + 1
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
    await multiCallerClient.executeTransactionQueue();

    // Bundle range length doesn't match expected chain ID list.
    await updateAllClients();
    await hubPool.proposeRootBundle(
      [1],
      expectedPoolRebalanceRoot4.leaves.length,
      expectedPoolRebalanceRoot4.tree.getHexRoot(),
      expectedRelayerRefundRoot4.tree.getHexRoot(),
      expectedSlowRelayRefundRoot4.tree.getHexRoot()
    );
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle(spokePoolClients);
    expect(spy.getCall(-2).lastArg.message).to.equal("Unexpected bundle block range length, disputing");
    await multiCallerClient.executeTransactionQueue();

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
    await multiCallerClient.executeTransactionQueue();

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
    await multiCallerClient.executeTransactionQueue();

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
    await multiCallerClient.executeTransactionQueue();

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
    await multiCallerClient.executeTransactionQueue();

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
    await multiCallerClient.executeTransactionQueue();
  });
});
