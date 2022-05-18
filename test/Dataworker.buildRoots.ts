import { buildSlowRelayTree, buildSlowRelayLeaves, buildFillForRepaymentChain, enableRoutesOnHubPool } from "./utils";
import { SignerWithAddress, expect, ethers, Contract, toBN, toBNWei, setupTokensForWallet } from "./utils";
import { buildDeposit, buildFill, buildSlowFill, BigNumber, deployNewTokenMapping } from "./utils";
import { buildRelayerRefundTreeWithUnassignedLeafIds, constructPoolRebalanceTree } from "./utils";
import { buildPoolRebalanceLeafTree, sampleRateModel } from "./utils";
import { HubPoolClient, AcrossConfigStoreClient, SpokePoolClient } from "../src/clients";
import {
  amountToDeposit,
  destinationChainId,
  originChainId,
  mockTreeRoot,
  buildPoolRebalanceLeaves,
} from "./constants";
import { MAX_REFUNDS_PER_RELAYER_REFUND_LEAF, MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF } from "./constants";
import { refundProposalLiveness, CHAIN_ID_TEST_LIST, DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD } from "./constants";
import { DEFAULT_BLOCK_RANGE_FOR_CHAIN } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import { Deposit, Fill, RunningBalances } from "../src/interfaces";
import { getRealizedLpFeeForFills, getRefundForFills, getRefund, EMPTY_MERKLE_ROOT } from "../src/utils";
import { compareAddresses } from "../src/utils";

// Tested
import { Dataworker } from "../src/dataworker/Dataworker";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, hubPool: Contract, timer: Contract, configStore: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress, dataworker: SignerWithAddress;

let hubPoolClient: HubPoolClient, configStoreClient: AcrossConfigStoreClient;
let dataworkerInstance: Dataworker;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

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
      spokePoolClients,
      updateAllClients,
    } = await setupDataworker(
      ethers,
      MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
      MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
      DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD,
      0
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
    const merkleRoot1 = dataworkerInstance.buildSlowRelayRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients).tree;
    const expectedMerkleRoot1 = await buildSlowRelayTree(expectedSlowRelayLeaves);
    expect(merkleRoot1.getHexRoot()).to.equal(expectedMerkleRoot1.getHexRoot());

    // Fill deposits such that there are no unfilled deposits remaining.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 1);
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit3, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit4, 1);
    await updateAllClients();
    expect(dataworkerInstance.buildSlowRelayRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients).leaves).to.deep.equal(
      []
    );
    expect(
      dataworkerInstance.buildSlowRelayRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients).tree.getHexRoot()
    ).to.equal(EMPTY_MERKLE_ROOT);
  });
  describe("Build relayer refund root", function () {
    it("amountToReturn is 0", async function () {
      await updateAllClients();
      expect(
        dataworkerInstance.buildRelayerRefundRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients).leaves
      ).to.deep.equal([]);
      expect(
        dataworkerInstance.buildRelayerRefundRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients).tree.getHexRoot()
      ).to.equal(EMPTY_MERKLE_ROOT);

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
        spokePool_1,
        erc20_1,
        l1Token_1,
        depositor,
        destinationChainId,
        amountToDeposit
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

      // Submit fills for two relayers on one repayment chain and one destination token. Note: we know that
      // depositor address is alphabetically lower than relayer address, so submit fill from depositor first and test
      // that data worker sorts on refund address.
      await enableRoutesOnHubPool(hubPool, [
        { destinationChainId: 100, destinationToken: erc20_2, l1Token: l1Token_1 },
        { destinationChainId: 99, destinationToken: erc20_1, l1Token: l1Token_1 },
        { destinationChainId: 98, destinationToken: erc20_1, l1Token: l1Token_1 },
      ]);
      await updateAllClients();
      await buildFillForRepaymentChain(spokePool_2, depositor, deposit2, 0.25, 100);
      await buildFillForRepaymentChain(spokePool_2, depositor, deposit2, 1, 100);
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
      const merkleRoot1 = dataworkerInstance.buildRelayerRefundRoot(
        DEFAULT_BLOCK_RANGE_FOR_CHAIN,
        spokePoolClients
      ).tree;
      const expectedMerkleRoot1 = await buildRelayerRefundTreeWithUnassignedLeafIds([leaf1]);
      expect(merkleRoot1.getHexRoot()).to.equal(expectedMerkleRoot1.getHexRoot());

      // Submit fills for multiple repayment chains. Note: Send the fills for destination tokens in the
      // reverse order of the fills we sent above to test that the data worker is correctly sorting leaves
      // by L2 token address in ascending order. Also set repayment chain ID lower than first few leaves to test
      // that these leaves come first.
      await buildFillForRepaymentChain(spokePool_1, relayer, deposit3, 1, 99);
      const leaf2 = {
        chainId: 99,
        amountToReturn: toBN(0),
        l2TokenAddress: erc20_1.address,
        refundAddresses: [relayer.address],
        refundAmounts: [getRefund(deposit3.amount, deposit3.realizedLpFeePct)],
      };
      await updateAllClients();
      const merkleRoot2 = await dataworkerInstance.buildRelayerRefundRoot(
        DEFAULT_BLOCK_RANGE_FOR_CHAIN,
        spokePoolClients
      ).tree;
      const expectedMerkleRoot2 = await buildRelayerRefundTreeWithUnassignedLeafIds([leaf2, leaf1]);
      expect(merkleRoot2.getHexRoot()).to.equal(expectedMerkleRoot2.getHexRoot());

      // Splits leaf into multiple leaves if refunds > MAX_REFUNDS_PER_RELAYER_REFUND_LEAF.
      const deposit4 = await buildDeposit(
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
        await buildFillForRepaymentChain(spokePool_2, allSigners[i], deposit4, 0.01 + i * 0.01, 98);
      }
      // Note: Higher refund amounts for same chain and L2 token should come first, so we test that by increasing
      // the fill amount in the above loop for each fill. Ultimately, the latest fills send the most tokens and
      // should come in the first leaf.
      const leaf5 = {
        chainId: 98,
        amountToReturn: toBN(0),
        l2TokenAddress: erc20_1.address,
        refundAddresses: [allSigners[3].address, allSigners[2].address, allSigners[1].address],
        refundAmounts: [
          getRefund(deposit4.amount, deposit4.realizedLpFeePct).mul(toBNWei("0.04")).div(toBNWei("1")),
          getRefund(deposit4.amount, deposit4.realizedLpFeePct).mul(toBNWei("0.03")).div(toBNWei("1")),
          getRefund(deposit4.amount, deposit4.realizedLpFeePct).mul(toBNWei("0.02")).div(toBNWei("1")),
        ],
      };
      const leaf6 = {
        chainId: 98,
        amountToReturn: toBN(0),
        l2TokenAddress: erc20_1.address,
        refundAddresses: [allSigners[0].address],
        refundAmounts: [getRefund(deposit4.amount, deposit4.realizedLpFeePct).mul(toBNWei("0.01")).div(toBNWei("1"))],
      };
      await updateAllClients();
      const merkleRoot3 = dataworkerInstance.buildRelayerRefundRoot(
        DEFAULT_BLOCK_RANGE_FOR_CHAIN,
        spokePoolClients
      ).tree;
      const expectedMerkleRoot3 = await buildRelayerRefundTreeWithUnassignedLeafIds([leaf5, leaf6, leaf2, leaf1]);
      expect(merkleRoot3.getHexRoot()).to.equal(expectedMerkleRoot3.getHexRoot());
    });
    it("amountToReturn is non 0", async function () {
      await updateAllClients();

      // Submit 1 deposit to make `netSendAmount` for one chain negative.
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

      await enableRoutesOnHubPool(hubPool, [
        { destinationChainId: 100, destinationToken: erc20_2, l1Token: l1Token_1 },
      ]);
      await updateAllClients();

      // Since amountToReturn is dependent on netSendAmount in pool rebalance leaf for same chain and token,
      // let's fetch it. We'll move the token transfer threshold lower to make sure netSendAmount is negative.
      await configStore.updateTokenConfig(
        l1Token_1.address,
        JSON.stringify({
          rateModel: sampleRateModel,
          transferThreshold: toBNWei("0.0001").toString(),
        })
      );
      await updateAllClients();

      // Since there was 1 unfilled deposit, there should be 1 relayer refund root for the deposit origin chain
      // where amountToReturn = -netSendAmount.
      const leaf1 = {
        chainId: originChainId,
        amountToReturn: amountToDeposit,
        l2TokenAddress: erc20_1.address,
        refundAddresses: [],
        refundAmounts: [],
      };

      await updateAllClients();
      const merkleRoot1 = dataworkerInstance.buildRelayerRefundRoot(
        DEFAULT_BLOCK_RANGE_FOR_CHAIN,
        spokePoolClients
      ).tree;
      const expectedMerkleRoot1 = await buildRelayerRefundTreeWithUnassignedLeafIds([leaf1]);
      expect(merkleRoot1.getHexRoot()).to.equal(expectedMerkleRoot1.getHexRoot());

      // Now, submit fills on the origin chain such that the refunds for the origin chain need to be split amongst
      // more than one leaves. Moreover, make sure not to fully fill the deposit so that the netSendAmount is negative,
      // and check that the amountToReturn is 0 for all except the first leaf.
      const deposit1 = await buildDeposit(
        configStoreClient,
        hubPoolClient,
        spokePool_2,
        erc20_2,
        l1Token_1,
        depositor,
        originChainId,
        amountToDeposit
      );
      const allSigners: SignerWithAddress[] = await ethers.getSigners();
      expect(
        allSigners.length >= MAX_REFUNDS_PER_RELAYER_REFUND_LEAF + 1,
        "ethers.getSigners doesn't have enough signers"
      );
      const sortedAllSigners = [...allSigners].sort((x, y) => compareAddresses(x.address, y.address));
      const fills = [];
      for (let i = 0; i < MAX_REFUNDS_PER_RELAYER_REFUND_LEAF + 1; i++) {
        await setupTokensForWallet(spokePool_1, sortedAllSigners[i], [erc20_1]);
        fills.push(await buildFillForRepaymentChain(spokePool_1, sortedAllSigners[i], deposit1, 0.1, originChainId));
      }
      const unfilledAmount = amountToDeposit.sub(fills[fills.length - 1].totalFilledAmount);
      const refundAmountPerFill = getRefund(deposit1.amount, deposit1.realizedLpFeePct)
        .mul(toBNWei("0.1"))
        .div(toBNWei("1"));
      const newLeaf1 = {
        chainId: originChainId,
        // amountToReturn should be deposit amount minus ALL fills for origin chain minus unfilled amount for slow fill.
        amountToReturn: amountToDeposit
          .sub(refundAmountPerFill.mul(toBN(MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF + 1)))
          .sub(unfilledAmount),
        l2TokenAddress: erc20_1.address,
        refundAddresses: sortedAllSigners.slice(0, MAX_REFUNDS_PER_RELAYER_REFUND_LEAF).map((x) => x.address),
        refundAmounts: Array(MAX_REFUNDS_PER_RELAYER_REFUND_LEAF).fill(refundAmountPerFill),
      };
      const leaf2 = {
        chainId: originChainId,
        amountToReturn: toBN(0),
        l2TokenAddress: erc20_1.address,
        refundAddresses: [sortedAllSigners[MAX_REFUNDS_PER_RELAYER_REFUND_LEAF].address],
        refundAmounts: [refundAmountPerFill],
      };

      // There should also be a new leaf for the second deposit we submitted on the destination chain.
      const leaf3 = {
        chainId: destinationChainId,
        amountToReturn: amountToDeposit,
        l2TokenAddress: erc20_2.address,
        refundAddresses: [],
        refundAmounts: [],
      };

      await updateAllClients();
      const merkleRoot2 = dataworkerInstance.buildRelayerRefundRoot(
        DEFAULT_BLOCK_RANGE_FOR_CHAIN,
        spokePoolClients
      ).tree;
      const expectedMerkleRoot2 = await buildRelayerRefundTreeWithUnassignedLeafIds([newLeaf1, leaf2, leaf3]);
      expect(merkleRoot2.getHexRoot()).to.equal(expectedMerkleRoot2.getHexRoot());
    });
  });
  describe("Build pool rebalance root", function () {
    it("One L1 token full lifecycle: testing runningBalances and realizedLpFees counters", async function () {
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
      expect(
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients).leaves
      ).to.deep.equal([]);
      expect(
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients).tree.getHexRoot()
      ).to.equal(EMPTY_MERKLE_ROOT);

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
      const unfilledAmount1 = deposit1.amount.sub(fill1.totalFilledAmount);

      // Partial fill deposit2
      const fill2 = await buildFillForRepaymentChain(spokePool_1, depositor, deposit2, 0.3, originChainId);
      const fill3 = await buildFillForRepaymentChain(spokePool_1, depositor, deposit2, 0.2, originChainId);
      const unfilledAmount3 = deposit2.amount.sub(fill3.totalFilledAmount);

      // Partial fill deposit3
      const fill4 = await buildFillForRepaymentChain(spokePool_1, depositor, deposit3, 0.5, originChainId);
      const unfilledAmount4 = deposit3.amount.sub(fill4.totalFilledAmount);
      const blockOfLastFill = await hubPool.provider.getBlockNumber();

      // Prior to root bundle being executed, running balances should be:
      // - deposited amount
      // + partial fill refund
      // + slow fill amount
      const expectedRunningBalances: RunningBalances = {
        [destinationChainId]: {
          [l1Token_1.address]: getRefundForFills([fill1])
            .sub(deposit2.amount.add(deposit3.amount))
            .add(unfilledAmount1),
        },
        [originChainId]: {
          [l1Token_1.address]: getRefundForFills([fill2, fill3, fill4])
            .sub(deposit1.amount)
            .add(unfilledAmount3)
            .add(unfilledAmount4),
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
      const merkleRoot1 = dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients);
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

      // The fill that fully executed the deposit was the slow fill, however, there were no partial fills sent
      // between when the slow fill amount was sent to the spoke pool (i.e. the unfilledAmount3), and the slow
      // fill execution. Therefore, the excess is 0. The unfilledAmount3 also needs to be subtracted from the
      // running balances since slowFill2 fully filled the matching deposit.
      updateAndCheckExpectedPoolRebalanceCounters(
        expectedRunningBalances,
        expectedRealizedLpFees,
        unfilledAmount3.mul(toBN(-1)),
        getRealizedLpFeeForFills([slowFill2]),
        [slowFill2.destinationChainId],
        [l1Token_1.address],
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients)
      );

      // Now, partially fill a deposit whose slow fill has NOT been executed yet.
      const fill5 = await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 0.25, destinationChainId);
      await updateAllClients();

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

      // The excess amount in the contract is now equal to the partial fill amount sent before the slow fill.
      // Again, now that the slowFill1 was sent, the unfilledAmount1 can be subtracted from running balances since its
      // no longer associated with an unfilled deposit.
      const excess = fill5.fillAmount;
      updateAndCheckExpectedPoolRebalanceCounters(
        expectedRunningBalances,
        expectedRealizedLpFees,
        getRefundForFills([fill5]).sub(unfilledAmount1).sub(excess),
        getRealizedLpFeeForFills([slowFill1, fill5]),
        [fill5.destinationChainId],
        [l1Token_1.address],
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients)
      );

      // Before executing the last slow relay leaf, completely fill the deposit. This will leave the full slow fill
      // amount remaining in the spoke pool. We also need to subtract running balances by the unfilled amount
      // for deposit3, because its now fully filled. This means we need to subtract the unfilledAmount4 twice
      // from running balances.
      const fill6 = await buildFillForRepaymentChain(spokePool_1, relayer, deposit3, 1, originChainId);
      await updateAllClients();
      updateAndCheckExpectedPoolRebalanceCounters(
        expectedRunningBalances,
        expectedRealizedLpFees,
        getRefundForFills([fill6]).sub(unfilledAmount4.mul(toBN(2))),
        getRealizedLpFeeForFills([fill6]),
        [fill6.destinationChainId],
        [l1Token_1.address],
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients)
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
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients)
      );

      // Execute root bundle so we can propose another bundle. The latest running balance emitted in this event
      // should be added to running balances.
      await timer.setCurrentTime(Number(await timer.getCurrentTime()) + refundProposalLiveness + 1);
      for (const leaf of poolRebalanceLeaves) {
        await hubPool
          .connect(dataworker)
          .executeRootBundle(...Object.values(leaf), poolRebalanceTree.getHexProof(leaf));
      }
      await updateAllClients();
      updateAndCheckExpectedPoolRebalanceCounters(
        expectedRunningBalances,
        expectedRealizedLpFees,
        startingRunningBalances,
        toBN(0),
        [originChainId, destinationChainId],
        [l1Token_1.address],
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients)
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
      const merkleRoot7 = dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients);
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
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients)
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
          1,
          destinationChainId
        );
      }
      const sortedL1Tokens = Object.keys(depositsForL1Token).sort((x, y) => compareAddresses(x, y));

      // Since there are more L1 tokens than the max allowed per chain, dataworker should split the L1's into two
      // leaves. There should be 4 L1 tokens for the origin and destination chain since a fill and deposit was sent
      // for each newly created token mapping. Check that the leaves are sorted by L2 chain ID and then by L1 token
      // address.
      await updateAllClients();
      const merkleRoot1 = dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients);
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
      expect(
        dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients).tree.getHexRoot()
      ).to.equal(expectedMerkleRoot.getHexRoot());
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
      const merkleRoot1 = dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients);

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
      const merkleRoot2 = dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients);
      const expectedLeaves2 = expectedLeaves1.map((leaf) => {
        return {
          ...leaf,
          runningBalances: [toBN(0)],
          netSendAmounts: leaf.runningBalances,
        };
      });
      expect(merkleRoot2.leaves).to.deep.equal(expectedLeaves2);
    });
    it("Adds latest running balances to next", async function () {
      await updateAllClients();

      // Fully execute a bundle so we can have a history of running balances.
      const startingRunningBalances = amountToDeposit.mul(5);
      const initialPoolRebalanceLeaves = buildPoolRebalanceLeaves(
        [originChainId, destinationChainId],
        [[l1Token_1.address], [l1Token_1.address]],
        [[toBN(0)], [toBN(0)]],
        [[toBN(0)], [toBN(0)]],
        [[startingRunningBalances], [startingRunningBalances]],
        [0, 0]
      );
      const startingBlock = await hubPool.provider.getBlockNumber();
      const startingTree = await buildPoolRebalanceLeafTree(initialPoolRebalanceLeaves);
      await hubPool
        .connect(dataworker)
        .proposeRootBundle([startingBlock, startingBlock], 2, startingTree.getHexRoot(), mockTreeRoot, mockTreeRoot);
      await timer.setCurrentTime(Number(await timer.getCurrentTime()) + refundProposalLiveness + 1);
      for (const leaf of initialPoolRebalanceLeaves) {
        await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaf), startingTree.getHexProof(leaf));
      }

      // Submit a deposit on origin chain. Next running balance should be previous minus deposited amount.
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

      // Should have 1 running balance leaf:
      expect(
        (await dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients)).leaves
      ).to.deep.equal([
        {
          chainId: originChainId,
          bundleLpFees: [toBN(0)],
          netSendAmounts: [toBN(0)],
          runningBalances: [startingRunningBalances.sub(amountToDeposit)],
          groupIndex: 0,
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
      ]);

      // Submit a partial fill on destination chain. This tests that the previous running balance is added to
      // running balances modified by repayments, slow fills, and deposits.
      const fill = await buildFillForRepaymentChain(spokePool_2, depositor, deposit, 0.5, destinationChainId);
      const slowFillPayment = deposit.amount.sub(fill.totalFilledAmount);
      await updateAllClients();
      expect(
        (await dataworkerInstance.buildPoolRebalanceRoot(DEFAULT_BLOCK_RANGE_FOR_CHAIN, spokePoolClients)).leaves
      ).to.deep.equal([
        {
          chainId: originChainId,
          bundleLpFees: [toBN(0)],
          netSendAmounts: [toBN(0)],
          runningBalances: [startingRunningBalances.sub(amountToDeposit)],
          groupIndex: 0,
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
        {
          chainId: destinationChainId,
          bundleLpFees: [getRealizedLpFeeForFills([fill])],
          netSendAmounts: [toBN(0)],
          runningBalances: [startingRunningBalances.add(getRefundForFills([fill])).add(slowFillPayment)],
          groupIndex: 0,
          leafId: 1,
          l1Tokens: [l1Token_1.address],
        },
      ]);
    });
  });
});
