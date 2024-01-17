import assert from "assert";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { Dataworker } from "../src/dataworker/Dataworker";
import { HubPoolClient, MultiCallerClient, SpokePoolClient } from "../src/clients";
import { Deposit, FillWithBlock } from "../src/interfaces";
import { EMPTY_MERKLE_ROOT, MAX_UINT_VAL, getDepositPath } from "../src/utils";
import { CHAIN_ID_TEST_LIST, amountToDeposit, destinationChainId, originChainId, utf8ToHex } from "./constants";
import { setupFastDataworker } from "./fixtures/Dataworker.Fixture";
import {
  Contract,
  SignerWithAddress,
  buildDeposit,
  buildFill,
  buildFillForRepaymentChain,
  ethers,
  expect,
  lastSpyLogIncludes,
  lastSpyLogLevel,
  setupTokensForWallet,
  sinon,
  toBNWei,
} from "./utils";
// Tested
import { MockConfigStoreClient } from "./mocks";

class TestSpokePoolClient extends SpokePoolClient {
  deleteDeposit(depositId: number): void {
    const depositHash = this.getDepositHash({ depositId, originChainId: this.chainId });
    delete this.depositHashes[depositHash];
  }

  // Delete the first fill matching the pair of originChainId and depositId.
  deleteFill(originChainId: number, depositId: number): void {
    const fills = this.fills[originChainId];
    const depositIdx = fills
      .map((fill) => `${fill.originChainId}-${fill.depositId}`)
      .indexOf(`${originChainId}-${depositId}`);
    assert(depositIdx !== -1);

    this.fills[originChainId].splice(depositIdx, 1);
  }
}

let spy: sinon.SinonSpy;
let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, hubPool: Contract, configStore: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress;

let hubPoolClient: HubPoolClient, configStoreClient: MockConfigStoreClient;
let dataworkerInstance: Dataworker, multiCallerClient: MultiCallerClient;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let updateAllClients: () => Promise<void>;

describe("Dataworker: Propose root bundle", async function () {
  beforeEach(async function () {
    ({
      relayer,
      hubPool,
      spokePool_1,
      erc20_1,
      spokePool_2,
      erc20_2,
      mockedConfigStoreClient: configStoreClient,
      configStore,
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
        .sort((logA: unknown, logB: unknown) => logB["callId"] - logA["callId"]) // Sort by callId in descending order
        .find((log: unknown) => log["lastArg"]["message"].includes(message)).lastArg;
    };

    // TEST 1:
    // Before submitting any spoke pool transactions, check that dataworker behaves as expected with no roots.
    const latestBlock1 = await hubPool.provider.getBlockNumber();
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    expect(lastSpyLogIncludes(spy, "No pool rebalance leaves, cannot propose")).to.be.true;
    const loadDataResults1 = getMostRecentLog(spy, "Finished loading spoke pool data");
    expect(loadDataResults1.blockRangesForChains).to.deep.equal(CHAIN_ID_TEST_LIST.map(() => [0, latestBlock1]));

    // TEST 2:
    // Send a deposit and a fill so that dataworker builds simple roots.
    const deposit = await buildDeposit(
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
    const blockRange2 = CHAIN_ID_TEST_LIST.map(() => [0, latestBlock2]);

    // Construct expected roots before we propose new root so that last log contains logs about submitted txn.
    const expectedPoolRebalanceRoot2 = await dataworkerInstance.buildPoolRebalanceRoot(blockRange2, spokePoolClients);
    const expectedRelayerRefundRoot2 = await dataworkerInstance.buildRelayerRefundRoot(
      blockRange2,
      spokePoolClients,
      expectedPoolRebalanceRoot2.leaves,
      expectedPoolRebalanceRoot2.runningBalances
    );
    const expectedSlowRelayRefundRoot2 = await dataworkerInstance.buildSlowRelayRoot(blockRange2, spokePoolClients);
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
    const expectedPoolRebalanceRoot4 = await dataworkerInstance.buildPoolRebalanceRoot(blockRange4, spokePoolClients);
    const expectedRelayerRefundRoot4 = await dataworkerInstance.buildRelayerRefundRoot(
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
    const { allValidFills } = await dataworkerInstance.clients.bundleDataClient.loadData(
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
  it("Exits early if config store version is out of date", async function () {
    // Set up test so that the latest version in the config store contract is higher than
    // the version in the config store client.
    const update = await configStore.updateGlobalConfig(utf8ToHex("VERSION"), "1");
    const updateTime = (await configStore.provider.getBlock(update.blockNumber)).timestamp;
    configStoreClient.setConfigStoreVersion(0);

    // Now send a proposal after the update time. Dataworker should exit early.
    await spokePool_1.setCurrentTime(updateTime + 1);
    await updateAllClients();

    const deposit = await buildDeposit(
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
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    expect(multiCallerClient.transactionCount()).to.equal(0);
    expect(lastSpyLogIncludes(spy, "Skipping proposal because missing updated ConfigStore version")).to.be.true;
    expect(lastSpyLogLevel(spy)).to.equal("warn");
  });

  describe("Dataworker: Proposal block range narrowing", async function () {
    const nDeposits = 50;
    const chainIds = [originChainId, destinationChainId];
    let originSpoke: SpokePoolClient, destinationSpoke: SpokePoolClient;

    beforeEach(async function () {
      // Construct special SpokePoolClient instances with the ability to delete events.
      [originSpoke, destinationSpoke] = chainIds.map((chainId) => {
        const { deploymentBlock, logger, spokePool } = spokePoolClients[chainId];
        const spokePoolClient = new TestSpokePoolClient(logger, spokePool, hubPoolClient, chainId, deploymentBlock);
        spokePoolClients[chainId] = spokePoolClient;
        return spokePoolClient;
      });
      await Promise.all(Object.values(spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));

      const weth = undefined;
      await setupTokensForWallet(originSpoke.spokePool, depositor, [erc20_1], weth, nDeposits + 1);
      await setupTokensForWallet(destinationSpoke.spokePool, relayer, [erc20_2], weth, nDeposits + 1);
    });

    it("Narrows block ranges for fills where no depositId is found (origin chain deposit gaps)", async function () {
      // Prime the origin spoke with a single deposit. Some utility functions involved in searching for deposits
      // rely on the lowest deposit ID in order to bound the search by. A missing initial deposit ID would always
      // be caught during pre-launch testing, so that's not a concern here.
      let deposit = await buildDeposit(
        hubPoolClient,
        originSpoke.spokePool,
        erc20_1,
        l1Token_1,
        depositor,
        destinationChainId,
        amountToDeposit
      );

      // Since the SpokePoolClient relies on SpokePoolClient.latestDepositIdQueried, we can't currently detect
      // the _final_ deposit going missing. Some additional refactoring is needed to add this capability.
      const missingDepositIdx = Math.floor(Math.random() * (nDeposits - 2));
      let missingDepositId = -1;

      for (let idx = 0; idx < nDeposits; ++idx) {
        deposit = await buildDeposit(
          hubPoolClient,
          originSpoke.spokePool,
          erc20_1,
          l1Token_1,
          depositor,
          destinationChainId,
          amountToDeposit
        );

        if (idx === missingDepositIdx) {
          missingDepositId = deposit.depositId;
        }

        await buildFill(destinationSpoke.spokePool, erc20_2, depositor, relayer, deposit, 1);
      }
      await hubPool.setCurrentTime(deposit.quoteTimestamp + 1);
      await hubPoolClient.update();

      await sdkUtils.mapAsync([originSpoke, destinationSpoke], async (spokePoolClient) => {
        await spokePoolClient.spokePool.setCurrentTime(deposit.quoteTimestamp + 1);
        await spokePoolClient.update();
      });

      // Flush the "missing" deposit, which was made but should not be visible to the SpokePoolClient.
      originSpoke.deleteDeposit(missingDepositId);
      const deposits = originSpoke.getDeposits();
      expect(deposits.length).equals(nDeposits); // 1 (initial) + nDeposits - 1 (missing).
      expect(deposits.map(({ depositId }) => depositId).includes(missingDepositId)).is.false;

      // There must be 1 more fill than deposits.
      const fills = destinationSpoke.getFills();
      expect(fills.length).equals(nDeposits);

      // Estimate the starting proposal block range for each chain, based on the blocks it has data for.
      const proposalChainIds = configStoreClient.getChainIdIndicesForBlock();
      const blockRanges = proposalChainIds.map((chainId) => {
        const { deploymentBlock, latestBlockSearched } = spokePoolClients[chainId];
        return [deploymentBlock, latestBlockSearched];
      });

      // Read in the valid and invalid fills for the specified block ranges. This should contain an invalid fill.
      let { allValidFills, allInvalidFills } = await dataworkerInstance.clients.bundleDataClient.loadData(
        blockRanges,
        spokePoolClients
      );
      expect(allValidFills.length).equals(nDeposits - 1);
      expect(allInvalidFills.length).equals(1);
      expect(allInvalidFills[0].fill.depositId).equals(missingDepositId);

      // Compute the updated end block on the origin chain (excluding the missing deposit).
      const safeDepositIdx = deposits.map(({ depositId }) => depositId).indexOf(allInvalidFills[0]?.fill.depositId - 1);
      const { blockNumber: safeOriginEndBlock } = deposits[safeDepositIdx];

      // Compute the updated end block on the destination chain (excluding the "invalid" fill).
      const { blockNumber: safeDestinationEndBlock } = allValidFills.reduce(
        (acc, curr) =>
          curr.blockNumber < allInvalidFills[0]?.fill.blockNumber && curr.blockNumber > acc.blockNumber ? curr : acc,
        allValidFills[0]
      );

      // Update the expected proposal block ranges.
      const safeBlockRanges = blockRanges.map((blockRange) => [...blockRange]);
      const [originChainIdx, destinationChainIdx] = [
        proposalChainIds.indexOf(originChainId),
        proposalChainIds.indexOf(destinationChainId),
      ];
      safeBlockRanges[originChainIdx][1] = safeOriginEndBlock;
      safeBlockRanges[destinationChainIdx][1] = safeDestinationEndBlock;

      const narrowedBlockRanges = await dataworkerInstance.narrowProposalBlockRanges(blockRanges, spokePoolClients);
      ({ allValidFills, allInvalidFills } = await dataworkerInstance.clients.bundleDataClient.loadData(
        narrowedBlockRanges,
        spokePoolClients
      ));
      expect(allInvalidFills.length).equals(0);
      expect(narrowedBlockRanges).to.deep.equal(safeBlockRanges);
    });

    it.skip("Narrows proposal block ranges for missing fills (destination chain fill gaps)", async function () {
      // Since the SpokePoolClient relies on SpokePoolClient.latestDepositIdQueried, we can't currently detect
      // the _final_ deposit going missing. Some additional refactoring is needed to add this detection.
      const missingDepositIdx = Math.floor(Math.random() * (nDeposits - 2));
      let missingDepositId = -1;
      let fillBlock = -1;
      let deposit: Deposit;
      for (let idx = 0; idx < nDeposits; ++idx) {
        deposit = await buildDeposit(
          hubPoolClient,
          originSpoke.spokePool,
          erc20_1,
          l1Token_1,
          depositor,
          destinationChainId,
          amountToDeposit
        );

        await buildFill(destinationSpoke.spokePool, erc20_2, depositor, relayer, deposit, 1);
        if (idx === missingDepositIdx) {
          missingDepositId = deposit.depositId;
          fillBlock = await destinationSpoke.spokePool.provider.getBlockNumber();
        }
      }
      assert(fillBlock !== -1);

      await hubPool.setCurrentTime(deposit.quoteTimestamp + 1);
      await hubPoolClient.update();

      await sdkUtils.mapAsync([originSpoke, destinationSpoke], async (spokePoolClient) => {
        await spokePoolClient.spokePool.setCurrentTime(deposit.quoteTimestamp + 1);
        await spokePoolClient.update();
      });

      // There must be 1 more deposits than fills.
      expect(originSpoke.getDeposits().length).equals(nDeposits);

      // Flush the "missing" fill, which was made but should not be visible to the SpokePoolClient.
      destinationSpoke.deleteFill(originChainId, missingDepositId);
      const fills = destinationSpoke.getFillsForOriginChain(originChainId);
      expect(fills.length).equals(nDeposits - 1); // nDeposits - 1 (missing).
      expect(fills.map(({ depositId }) => depositId).includes(missingDepositId)).is.false;

      // Estimate the starting proposal block range for each chain, based on the blocks it has data for.
      const proposalChainIds = configStoreClient.getChainIdIndicesForBlock();
      const blockRanges = proposalChainIds.map((chainId) => {
        const { deploymentBlock, latestBlockSearched } = spokePoolClients[chainId];
        return [deploymentBlock, latestBlockSearched];
      });

      // Read in the valid and invalid fills for the specified block ranges. This should contain an invalid fill.
      let { allValidFills, allInvalidFills } = await dataworkerInstance.clients.bundleDataClient.loadData(
        blockRanges,
        spokePoolClients
      );
      expect(allValidFills.length).equals(nDeposits - 1);
      expect(allInvalidFills.length).equals(0); // One valid fill is _missing_.

      // Compute the updated end block on the destination chain (excluding the "invalid" fill).
      const { blockNumber: safeDestinationEndBlock } = allValidFills.reduce(
        (acc, curr) => (curr.blockNumber < fillBlock && curr.blockNumber > acc.blockNumber ? curr : acc),
        allValidFills[0]
      );

      // Update the expected proposal block ranges.
      const safeBlockRanges = blockRanges.map((blockRange) => [...blockRange]);
      const destinationChainIdx = proposalChainIds.indexOf(destinationChainId);
      safeBlockRanges[destinationChainIdx][1] = safeDestinationEndBlock;

      const narrowedBlockRanges = await dataworkerInstance.narrowProposalBlockRanges(blockRanges, spokePoolClients);
      ({ allValidFills, allInvalidFills } = await dataworkerInstance.clients.bundleDataClient.loadData(
        narrowedBlockRanges,
        spokePoolClients
      ));
      expect(allInvalidFills.length).equals(0);
      expect(narrowedBlockRanges).to.deep.equal(safeBlockRanges);
    });
  });
});
