import { buildSlowRelayTree, buildSlowRelayLeaves, buildFillForRepaymentChain, sampleRateModel } from "./utils";
import { SignerWithAddress, expect, ethers, Contract, toBN, toBNWei, setupTokensForWallet } from "./utils";
import { buildDeposit, buildFill, buildSlowFill, BigNumber, deployNewTokenMapping } from "./utils";
import { buildRelayerRefundTreeWithUnassignedLeafIds, constructPoolRebalanceTree } from "./utils";
import { buildPoolRebalanceLeafTree } from "./utils";
import { HubPoolClient, AcrossConfigStoreClient, GLOBAL_CONFIG_STORE_KEYS } from "../src/clients";
import { amountToDeposit, destinationChainId, originChainId, mockTreeRoot } from "./constants";
import { MAX_REFUNDS_PER_RELAYER_REFUND_LEAF, MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF } from "./constants";
import { refundProposalLiveness, CHAIN_ID_TEST_LIST, DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD } from "./constants";
import { DEFAULT_BLOCK_RANGE_FOR_CHAIN } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import { Deposit, Fill, RunningBalances } from "../src/interfaces";
import { getRealizedLpFeeForFills, getRefundForFills, getRefund, compareAddresses, utf8ToHex } from "../src/utils";

// Tested
import { Dataworker } from "../src/dataworker/Dataworker";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, hubPool: Contract, timer: Contract, configStore: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress, dataworker: SignerWithAddress;

let hubPoolClient: HubPoolClient, configStoreClient: AcrossConfigStoreClient;
let dataworkerInstance: Dataworker;

let updateAllClients: () => Promise<void>;

describe("Dataworker: Build merkle roots", async function () {
  beforeEach(async function () {
    ({
      hubPool,
      spokePool_1,
      erc20_1,
      spokePool_2,
      erc20_2,
      configStore,
      configStoreClient,
      hubPoolClient,
      l1Token_1,
      depositor,
      relayer,
      dataworkerInstance,
      dataworker,
      timer,
      updateAllClients,
    } = await setupDataworker(
      ethers,
      MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
      MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
      DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD
    ));
  });
  it("Build slow relay root", async function () {
    await updateAllClients();

    // Submit deposits for multiple destination chain IDs.
    const deposit1 = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit2 = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );
    const deposit3 = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit4 = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );

    // Slow relays should be sorted by origin chain ID and deposit ID.
    const expectedSlowRelayLeaves = buildSlowRelayLeaves([deposit1, deposit2, deposit3, deposit4]);

    // Add fills for each deposit so dataworker includes deposits as slow relays:
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 0.1);
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit3, 0.1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit4, 0.1);

    // Returns expected merkle root where leaves are ordered by origin chain ID and then deposit ID
    // (ascending).
    await updateAllClients();
    const merkleRoot1 = dataworkerInstance.buildSlowRelayRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN).tree;
    const expectedMerkleRoot1 = await buildSlowRelayTree(expectedSlowRelayLeaves);
    expect(merkleRoot1.getHexRoot()).to.equal(expectedMerkleRoot1.getHexRoot());

    // Fill deposits such that there are no unfilled deposits remaining.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 1);
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit3, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit4, 1);
    await updateAllClients();
    expect(() => dataworkerInstance.buildSlowRelayRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN)).to.throw();
  });
  it("Build relayer refund root", async function () {
    await updateAllClients();
    expect(() => dataworkerInstance.buildRelayerRefundRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN)).to.throw();

    // Submit deposits for multiple L2 tokens.
    const deposit1 = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit2 = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );
    const deposit3 = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit4 = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit.mul(2)
    );
    const deposit5 = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );
    const deposit6 = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );

    // Submit fills for two relayers on one repayment chain and one destination token. Note: we know that
    // depositor address is alphabetically lower than relayer address, so submit fill from depositor first and test
    // that data worker sorts on refund address.
    await buildFillForRepaymentChain(spokePool_2, depositor, deposit3, 0.25, 100);
    await buildFillForRepaymentChain(spokePool_2, depositor, deposit3, 1, 100);
    await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 0.25, 100);
    await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 1, 100);

    const depositorBeforeRelayer = toBN(depositor.address).lt(toBN(relayer.address));
    const leaf1 = {
      chainId: 100,
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_2.address,
      refundAddresses: [
        depositorBeforeRelayer ? depositor.address : relayer.address,
        depositorBeforeRelayer ? relayer.address : depositor.address,
      ], // Sorted ascending alphabetically
      refundAmounts: [
        getRefund(deposit1.amount, deposit1.realizedLpFeePct),
        getRefund(deposit3.amount, deposit3.realizedLpFeePct),
      ], // Refund amounts should aggregate across all fills.
    };

    await updateAllClients();
    const merkleRoot1 = dataworkerInstance.buildRelayerRefundRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN).tree;
    const expectedMerkleRoot1 = await buildRelayerRefundTreeWithUnassignedLeafIds([leaf1]);
    expect(merkleRoot1.getHexRoot()).to.equal(expectedMerkleRoot1.getHexRoot());

    // Submit fills for a second destination token on on the same repayment chain.
    await buildFillForRepaymentChain(spokePool_1, relayer, deposit2, 1, 100);
    await buildFillForRepaymentChain(spokePool_1, depositor, deposit4, 1, 100);
    const leaf2 = {
      chainId: 100,
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_1.address,
      refundAddresses: [depositor.address, relayer.address], // Ordered by fill amount
      refundAmounts: [
        getRefund(deposit4.amount, deposit4.realizedLpFeePct),
        getRefund(deposit2.amount, deposit2.realizedLpFeePct),
      ],
    };
    await updateAllClients();
    const merkleRoot2 = dataworkerInstance.buildRelayerRefundRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN).tree;
    const leaves1And2Sorted = toBN(erc20_1.address).lt(toBN(erc20_2.address)) ? [leaf2, leaf1] : [leaf1, leaf2];
    const expectedMerkleRoot2 = await buildRelayerRefundTreeWithUnassignedLeafIds(leaves1And2Sorted);
    expect(merkleRoot2.getHexRoot()).to.equal(expectedMerkleRoot2.getHexRoot());

    // Submit fills for multiple repayment chains. Note: Send the fills for destination tokens in the
    // reverse order of the fills we sent above to test that the data worker is correctly sorting leaves
    // by L2 token address in ascending order. Also set repayment chain ID lower than first few leaves to test
    // that these leaves come first.
    await buildFillForRepaymentChain(spokePool_1, relayer, deposit5, 1, 99);
    await buildFillForRepaymentChain(spokePool_2, relayer, deposit6, 1, 99);
    const leaf3 = {
      chainId: 99,
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_2.address,
      refundAddresses: [relayer.address],
      refundAmounts: [getRefund(deposit5.amount, deposit5.realizedLpFeePct)],
    };
    const leaf4 = {
      chainId: 99,
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_1.address,
      refundAddresses: [relayer.address],
      refundAmounts: [getRefund(deposit6.amount, deposit6.realizedLpFeePct)],
    };
    await updateAllClients();
    const merkleRoot3 = await dataworkerInstance.buildRelayerRefundRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN).tree;
    const leaves3And4Sorted = toBN(erc20_1.address).lt(toBN(erc20_2.address)) ? [leaf4, leaf3] : [leaf3, leaf4];
    const expectedMerkleRoot3 = await buildRelayerRefundTreeWithUnassignedLeafIds([
      ...leaves3And4Sorted,
      ...leaves1And2Sorted,
    ]);
    expect(merkleRoot3.getHexRoot()).to.equal(expectedMerkleRoot3.getHexRoot());

    // Splits leaf into multiple leaves if refunds > MAX_REFUNDS_PER_RELAYER_REFUND_LEAF.
    const deposit7 = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const allSigners: SignerWithAddress[] = await ethers.getSigners();
    expect(
      allSigners.length >= MAX_REFUNDS_PER_RELAYER_REFUND_LEAF + 1,
      "ethers.getSigners doesn't have enough signers"
    );
    for (let i = 0; i < MAX_REFUNDS_PER_RELAYER_REFUND_LEAF + 1; i++) {
      await setupTokensForWallet(spokePool_2, allSigners[i], [erc20_2]);
      await buildFillForRepaymentChain(spokePool_2, allSigners[i], deposit7, 0.01 + i * 0.01, 98);
    }
    // Note: Higher refund amounts for same chain and L2 token should come first, so we test that by increasing
    // the fill amount in the above loop for each fill. Ultimately, the latest fills send the most tokens and
    // should come in the first leaf.
    const leaf5 = {
      chainId: 98,
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_2.address,
      refundAddresses: [allSigners[3].address, allSigners[2].address, allSigners[1].address],
      refundAmounts: [
        getRefund(deposit7.amount, deposit7.realizedLpFeePct).mul(toBNWei("0.04")).div(toBNWei("1")),
        getRefund(deposit7.amount, deposit7.realizedLpFeePct).mul(toBNWei("0.03")).div(toBNWei("1")),
        getRefund(deposit7.amount, deposit7.realizedLpFeePct).mul(toBNWei("0.02")).div(toBNWei("1")),
      ],
    };
    const leaf6 = {
      chainId: 98,
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_2.address,
      refundAddresses: [allSigners[0].address],
      refundAmounts: [getRefund(deposit7.amount, deposit7.realizedLpFeePct).mul(toBNWei("0.01")).div(toBNWei("1"))],
    };
    await updateAllClients();
    const merkleRoot4 = dataworkerInstance.buildRelayerRefundRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN).tree;
    const expectedMerkleRoot4 = await buildRelayerRefundTreeWithUnassignedLeafIds([
      leaf5,
      leaf6,
      ...leaves3And4Sorted,
      ...leaves1And2Sorted,
    ]);
    expect(merkleRoot4.getHexRoot()).to.equal(expectedMerkleRoot4.getHexRoot());
  });
  describe("Build pool rebalance root", function () {
    it("One L1 token, full lifecycle test with slow and non-slow fills", async function () {
      // Helper function we'll use in this lifecycle test to keep track of updated counter variables.
      const updateAndCheckExpectedPoolRebalanceCounters = (
        expectedRunningBalances: RunningBalances,
        expectedRealizedLpFees: RunningBalances,
        runningBalanceDelta: BigNumber,
        realizedLpFeeDelta: BigNumber,
        l2Chains: number[],
        l1Tokens: string[],
        test: { runningBalances: RunningBalances; realizedLpFees: RunningBalances }
      ): void => {
        l2Chains.forEach((l2Chain: number) =>
          l1Tokens.forEach((l1Token: string) => {
            expectedRunningBalances[l2Chain][l1Token] =
              expectedRunningBalances[l2Chain][l1Token].add(runningBalanceDelta);
            expectedRealizedLpFees[l2Chain][l1Token] = expectedRealizedLpFees[l2Chain][l1Token].add(realizedLpFeeDelta);
          })
        );
        expect(test.runningBalances).to.deep.equal(expectedRunningBalances);
        expect(test.realizedLpFees).to.deep.equal(expectedRealizedLpFees);
      };

      await updateAllClients();
      expect(() => dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN)).to.throw();

      // Submit deposits for multiple L2 tokens.
      const deposit1 = await buildDeposit(
        configStoreClient,
        hubPoolClient,
        spokePool_1,
        erc20_1,
        l1Token_1,
        depositor,
        destinationChainId,
        amountToDeposit
      );
      const deposit2 = await buildDeposit(
        configStoreClient,
        hubPoolClient,
        spokePool_2,
        erc20_2,
        l1Token_1,
        depositor,
        originChainId,
        amountToDeposit.mul(toBN(2))
      );
      const deposit3 = await buildDeposit(
        configStoreClient,
        hubPoolClient,
        spokePool_2,
        erc20_2,
        l1Token_1,
        depositor,
        originChainId,
        amountToDeposit
      );
      await updateAllClients();

      const deposits = [deposit1, deposit2, deposit3];

      // Note: Submit fills with repayment chain set to one of the origin or destination chains since we have spoke
      // pools deployed on those chains.

      // Partial fill deposit1
      const fill1 = await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 0.5, destinationChainId);

      // Partial fill deposit2
      const fill2 = await buildFillForRepaymentChain(spokePool_1, depositor, deposit2, 0.3, originChainId);
      const fill3 = await buildFillForRepaymentChain(spokePool_1, depositor, deposit2, 0.2, originChainId);

      // Partial fill deposit3
      const fill4 = await buildFillForRepaymentChain(spokePool_1, depositor, deposit3, 0.5, originChainId);
      const blockOfLastFill = await hubPool.provider.getBlockNumber();

      // Prior to root bundle being executed, running balances should be:
      // - deposited amount
      // + partial fill refund
      const expectedRunningBalances: RunningBalances = {
        [destinationChainId]: {
          [l1Token_1.address]: getRefundForFills([fill1]).sub(deposit2.amount.add(deposit3.amount)),
        },
        [originChainId]: {
          [l1Token_1.address]: getRefundForFills([fill2, fill3, fill4]).sub(deposit1.amount),
        },
      };
      const expectedRealizedLpFees: RunningBalances = {
        [destinationChainId]: {
          [l1Token_1.address]: getRealizedLpFeeForFills([fill1]),
        },
        [originChainId]: {
          [l1Token_1.address]: getRealizedLpFeeForFills([fill2, fill3, fill4]),
        },
      };
      await updateAllClients();
      const merkleRoot1 = dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN);
      expect(merkleRoot1.runningBalances).to.deep.equal(expectedRunningBalances);
      expect(merkleRoot1.realizedLpFees).to.deep.equal(expectedRealizedLpFees);

      // Construct slow relay root which should include deposit1 and deposit2
      const slowRelayLeaves = buildSlowRelayLeaves(deposits);
      const expectedSlowRelayTree = await buildSlowRelayTree(slowRelayLeaves);

      // Construct pool rebalance root so we can publish slow relay root to spoke pool:
      const {
        tree: poolRebalanceTree,
        leaves: poolRebalanceLeaves,
        startingRunningBalances,
      } = await constructPoolRebalanceTree(expectedRunningBalances, expectedRealizedLpFees);

      // Propose root bundle so that we can test that the dataworker looks up ProposeRootBundle events properly.
      await hubPool.connect(dataworker).proposeRootBundle(
        Array(CHAIN_ID_TEST_LIST.length).fill(blockOfLastFill), // Set current block number as end block for bundle. Its important that we set a block for every possible chain ID.
        // so all fills to this point are before these blocks.
        poolRebalanceLeaves.length, // poolRebalanceLeafCount.
        poolRebalanceTree.getHexRoot(), // poolRebalanceRoot
        mockTreeRoot, // relayerRefundRoot
        expectedSlowRelayTree.getHexRoot() // slowRelayRoot
      );

      // Execute 1 slow relay leaf:
      // Before we can execute the leaves on the spoke pool, we need to actually publish them since we're using a mock
      // adapter that doesn't send messages as you'd expect in executeRootBundle.
      await spokePool_1.relayRootBundle(mockTreeRoot, expectedSlowRelayTree.getHexRoot());
      const chainToExecuteSlowRelay = await spokePool_1.chainId();
      const slowFill2 = await buildSlowFill(
        spokePool_1,
        fill3,
        dataworker,
        expectedSlowRelayTree.getHexProof(
          // We can only execute a slow relay on its destination chain, so look up the relay data with
          // destination chain equal to the deployed spoke pool that we are calling.
          slowRelayLeaves.find((_) => _.destinationChainId === chainToExecuteSlowRelay.toString())
        )
      );
      await updateAllClients();

      // Running balance should now have accounted for the slow fill. However, there are no "extra" funds remaining in the
      // spoke pool following this slow fill because there were no fills that were submitted after the root bundle
      // was submitted that included the slow fill. The new running balance should therefore be identical to the old one.
      updateAndCheckExpectedPoolRebalanceCounters(
        expectedRunningBalances,
        expectedRealizedLpFees,
        toBN(0),
        getRealizedLpFeeForFills([slowFill2]),
        [slowFill2.destinationChainId],
        [l1Token_1.address],
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN)
      );

      // Now, submit another partial fill for a deposit whose slow fill has NOT been executed yet. This should result
      // in the slow fill execution leaving excess funds in the spoke pool.
      const fill5 = await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 0.25, destinationChainId);
      await updateAllClients();
      updateAndCheckExpectedPoolRebalanceCounters(
        expectedRunningBalances,
        expectedRealizedLpFees,
        getRefundForFills([fill5]),
        getRealizedLpFeeForFills([fill5]),
        [fill5.destinationChainId],
        [l1Token_1.address],
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN)
      );

      // Execute second slow relay leaf:
      // Before we can execute the leaves on the spoke pool, we need to actually publish them since we're using a mock
      // adapter that doesn't send messages as you'd expect in executeRootBundle.
      await spokePool_2.relayRootBundle(mockTreeRoot, expectedSlowRelayTree.getHexRoot());
      const secondChainToExecuteSlowRelay = await spokePool_2.chainId();
      const slowFill1 = await buildSlowFill(
        spokePool_2,
        fill5,
        dataworker,
        expectedSlowRelayTree.getHexProof(
          // We can only execute a slow relay on its destination chain, so look up the relay data with
          // destination chain equal to the deployed spoke pool that we are calling.
          slowRelayLeaves.find((_) => _.destinationChainId === secondChainToExecuteSlowRelay.toString())
        )
      );
      await updateAllClients();

      // Running balance should decrease by excess from slow fill since fill5 was sent before the slow fill could be
      // executed. Since fill5 filled the remainder of the deposit, the entire slow fill amount should be subtracted
      // from running balances.
      const sentAmount = fill1.amount.sub(fill1.totalFilledAmount);
      const excess = sentAmount.sub(slowFill1.fillAmount);
      updateAndCheckExpectedPoolRebalanceCounters(
        expectedRunningBalances,
        expectedRealizedLpFees,
        excess.mul(toBN(-1)),
        getRealizedLpFeeForFills([slowFill1]),
        [fill5.destinationChainId],
        [l1Token_1.address],
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN)
      );

      // Before executing the last slow relay leaf, completely fill the deposit. This will leave the full slow fill
      // amount remaining in the spoke pool, but this time there will not be a FilledRelay event emitted for the slow fill
      // because it can't be executed now that the deposit is fully filled. Build the pool rebalance root and check
      // that the slow fill full amount is decreased from running balances.
      const fill6 = await buildFillForRepaymentChain(spokePool_1, relayer, deposit3, 1, originChainId);
      await updateAllClients();
      const fullSlowFillAmountToSubtract = fill4.amount.sub(fill4.totalFilledAmount);
      updateAndCheckExpectedPoolRebalanceCounters(
        expectedRunningBalances,
        expectedRealizedLpFees,
        // This should decrease running balances because the first fill is contained in a ProposeRootBundle event.
        getRefundForFills([fill6]).sub(fullSlowFillAmountToSubtract),
        getRealizedLpFeeForFills([fill6]),
        [fill6.destinationChainId],
        [l1Token_1.address],
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN)
      );

      // Now demonstrate that for a deposit whose first fill is NOT contained in a ProposeRootBundle event, it won't
      // affect running balance:
      // Submit another deposit and partial fill, this should mine at a block after the ending block of the last
      // ProposeRootBundle block range.
      // Fully fill the deposit.
      // Update client and construct root. This should increase running balance by total deposit amount, to refund
      // the slow relay.
      const deposit4 = await buildDeposit(
        configStoreClient,
        hubPoolClient,
        spokePool_2,
        erc20_2,
        l1Token_1,
        depositor,
        originChainId,
        amountToDeposit
      );
      expectedRunningBalances[deposit4.originChainId][l1Token_1.address] = expectedRunningBalances[
        deposit4.originChainId
      ][l1Token_1.address].sub(deposit4.amount);

      const fill7 = await buildFillForRepaymentChain(spokePool_1, depositor, deposit4, 0.5, originChainId);
      const fill8 = await buildFillForRepaymentChain(spokePool_1, depositor, deposit4, 1, originChainId);
      await updateAllClients();
      updateAndCheckExpectedPoolRebalanceCounters(
        expectedRunningBalances,
        expectedRealizedLpFees,
        getRefundForFills([fill7, fill8]),
        getRealizedLpFeeForFills([fill7, fill8]),
        [fill7.destinationChainId],
        [l1Token_1.address],
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN)
      );

      // Execute root bundle so we can propose another bundle. The latest running balance emitted in this event
      // should be added to running balances.
      await timer.setCurrentTime(Number(await timer.getCurrentTime()) + refundProposalLiveness + 1);
      await Promise.all(
        poolRebalanceLeaves.map((leaf) => {
          return hubPool
            .connect(dataworker)
            .executeRootBundle(...Object.values(leaf), poolRebalanceTree.getHexProof(leaf));
        })
      );
      await updateAllClients();
      updateAndCheckExpectedPoolRebalanceCounters(
        expectedRunningBalances,
        expectedRealizedLpFees,
        startingRunningBalances,
        toBN(0),
        [originChainId, destinationChainId],
        [l1Token_1.address],
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN)
      );

      // Even after a ProposeRootBundle is submitted with a block range containing both fill7 and fill8, nothing changes
      // because the fills are contained in the same bundle.
      await hubPool.connect(dataworker).proposeRootBundle(
        Array(CHAIN_ID_TEST_LIST.length).fill(await hubPool.provider.getBlockNumber()),
        1,
        mockTreeRoot, // Roots don't matter in this test
        mockTreeRoot,
        mockTreeRoot
      );
      await updateAllClients();
      const merkleRoot7 = dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN);
      expect(merkleRoot7.runningBalances).to.deep.equal(expectedRunningBalances);
      expect(merkleRoot7.realizedLpFees).to.deep.equal(expectedRealizedLpFees);

      // A full fill not following any partial fills is treated as a normal fill: increases the running balance.
      const deposit5 = await buildDeposit(
        configStoreClient,
        hubPoolClient,
        spokePool_2,
        erc20_2,
        l1Token_1,
        depositor,
        originChainId,
        amountToDeposit
      );
      expectedRunningBalances[deposit5.originChainId][l1Token_1.address] = expectedRunningBalances[
        deposit5.originChainId
      ][l1Token_1.address].sub(deposit5.amount);

      const fill9 = await buildFillForRepaymentChain(spokePool_1, depositor, deposit5, 1, originChainId);
      await updateAllClients();
      updateAndCheckExpectedPoolRebalanceCounters(
        expectedRunningBalances,
        expectedRealizedLpFees,
        getRefundForFills([fill9]),
        getRealizedLpFeeForFills([fill9]),
        [fill9.destinationChainId],
        [l1Token_1.address],
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN)
      );
    });
    it("Many L1 tokens, testing leaf order and root construction", async function () {
      // In this test, each L1 token will have one deposit and fill associated with it.
      const depositsForL1Token: { [l1Token: string]: Deposit } = {};
      const fillsForL1Token: { [l1Token: string]: Fill } = {};

      for (let i = 0; i < MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF + 1; i++) {
        const { l1Token, l2Token } = await deployNewTokenMapping(
          depositor,
          relayer,
          spokePool_1,
          spokePool_2,
          configStore,
          hubPool,
          amountToDeposit.mul(toBN(100))
        );

        // Set a very high transfer threshold so leaves are not split
        await configStore.updateTokenConfig(
          l1Token.address,
          JSON.stringify({
            rateModel: sampleRateModel,
            transferThreshold: toBNWei("1000000").toString(),
          })
        );

        await updateAllClients(); // Update client to be aware of new token mapping so we can build deposit correctly.
        const deposit = await buildDeposit(
          configStoreClient,
          hubPoolClient,
          spokePool_1,
          l2Token,
          l1Token,
          depositor,
          destinationChainId,
          amountToDeposit.mul(i + 1) // Increase deposit amount each time so that L1 tokens
          // all have different running balances.
        );
        depositsForL1Token[l1Token.address] = deposit;
        await updateAllClients();
        fillsForL1Token[l1Token.address] = await buildFillForRepaymentChain(
          spokePool_2,
          depositor,
          deposit,
          0.5,
          destinationChainId
        );
      }
      const sortedL1Tokens = Object.keys(depositsForL1Token).sort((x, y) => compareAddresses(x, y));

      // Since there are more L1 tokens than the max allowed per chain, dataworker should split the L1's into two
      // leaves. There should be 4 L1 tokens for the origin and destination chain since a fill and deposit was sent
      // for each newly created token mapping. Check that the leaves are sorted by L2 chain ID and then by L1 token
      // address.
      await updateAllClients();
      const merkleRoot1 = dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN);
      const orderedChainIds = [originChainId, destinationChainId].sort((x, y) => x - y);
      const expectedLeaves = orderedChainIds
        .map((chainId) => {
          // For each chain, there should be two leaves since we sent exactly 1 more deposit + fill than the max L1
          // token allowed per pool rebalance leaf. The first leaf will have the full capacity of L1 tokens and the second
          // will have just 1.
          return [
            sortedL1Tokens.slice(0, MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF),
            [sortedL1Tokens[sortedL1Tokens.length - 1]],
          ].map((l1TokensToIncludeInLeaf: string[], i) => {
            return {
              groupIndex: i,
              chainId,
              // Realized LP fees are 0 for origin chain since no fill was submitted to it, only deposits.
              bundleLpFees:
                chainId === originChainId
                  ? Array(l1TokensToIncludeInLeaf.length).fill(toBN(0))
                  : l1TokensToIncludeInLeaf.map((l1Token) => getRealizedLpFeeForFills([fillsForL1Token[l1Token]])),
              // Running balances are straightforward to compute because deposits are sent to origin chain and fills
              // are sent to destination chain only.
              runningBalances:
                chainId === originChainId
                  ? l1TokensToIncludeInLeaf.map((l1Token) => depositsForL1Token[l1Token].amount.mul(toBN(-1)))
                  : l1TokensToIncludeInLeaf.map((l1Token) => getRefundForFills([fillsForL1Token[l1Token]])),
              netSendAmounts: l1TokensToIncludeInLeaf.map((_) => toBN(0)), // Should be 0 since running balances are
              // under threshold
              l1Tokens: l1TokensToIncludeInLeaf,
            };
          });
        })
        .flat()
        .map((leaf, i) => {
          return { ...leaf, leafId: i };
        });
      expect(merkleRoot1.leaves).to.deep.equal(expectedLeaves);
      const expectedMerkleRoot = await buildPoolRebalanceLeafTree(
        expectedLeaves.map((leaf) => {
          return { ...leaf, chainId: toBN(leaf.chainId), groupIndex: toBN(leaf.groupIndex), leafId: toBN(leaf.leafId) };
        })
      );
      expect(dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN).tree.getHexRoot()).to.equal(
        expectedMerkleRoot.getHexRoot()
      );
    });
    it("Token transfer exceeeds threshold", async function () {
      await updateAllClients();
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
      const fill = await buildFillForRepaymentChain(spokePool_2, depositor, deposit, 1, destinationChainId);
      await updateAllClients();
      const merkleRoot1 = dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN);

      const orderedChainIds = [originChainId, destinationChainId].sort((x, y) => x - y);
      const expectedLeaves1 = orderedChainIds
        .map((chainId) => {
          return {
            groupIndex: 0,
            chainId,
            bundleLpFees: chainId === originChainId ? [toBN(0)] : [getRealizedLpFeeForFills([fill])],
            // Running balance is <<< token threshold, so running balance should be non-zero and net send amount
            // should be 0.
            runningBalances: chainId === originChainId ? [deposit.amount.mul(toBN(-1))] : [getRefundForFills([fill])],
            netSendAmounts: [toBN(0)],
            l1Tokens: [l1Token_1.address],
          };
        })
        .map((leaf, i) => {
          return { ...leaf, leafId: i };
        });
      expect(merkleRoot1.leaves).to.deep.equal(expectedLeaves1);

      // Now set the threshold much lower than the running balance and check that running balances for all
      // chains gets set to 0 and net send amount is equal to the running balance. This also tests that the
      // dataworker is comparing the absolute value of the running balance with the threshold, not the signed value.
      await configStore.updateTokenConfig(
        l1Token_1.address,
        JSON.stringify({
          rateModel: sampleRateModel,
          transferThreshold: toBNWei(1).toString(),
        })
      );
      await configStoreClient.update();
      const merkleRoot2 = dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN);
      const expectedLeaves2 = expectedLeaves1.map((leaf) => {
        return {
          ...leaf,
          runningBalances: [toBN(0)],
          netSendAmounts: leaf.runningBalances,
        };
      });
      expect(merkleRoot2.leaves).to.deep.equal(expectedLeaves2);
    });
  });
});
