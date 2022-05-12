import { buildFillForRepaymentChain, lastSpyLogIncludes } from "./utils";
import { SignerWithAddress, expect, ethers, Contract, buildDeposit } from "./utils";
import { HubPoolClient, AcrossConfigStoreClient, SpokePoolClient, MultiCallerClient } from "../src/clients";
import { amountToDeposit, destinationChainId, originChainId } from "./constants";
import { MAX_REFUNDS_PER_RELAYER_REFUND_LEAF, MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF } from "./constants";
import { CHAIN_ID_TEST_LIST, DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import { MAX_UINT_VAL, EMPTY_MERKLE_ROOT, utf8ToHex } from "../src/utils";

// Tested
import { Dataworker } from "../src/dataworker/Dataworker";

let spy: sinon.SinonSpy;
let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
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
      erc20_2,
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
      DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD
    ));
  });
  it("Simple lifecycle", async function () {
    await updateAllClients();

    const getMostRecentLog = (_spy: sinon.SinonSpy, message: string) => {
      return spy
        .getCalls()
        .sort((logA: any, logB: any) => logB.callId - logA.callId) // Sort by callId in descending order
        .find((log: any) => log.lastArg.message.includes(message)).lastArg;
    };

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
    await updateAllClients();
    const latestBlock2 = await hubPool.provider.getBlockNumber();
    const blockRange2 = CHAIN_ID_TEST_LIST.map((_) => [0, latestBlock2]);

    // Construct expected roots before we propose new root so that last log contains logs about submitted txn.
    const expectedPoolRebalanceRoot2 = dataworkerInstance.buildPoolRebalanceRoot(blockRange2, spokePoolClients);
    dataworkerInstance.buildRelayerRefundRoot(blockRange2, spokePoolClients);
    dataworkerInstance.buildSlowRelayRoot(blockRange2, spokePoolClients);
    await dataworkerInstance.proposeRootBundle();
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTransactionQueue();

    // Exit early if no pending bundle
    await dataworkerInstance.validateRootBundle();
    expect(lastSpyLogIncludes(spy, "No pending proposal, nothing to validate")).to.be.true;

    // Exit early if pending bundle but challenge period has passed
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    await dataworkerInstance.validateRootBundle();
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
    await updateAllClients();
    await dataworkerInstance.proposeRootBundle();
    await multiCallerClient.executeTransactionQueue();

    // Constructs same roots as proposed root bundle
    await updateAllClients();
    await dataworkerInstance.validateRootBundle();
    expect(lastSpyLogIncludes(spy, "Pending root bundle matches with expected")).to.be.true;

    // Now let's test with some invalid root bundles:

    // Delete the proposal so we can submit invalid roots:
    await hubPool.emergencyDeleteProposal();
    await updateAllClients();
    const latestBlock4 = await hubPool.provider.getBlockNumber();
    const blockRange4 = CHAIN_ID_TEST_LIST.map((_) => [latestBlock2 + 1, latestBlock4]);
    const expectedPoolRebalanceRoot4 = dataworkerInstance.buildPoolRebalanceRoot(blockRange4, spokePoolClients);
    const expectedRelayerRefundRoot4 = dataworkerInstance.buildRelayerRefundRoot(blockRange4, spokePoolClients);
    const expectedSlowRelayRefundRoot4 = dataworkerInstance.buildSlowRelayRoot(blockRange4, spokePoolClients);

    await hubPool.proposeRootBundle(
      blockRange4.map((range) => range[1]),
      expectedPoolRebalanceRoot4.leaves.length,
      expectedPoolRebalanceRoot4.tree.getHexRoot(),
      expectedRelayerRefundRoot4.tree.getHexRoot(),
      expectedSlowRelayRefundRoot4.tree.getHexRoot()
    );
    await updateAllClients();
    await dataworkerInstance.validateRootBundle();
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
    await dataworkerInstance.validateRootBundle();
    expect(lastSpyLogIncludes(spy, "A bundle end block is < expected start block, submitting dispute")).to.be.true;
    await multiCallerClient.executeTransactionQueue();

    // Bundle range end blocks are too high.
    await updateAllClients();
    await hubPool.proposeRootBundle(
      blockRange4.map((range) => range[1] + 10),
      expectedPoolRebalanceRoot4.leaves.length,
      expectedPoolRebalanceRoot4.tree.getHexRoot(),
      expectedRelayerRefundRoot4.tree.getHexRoot(),
      expectedSlowRelayRefundRoot4.tree.getHexRoot()
    );
    await updateAllClients();
    await dataworkerInstance.validateRootBundle();
    expect(lastSpyLogIncludes(spy, "A bundle end block is > latest block for its chain, submitting dispute")).to.be
      .true;
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
    await dataworkerInstance.validateRootBundle();
    expect(lastSpyLogIncludes(spy, "Unexpected bundle block range length, disputing")).to.be.true;
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
    await dataworkerInstance.validateRootBundle();
    expect(lastSpyLogIncludes(spy, "Empty pool rebalance root, submitting dispute")).to.be.true;
    await multiCallerClient.executeTransactionQueue();

    // PoolRebalance leaf count is off
    await updateAllClients();
    await hubPool.proposeRootBundle(
      blockRange4.map((range) => range[1]),
      expectedPoolRebalanceRoot4.leaves.length + 1, // Wrong leaf count
      expectedPoolRebalanceRoot4.tree.getHexRoot(),
      expectedRelayerRefundRoot4.tree.getHexRoot(),
      expectedSlowRelayRefundRoot4.tree.getHexRoot()
    );
    await updateAllClients();
    await dataworkerInstance.validateRootBundle();
    expect(lastSpyLogIncludes(spy, "Unexpected pool rebalance root, submitting dispute")).to.be.true;
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
    await dataworkerInstance.validateRootBundle();
    expect(lastSpyLogIncludes(spy, "Unexpected pool rebalance root, submitting dispute")).to.be.true;
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
    await dataworkerInstance.validateRootBundle();
    expect(lastSpyLogIncludes(spy, "Unexpected relayer refund root, submitting dispute")).to.be.true;
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
    await dataworkerInstance.validateRootBundle();
    expect(lastSpyLogIncludes(spy, "Unexpected slow relay root, submitting dispute")).to.be.true;
    await multiCallerClient.executeTransactionQueue();
  });
});
