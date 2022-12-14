import { buildFillForRepaymentChain, lastSpyLogIncludes } from "./utils";
import { SignerWithAddress, expect, ethers, Contract, buildDeposit, toBNWei } from "./utils";
import { HubPoolClient, AcrossConfigStoreClient, SpokePoolClient, MultiCallerClient } from "../src/clients";
import { amountToDeposit, destinationChainId, originChainId } from "./constants";
import { CHAIN_ID_TEST_LIST } from "./constants";
import { setupFastDataworker } from "./fixtures/Dataworker.Fixture";
import { MAX_UINT_VAL, EMPTY_MERKLE_ROOT } from "../src/utils";

// Tested
import { Dataworker } from "../src/dataworker/Dataworker";
import { getDepositPath } from "../src/utils";
import { FillWithBlock } from "../src/interfaces";

let spy: sinon.SinonSpy;
let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, hubPool: Contract;
let depositor: SignerWithAddress;

let hubPoolClient: HubPoolClient, configStoreClient: AcrossConfigStoreClient;
let dataworkerInstance: Dataworker, multiCallerClient: MultiCallerClient;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let updateAllClients: () => Promise<void>;

describe("Dataworker: Propose root bundle", async function () {
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
    } = await setupFastDataworker(ethers));
  });

  it("Simple lifecycle", async function () {
    await updateAllClients();

    const getMostRecentLog = (_spy: sinon.SinonSpy, message: string) => {
      return spy
        .getCalls()
        .sort((logA: any, logB: any) => logB.callId - logA.callId) // Sort by callId in descending order
        .find((log: any) => log.lastArg.message.includes(message)).lastArg;
    };

    // TEST 1:
    // Before submitting any spoke pool transactions, check that dataworker behaves as expected with no roots.
    const latestBlock1 = await hubPool.provider.getBlockNumber();
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    expect(lastSpyLogIncludes(spy, "No pool rebalance leaves, cannot propose")).to.be.true;
    const loadDataResults1 = getMostRecentLog(spy, "Finished loading spoke pool data");
    expect(loadDataResults1.blockRangesForChains).to.deep.equal(CHAIN_ID_TEST_LIST.map((_) => [0, latestBlock1]));

    // TEST 2:
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
    const expectedRelayerRefundRoot2 = dataworkerInstance.buildRelayerRefundRoot(
      blockRange2,
      spokePoolClients,
      expectedPoolRebalanceRoot2.leaves,
      expectedPoolRebalanceRoot2.runningBalances
    );
    const expectedSlowRelayRefundRoot2 = dataworkerInstance.buildSlowRelayRoot(blockRange2, spokePoolClients);
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    const loadDataResults2 = getMostRecentLog(spy, "Finished loading spoke pool data");
    expect(loadDataResults2.blockRangesForChains).to.deep.equal(blockRange2);
    expect(loadDataResults2.unfilledDepositsByDestinationChain).to.deep.equal({ [destinationChainId]: 1 });
    expect(loadDataResults2.depositsInRangeByOriginChain).to.deep.equal({
      [originChainId]: { [getDepositPath(deposit)]: 1 },
    });
    expect(loadDataResults2.fillsToRefundInRangeByRepaymentChain).to.deep.equal({
      [destinationChainId]: { [erc20_2.address]: 1 },
    });

    // Should have enqueued a new transaction:
    expect(lastSpyLogIncludes(spy, "Enqueing new root bundle proposal txn")).to.be.true;
    expect(spy.getCall(-1).lastArg.poolRebalanceRoot).to.equal(expectedPoolRebalanceRoot2.tree.getHexRoot());
    expect(spy.getCall(-1).lastArg.relayerRefundRoot).to.equal(expectedRelayerRefundRoot2.tree.getHexRoot());
    expect(spy.getCall(-1).lastArg.slowRelayRoot).to.equal(expectedSlowRelayRefundRoot2.tree.getHexRoot());

    // Execute queue and check that root bundle is pending:
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTransactionQueue();
    await updateAllClients();
    expect(hubPoolClient.hasPendingProposal()).to.equal(true);

    // Attempting to propose another root fails:
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    expect(lastSpyLogIncludes(spy, "Has pending proposal, cannot propose")).to.be.true;

    // Advance time and execute leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
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

    // TEST 3:
    // Submit another root bundle proposal and check bundle block range. There should be no leaves in the new range
    // yet. In the bundle block range, all chains should have increased their start block, including those without
    // pool rebalance leaves because they should use the chain's end block from the latest fully executed proposed
    // root bundle, which should be the bundle block in expectedPoolRebalanceRoot2 + 1.
    await updateAllClients();
    const latestBlock3 = await hubPool.provider.getBlockNumber();
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    const blockRange3 = [
      [latestBlock2 + 1, latestBlock3],
      [latestBlock2 + 1, latestBlock3],
      [latestBlock2 + 1, latestBlock3],
      [latestBlock2 + 1, latestBlock3],
    ];
    expect(lastSpyLogIncludes(spy, "No pool rebalance leaves, cannot propose")).to.be.true;
    const loadDataResults3 = getMostRecentLog(spy, "Finished loading spoke pool data");
    expect(loadDataResults3.blockRangesForChains).to.deep.equal(blockRange3);

    // TEST 4:
    // Submit another fill and check that dataworker proposes another root:
    await buildFillForRepaymentChain(spokePool_2, depositor, deposit, 1, destinationChainId);
    await updateAllClients();
    const latestBlock4 = await hubPool.provider.getBlockNumber();
    const blockRange4 = [
      [latestBlock2 + 1, latestBlock4],
      [latestBlock2 + 1, latestBlock4],
      [latestBlock2 + 1, latestBlock4],
      [latestBlock2 + 1, latestBlock4],
    ];
    const expectedPoolRebalanceRoot4 = dataworkerInstance.buildPoolRebalanceRoot(blockRange4, spokePoolClients);
    const expectedRelayerRefundRoot4 = dataworkerInstance.buildRelayerRefundRoot(
      blockRange4,
      spokePoolClients,
      expectedPoolRebalanceRoot4.leaves,
      expectedPoolRebalanceRoot4.runningBalances
    );

    // TEST 5:
    // Won't submit anything if the USD threshold to propose a root is set and set too high:
    await dataworkerInstance.proposeRootBundle(spokePoolClients, toBNWei("1000000"));
    expect(lastSpyLogIncludes(spy, "Root bundle USD volume does not exceed threshold, exiting early")).to.be.true;

    // TEST 4: cont.
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    const loadDataResults4 = getMostRecentLog(spy, "Finished loading spoke pool data");
    expect(loadDataResults4.blockRangesForChains).to.deep.equal(blockRange4);
    expect(loadDataResults4.unfilledDepositsByDestinationChain).to.deep.equal({});
    expect(loadDataResults4.depositsInRangeByOriginChain).to.deep.equal({});
    expect(loadDataResults4.fillsToRefundInRangeByRepaymentChain).to.deep.equal({
      [destinationChainId]: { [erc20_2.address]: 1 },
    });
    // Should have enqueued a new transaction:
    expect(lastSpyLogIncludes(spy, "Enqueing new root bundle proposal txn")).to.be.true;
    expect(spy.getCall(-1).lastArg.poolRebalanceRoot).to.equal(expectedPoolRebalanceRoot4.tree.getHexRoot());
    expect(spy.getCall(-1).lastArg.relayerRefundRoot).to.equal(expectedRelayerRefundRoot4.tree.getHexRoot());
    expect(spy.getCall(-1).lastArg.slowRelayRoot).to.equal(EMPTY_MERKLE_ROOT);

    // Should be able to look up 2 historical valid fills, even though there is 1 refund in the range.
    // This test is really important because `allValidFills` should not constrain by block range otherwise the pool
    // rebalance root can fail to be built in cases where a fill in the block range matches a deposit with a fill
    // in a previous root bundle. This would be a case where there is excess slow fill payment sent to the spoke
    // pool and we need to send some back to the hub pool, because of this fill in the current block range that
    // came after the slow fill was sent.
    const { allValidFills } = dataworkerInstance.clients.bundleDataClient.loadData(
      loadDataResults4.blockRangesForChains,
      spokePoolClients
    );
    const allValidFillsByDestinationChain = allValidFills.filter(
      (fill: FillWithBlock) => fill.destinationChainId === destinationChainId
    );
    expect(allValidFillsByDestinationChain.length).to.equal(2);

    // Execute queue and check that root bundle is pending:
    await multiCallerClient.executeTransactionQueue();
    await updateAllClients();
    expect(hubPoolClient.hasPendingProposal()).to.equal(true);

    // Check that the cache is cleared.
    expect(dataworkerInstance.rootCache).to.not.deep.equal({});
    dataworkerInstance.clearCache();
    expect(dataworkerInstance.rootCache).to.deep.equal({});
  });
});
