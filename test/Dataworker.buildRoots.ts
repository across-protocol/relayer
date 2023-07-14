import {
  buildSlowRelayTree,
  buildSlowRelayLeaves,
  buildFillForRepaymentChain,
  enableRoutesOnHubPool,
  createSpyLogger,
  lastSpyLogIncludes,
  deepEqualsWithBigNumber,
  buildRefundRequest,
} from "./utils";
import { SignerWithAddress, expect, ethers, Contract, toBN, toBNWei, setupTokensForWallet } from "./utils";
import { buildDeposit, buildFill, buildSlowFill, BigNumber, deployNewTokenMapping } from "./utils";
import { buildRelayerRefundTreeWithUnassignedLeafIds, constructPoolRebalanceTree } from "./utils";
import { buildPoolRebalanceLeafTree, sampleRateModel, getDefaultBlockRange } from "./utils";
import { HubPoolClient, ConfigStoreClient, SpokePoolClient } from "../src/clients";
import {
  amountToDeposit,
  destinationChainId,
  originChainId,
  mockTreeRoot,
  buildPoolRebalanceLeaves,
  modifyRelayHelper,
} from "./constants";
import { MAX_REFUNDS_PER_RELAYER_REFUND_LEAF, MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF } from "./constants";
import { refundProposalLiveness, CHAIN_ID_TEST_LIST } from "./constants";
import { setupFastDataworker } from "./fixtures/Dataworker.Fixture";
import { Deposit, Fill, RunningBalances } from "../src/interfaces";
import { getRealizedLpFeeForFills, getRefundForFills, getRefund, EMPTY_MERKLE_ROOT, winston } from "../src/utils";
import { compareAddresses } from "../src/utils";

// Tested
import { Dataworker } from "../src/dataworker/Dataworker";
import { MockUBAClient } from "./mocks";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, hubPool: Contract, timer: Contract, configStore: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress, dataworker: SignerWithAddress;

let hubPoolClient: HubPoolClient, configStoreClient: ConfigStoreClient, spokePoolClient_1: SpokePoolClient;
let dataworkerInstance: Dataworker, spokePoolClient_2: SpokePoolClient;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let spy: sinon.SinonSpy, spyLogger: winston.Logger;

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
      spy,
      spyLogger,
      spokePoolClient_1,
      spokePoolClient_2,
      updateAllClients,
    } = await setupFastDataworker(ethers));
  });
  it("Build slow relay root", async function () {
    await updateAllClients();

    // Submit deposits for multiple destination chain IDs.
    const deposit1 = await buildDeposit(
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit2 = await buildDeposit(
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );
    const deposit3 = await buildDeposit(
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit4 = await buildDeposit(
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
    const expectedMerkleRoot1 = await buildSlowRelayTree(expectedSlowRelayLeaves);
    const merkleRoot1 = (await dataworkerInstance.buildSlowRelayRoot(getDefaultBlockRange(0), spokePoolClients)).tree;
    expect(merkleRoot1.getHexRoot()).to.equal(expectedMerkleRoot1.getHexRoot());

    // Speeding up a deposit should have no effect on the slow root:
    const newRelayerFeePct = toBNWei(0.1337);
    const speedUpSignature = await modifyRelayHelper(
      newRelayerFeePct,
      deposit1.depositId,
      deposit1.originChainId!.toString(),
      depositor,
      deposit1.recipient,
      "0x"
    );
    await spokePool_1.speedUpDeposit(
      depositor.address,
      newRelayerFeePct,
      deposit1.depositId,
      deposit1.recipient,
      "0x",
      speedUpSignature.signature
    );
    await updateAllClients();
    expect(merkleRoot1.getHexRoot()).to.equal((await buildSlowRelayTree(expectedSlowRelayLeaves)).getHexRoot());

    // Fill deposits such that there are no unfilled deposits remaining.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 1);
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit3, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit4, 1);
    await updateAllClients();
    expect(
      (await dataworkerInstance.buildSlowRelayRoot(getDefaultBlockRange(1), spokePoolClients)).leaves
    ).to.deep.equal([]);
    expect(
      (await dataworkerInstance.buildSlowRelayRoot(getDefaultBlockRange(2), spokePoolClients)).tree.getHexRoot()
    ).to.equal(EMPTY_MERKLE_ROOT);

    // Includes slow fills triggered by "zero" (i.e. 1 wei) fills
    const deposit5 = await buildDeposit(
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );

    // Trigger slow fill with a partial fill:
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit5, 0.01);
    await updateAllClients();
    const merkleRoot2 = await dataworkerInstance.buildSlowRelayRoot(getDefaultBlockRange(3), spokePoolClients);
    const expectedMerkleRoot2 = await buildSlowRelayTree(buildSlowRelayLeaves([deposit5]));
    expect(merkleRoot2.tree.getHexRoot()).to.equal(expectedMerkleRoot2.getHexRoot());
  });
  describe("Build relayer refund root", function () {
    it("amountToReturn is 0", async function () {
      await updateAllClients();
      const poolRebalanceRoot = await dataworkerInstance.buildPoolRebalanceRoot(
        getDefaultBlockRange(0),
        spokePoolClients
      );
      expect(
        (
          await dataworkerInstance.buildRelayerRefundRoot(
            getDefaultBlockRange(0),
            spokePoolClients,
            poolRebalanceRoot.leaves,
            poolRebalanceRoot.runningBalances
          )
        ).leaves
      ).to.deep.equal([]);
      expect(
        (
          await dataworkerInstance.buildRelayerRefundRoot(
            getDefaultBlockRange(0),
            spokePoolClients,
            poolRebalanceRoot.leaves,
            poolRebalanceRoot.runningBalances
          )
        ).tree.getHexRoot()
      ).to.equal(EMPTY_MERKLE_ROOT);

      // Submit deposits for multiple L2 tokens.
      const deposit1 = await buildDeposit(
        hubPoolClient,
        spokePool_1,
        erc20_1,
        l1Token_1,
        depositor,
        destinationChainId,
        amountToDeposit
      );
      const deposit2 = await buildDeposit(
        hubPoolClient,
        spokePool_1,
        erc20_1,
        l1Token_1,
        depositor,
        destinationChainId,
        amountToDeposit
      );
      const deposit3 = await buildDeposit(
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
      await buildFillForRepaymentChain(spokePool_2, depositor, deposit2, 0.25, destinationChainId);
      await buildFillForRepaymentChain(spokePool_2, depositor, deposit2, 1, destinationChainId);
      await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 0.25, destinationChainId);
      await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 1, destinationChainId);

      const depositorBeforeRelayer = toBN(depositor.address).lt(toBN(relayer.address));
      const leaf1 = {
        chainId: destinationChainId,
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
      const poolRebalanceRoot1 = await dataworkerInstance.buildPoolRebalanceRoot(
        getDefaultBlockRange(1),
        spokePoolClients
      );
      const merkleRoot1 = (
        await dataworkerInstance.buildRelayerRefundRoot(
          getDefaultBlockRange(1),
          spokePoolClients,
          poolRebalanceRoot1.leaves,
          poolRebalanceRoot1.runningBalances
        )
      ).tree;
      const expectedMerkleRoot1 = await buildRelayerRefundTreeWithUnassignedLeafIds([leaf1]);
      expect(merkleRoot1.getHexRoot()).to.equal(expectedMerkleRoot1.getHexRoot());

      // Submit fills for multiple repayment chains. Note: Send the fills for destination tokens in the
      // reverse order of the fills we sent above to test that the data worker is correctly sorting leaves
      // by L2 token address in ascending order. Also set repayment chain ID lower than first few leaves to test
      // that these leaves come first.
      // Note: We can set a repayment chain for this fill because it is a full fill.
      await buildFillForRepaymentChain(spokePool_1, relayer, deposit3, 1, 99);
      const leaf2 = {
        chainId: 99,
        amountToReturn: toBN(0),
        l2TokenAddress: erc20_1.address,
        refundAddresses: [relayer.address],
        refundAmounts: [getRefund(deposit3.amount, deposit3.realizedLpFeePct)],
      };
      await updateAllClients();
      const poolRebalanceRoot2 = await dataworkerInstance.buildPoolRebalanceRoot(
        getDefaultBlockRange(2),
        spokePoolClients
      );
      const merkleRoot2 = (
        await dataworkerInstance.buildRelayerRefundRoot(
          getDefaultBlockRange(2),
          spokePoolClients,
          poolRebalanceRoot2.leaves,
          poolRebalanceRoot2.runningBalances
        )
      ).tree;
      const expectedMerkleRoot2 = await buildRelayerRefundTreeWithUnassignedLeafIds([leaf2, leaf1]);
      expect(merkleRoot2.getHexRoot()).to.equal(expectedMerkleRoot2.getHexRoot());

      // Splits leaf into multiple leaves if refunds > MAX_REFUNDS_PER_RELAYER_REFUND_LEAF.
      const deposit4 = await buildDeposit(
        hubPoolClient,
        spokePool_1,
        erc20_1,
        l1Token_1,
        depositor,
        destinationChainId,
        amountToDeposit
      );
      // @dev: slice(10) so we don't have duplicates between allSigners and depositor/relayer/etc.
      const allSigners: SignerWithAddress[] = (await ethers.getSigners()).slice(10);
      expect(
        allSigners.length >= MAX_REFUNDS_PER_RELAYER_REFUND_LEAF + 1,
        "ethers.getSigners doesn't have enough signers"
      ).to.be.true;
      for (let i = 0; i < MAX_REFUNDS_PER_RELAYER_REFUND_LEAF + 1; i++) {
        await setupTokensForWallet(spokePool_2, allSigners[i], [erc20_2]);
        await buildFillForRepaymentChain(spokePool_2, allSigners[i], deposit4, 0.01 + i * 0.01, destinationChainId);
      }
      // Note: Higher refund amounts for same chain and L2 token should come first, so we test that by increasing
      // the fill amount in the above loop for each fill. Ultimately, the latest fills send the most tokens and
      // should come in the first leaf.
      await updateAllClients();
      const poolRebalanceRoot3 = await dataworkerInstance.buildPoolRebalanceRoot(
        getDefaultBlockRange(3),
        spokePoolClients
      );
      const merkleRoot3 = (
        await dataworkerInstance.buildRelayerRefundRoot(
          getDefaultBlockRange(3),
          spokePoolClients,
          poolRebalanceRoot3.leaves,
          poolRebalanceRoot3.runningBalances
        )
      ).tree;

      // The order should be:
      // - Sort by repayment chain ID in ascending order, so leaf2 goes first since its the only one with an overridden
      // repayment chain ID.
      // - Sort by refund amount. So, the refund addresses in leaf1 go first, then the latest refunds. Each leaf can
      // have a maximum number of refunds so add the latest refund (recall the latest fills from the last loop
      // were the largest).
      leaf1.refundAddresses.push(allSigners[3].address);
      leaf1.refundAmounts.push(
        getRefund(deposit4.amount, deposit4.realizedLpFeePct).mul(toBNWei("0.04")).div(toBNWei("1"))
      );
      const leaf3 = {
        chainId: destinationChainId,
        amountToReturn: toBN(0),
        l2TokenAddress: erc20_2.address,
        refundAddresses: [allSigners[2].address, allSigners[1].address, allSigners[0].address],
        refundAmounts: [
          getRefund(deposit4.amount, deposit4.realizedLpFeePct).mul(toBNWei("0.03")).div(toBNWei("1")),
          getRefund(deposit4.amount, deposit4.realizedLpFeePct).mul(toBNWei("0.02")).div(toBNWei("1")),
          getRefund(deposit4.amount, deposit4.realizedLpFeePct).mul(toBNWei("0.01")).div(toBNWei("1")),
        ],
      };
      const expectedMerkleRoot3 = await buildRelayerRefundTreeWithUnassignedLeafIds([leaf2, leaf1, leaf3]);
      expect(merkleRoot3.getHexRoot()).to.equal(expectedMerkleRoot3.getHexRoot());
    });
    it("amountToReturn is non 0", async function () {
      await updateAllClients();

      // Submit 1 deposit to make `netSendAmount` for one chain negative.
      await buildDeposit(
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
      const poolRebalanceRoot1 = await dataworkerInstance.buildPoolRebalanceRoot(
        getDefaultBlockRange(0),
        spokePoolClients
      );
      const merkleRoot1 = (
        await dataworkerInstance.buildRelayerRefundRoot(
          getDefaultBlockRange(0),
          spokePoolClients,
          poolRebalanceRoot1.leaves,
          poolRebalanceRoot1.runningBalances
        )
      ).tree;
      const expectedMerkleRoot1 = await buildRelayerRefundTreeWithUnassignedLeafIds([leaf1]);
      expect(merkleRoot1.getHexRoot()).to.equal(expectedMerkleRoot1.getHexRoot());

      // Now, submit fills on the origin chain such that the refunds for the origin chain need to be split amongst
      // more than one leaves. Moreover, make sure not to fully fill the deposit so that the netSendAmount is negative,
      // and check that the amountToReturn is 0 for all except the first leaf.
      const deposit1 = await buildDeposit(
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
      ).to.be.true;
      const sortedAllSigners = [...allSigners].sort((x, y) => compareAddresses(x.address, y.address));
      const fills = [];
      for (let i = 0; i < MAX_REFUNDS_PER_RELAYER_REFUND_LEAF + 1; i++) {
        await setupTokensForWallet(spokePool_1, sortedAllSigners[i], [erc20_1]);
        fills.push(await buildFillForRepaymentChain(spokePool_1, sortedAllSigners[i], deposit1, 0.1, originChainId));
      }
      const unfilledAmount = getRefund(
        amountToDeposit.sub(fills[fills.length - 1].totalFilledAmount),
        deposit1.realizedLpFeePct
      );
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
      const poolRebalanceRoot2 = await dataworkerInstance.buildPoolRebalanceRoot(
        getDefaultBlockRange(1),
        spokePoolClients
      );
      const merkleRoot2 = (
        await dataworkerInstance.buildRelayerRefundRoot(
          getDefaultBlockRange(1),
          spokePoolClients,
          poolRebalanceRoot2.leaves,
          poolRebalanceRoot2.runningBalances
        )
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
        (await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(0), spokePoolClients)).leaves
      ).to.deep.equal([]);
      expect(
        (await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(0), spokePoolClients)).tree.getHexRoot()
      ).to.equal(EMPTY_MERKLE_ROOT);

      // Submit deposits for multiple L2 tokens.
      const deposit1 = await buildDeposit(
        hubPoolClient,
        spokePool_1,
        erc20_1,
        l1Token_1,
        depositor,
        destinationChainId,
        amountToDeposit
      );
      const deposit2 = await buildDeposit(
        hubPoolClient,
        spokePool_2,
        erc20_2,
        l1Token_1,
        depositor,
        originChainId,
        amountToDeposit.mul(toBN(2))
      );
      const deposit3 = await buildDeposit(
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
      const fill1Block = await spokePool_2.provider.getBlockNumber();
      const unfilledAmount1 = getRefund(deposit1.amount.sub(fill1.totalFilledAmount), fill1.realizedLpFeePct);

      // Partial fill deposit2
      const fill2 = await buildFillForRepaymentChain(spokePool_1, depositor, deposit2, 0.3, originChainId);
      const fill3 = await buildFillForRepaymentChain(spokePool_1, depositor, deposit2, 0.2, originChainId);
      const unfilledAmount3 = getRefund(deposit2.amount.sub(fill3.totalFilledAmount), fill3.realizedLpFeePct);

      // Partial fill deposit3
      const fill4 = await buildFillForRepaymentChain(spokePool_1, depositor, deposit3, 0.5, originChainId);
      const unfilledAmount4 = getRefund(deposit3.amount.sub(fill4.totalFilledAmount), fill4.realizedLpFeePct);
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
      const merkleRoot1 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(1), spokePoolClients);
      expect(merkleRoot1.runningBalances).to.deep.equal(expectedRunningBalances);
      expect(merkleRoot1.realizedLpFees).to.deep.equal(expectedRealizedLpFees);

      // Construct slow relay root which should include deposit1 and deposit2
      const slowRelayLeaves = buildSlowRelayLeaves(deposits);
      const expectedSlowRelayTree = await buildSlowRelayTree(slowRelayLeaves);

      // Construct pool rebalance root so we can publish slow relay root to spoke pool:
      const { tree: poolRebalanceTree, leaves: poolRebalanceLeaves } = await constructPoolRebalanceTree(
        expectedRunningBalances,
        expectedRealizedLpFees
      );

      // Propose root bundle so that we can test that the dataworker looks up ProposeRootBundle events properly.
      await hubPool.connect(dataworker).proposeRootBundle(
        Array(CHAIN_ID_TEST_LIST.length).fill(blockOfLastFill), // Set current block number as end block for bundle. Its important that we set a block for every possible chain ID.
        // so all fills to this point are before these blocks.
        poolRebalanceLeaves.length, // poolRebalanceLeafCount.
        poolRebalanceTree.getHexRoot(), // poolRebalanceRoot
        mockTreeRoot, // relayerRefundRoot
        expectedSlowRelayTree.getHexRoot() // slowRelayRoot
      );
      const pendingRootBundle = await hubPool.rootBundleProposal();

      // Execute root bundle so that this root bundle is not ignored by dataworker.
      await timer.connect(dataworker).setCurrentTime(pendingRootBundle.challengePeriodEndTimestamp + 1);
      for (const leaf of poolRebalanceLeaves) {
        await hubPool
          .connect(dataworker)
          .executeRootBundle(...Object.values(leaf), poolRebalanceTree.getHexProof(leaf));
      }

      await updateAllClients();
      for (const leaf of poolRebalanceLeaves) {
        const { runningBalance } = hubPoolClient.getRunningBalanceBeforeBlockForChain(
          await hubPool.provider.getBlockNumber(),
          leaf.chainId.toNumber(),
          l1Token_1.address
        );
        // Since we fully executed the root bundle, we need to add the running balance for the chain to the expected
        // running balances since the data worker adds these prior running balances.
        expectedRunningBalances[leaf.chainId.toNumber()][l1Token_1.address] =
          expectedRunningBalances[leaf.chainId.toNumber()][l1Token_1.address].add(runningBalance);
      }

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
          slowRelayLeaves.find((_) => _.relayData.destinationChainId === chainToExecuteSlowRelay.toString())
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
        await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(2), spokePoolClients)
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
          slowRelayLeaves.find((_) => _.relayData.destinationChainId === secondChainToExecuteSlowRelay.toString())
        )
      );
      await updateAllClients();

      // Test that we can still look up the excess if the first fill for the same deposit as the one slow filed
      //  is older than the spoke pool client's lookback window.
      const { spy, spyLogger } = createSpyLogger();
      const shortRangeSpokePoolClient = new SpokePoolClient(
        spyLogger,
        spokePool_2,
        hubPoolClient,
        destinationChainId,
        spokePoolClients[destinationChainId].deploymentBlock,
        { fromBlock: fill1Block + 1 } // Set fromBlock to now, after first fill for same deposit as the slowFill1
      );
      await shortRangeSpokePoolClient.update();
      expect(shortRangeSpokePoolClient.getFills().length).to.equal(2); // We should only be able to see 2 fills
      await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(3), {
        ...spokePoolClients,
        [destinationChainId]: shortRangeSpokePoolClient,
      });

      // Should have queried for historical fills that it can no longer see.
      expect(lastSpyLogIncludes(spy, "Queried for fill that triggered a slow fill")).to.be.true;

      // The excess amount in the contract is now equal to the partial fill amount sent before the slow fill.
      // Again, now that the slowFill1 was sent, the unfilledAmount1 can be subtracted from running balances since its
      // no longer associated with an unfilled deposit.
      const excess = getRefund(fill5.fillAmount, fill5.realizedLpFeePct);

      updateAndCheckExpectedPoolRebalanceCounters(
        expectedRunningBalances,
        expectedRealizedLpFees,
        getRefundForFills([fill5]).sub(unfilledAmount1).sub(excess),
        getRealizedLpFeeForFills([slowFill1, fill5]),
        [fill5.destinationChainId],
        [l1Token_1.address],
        await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(4), spokePoolClients)
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
        await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(5), spokePoolClients)
      );

      // Now demonstrate that for a deposit whose first fill is NOT contained in a ProposeRootBundle event, it won't
      // affect running balance:
      // Submit another deposit and partial fill, this should mine at a block after the ending block of the last
      // ProposeRootBundle block range.
      // Fully fill the deposit.
      // Update client and construct root. This should increase running balance by total deposit amount, to refund
      // the slow relay.
      const deposit4 = await buildDeposit(
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
        await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(6), spokePoolClients)
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
      const merkleRoot7 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(7), spokePoolClients);
      expect(merkleRoot7.runningBalances).to.deep.equal(expectedRunningBalances);
      expect(merkleRoot7.realizedLpFees).to.deep.equal(expectedRealizedLpFees);

      // A full fill not following any partial fills is treated as a normal fill: increases the running balance.
      const deposit5 = await buildDeposit(
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
        await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(8), spokePoolClients)
      );
    });
    it("Loads fills needed to compute slow fill excesses", async function () {
      await updateAllClients();

      // Send deposit
      // Send two partial fills
      const deposit1 = await buildDeposit(
        hubPoolClient,
        spokePool_1,
        erc20_1,
        l1Token_1,
        depositor,
        destinationChainId,
        amountToDeposit
      );
      const fill1 = await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 0.5, destinationChainId);
      const fill2 = await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 0.25, destinationChainId);
      const fill2Block = await spokePool_2.provider.getBlockNumber();

      // Produce bundle and execute pool leaves. Should produce a slow fill. Don't execute it.
      await updateAllClients();
      const merkleRoot1 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(1), spokePoolClients);
      await hubPool
        .connect(dataworker)
        .proposeRootBundle(
          Array(CHAIN_ID_TEST_LIST.length).fill(fill2Block),
          merkleRoot1.leaves.length,
          merkleRoot1.tree.getHexRoot(),
          mockTreeRoot,
          mockTreeRoot
        );

      const pendingRootBundle = await hubPool.rootBundleProposal();
      await timer.connect(dataworker).setCurrentTime(pendingRootBundle.challengePeriodEndTimestamp + 1);
      for (let i = 0; i < merkleRoot1.leaves.length; i++) {
        const leaf = merkleRoot1.leaves[i];
        await hubPool
          .connect(dataworker)
          .executeRootBundle(
            leaf.chainId,
            leaf.groupIndex,
            leaf.bundleLpFees,
            leaf.netSendAmounts,
            leaf.runningBalances,
            i,
            leaf.l1Tokens,
            merkleRoot1.tree.getHexProof(leaf)
          );
      }

      // Create new spoke client with a search range that would miss fill1.
      const destinationChainSpokePoolClient = new SpokePoolClient(
        createSpyLogger().spyLogger,
        spokePool_2,
        configStoreClient,
        destinationChainId,
        spokePoolClients[destinationChainId].deploymentBlock,
        { fromBlock: fill2Block + 1 }
      );

      // Send a third partial fill, this will produce an excess since a slow fill is already in flight for the deposit.
      const fill3 = await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 0.25, destinationChainId);
      await updateAllClients();
      await destinationChainSpokePoolClient.update();
      expect(destinationChainSpokePoolClient.getFills().length).to.equal(1);
      const blockRange2 = Array(CHAIN_ID_TEST_LIST.length).fill([
        fill2Block + 1,
        await spokePool_2.provider.getBlockNumber(),
      ]);
      const merkleRoot2 = await dataworkerInstance.buildPoolRebalanceRoot(blockRange2, {
        ...spokePoolClients,
        [destinationChainId]: destinationChainSpokePoolClient,
      });
      const l1TokenForFill = merkleRoot2.leaves[0].l1Tokens[0];

      // New running balance should be fill1 + fill2 + fill3 + slowFillAmount - excess
      // excess should be the amount remaining after fill2. Since the slow fill was never
      // executed, the excess should be equal to the slow fill amount so they should cancel out.
      const expectedExcess = getRefund(fill2.amount.sub(fill2.totalFilledAmount), fill2.realizedLpFeePct);
      expect(merkleRoot2.runningBalances[destinationChainId][l1TokenForFill]).to.equal(
        getRefundForFills([fill1, fill2, fill3])
      );

      expect(lastSpyLogIncludes(spy, "Fills triggering excess returns from L2")).to.be.true;
      expect(
        spy.getCall(-1).lastArg.fillsTriggeringExcesses[destinationChainId][fill2.destinationToken][0].excess
      ).to.equal(expectedExcess.toString());
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
      const merkleRoot1 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(0), spokePoolClients);
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
              netSendAmounts: l1TokensToIncludeInLeaf.map(() => toBN(0)), // Should be 0 since running balances are
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
        (await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(1), spokePoolClients)).tree.getHexRoot()
      ).to.equal(expectedMerkleRoot.getHexRoot());
    });
    it("Two L1 tokens, one repayment", async function () {
      // This test checks that the dataworker can handle the case where there are multiple L1 tokens on a chain but
      // at least one of the L1 tokens doesn't have any `bundleLpFees`. Failing this test suggests that the dataworker
      // is incorrectly assuming that all repayments occur on the same chain.
      const { l1Token: l1TokenNew, l2Token: l2TokenNew } = await deployNewTokenMapping(
        depositor,
        relayer,
        spokePool_1,
        spokePool_2,
        configStore,
        hubPool,
        amountToDeposit.mul(toBN(100))
      );
      await updateAllClients(); // Update client to be aware of new token mapping so we can build deposit correctly.

      const depositA = await buildDeposit(
        hubPoolClient,
        spokePool_1,
        l2TokenNew,
        l1TokenNew,
        depositor,
        destinationChainId,
        amountToDeposit
      );

      // Send a second deposit on the same origin chain so that the pool rebalance leaf for the origin chain has
      // running balances and bundle LP fees for two L1 tokens. This allows us to create the situation where one of
      // the bundle LP fees and running balances is zero for an L1 token.
      const depositB = await buildDeposit(
        hubPoolClient,
        spokePool_1,
        erc20_1,
        l1Token_1,
        depositor,
        destinationChainId,
        amountToDeposit
      );

      // Submit fill linked to new L1 token with repayment chain set to the origin chain. Since the deposits in this
      // test were submitted on the origin chain, we want to be refunded on the same chain to force the dataworker
      // to construct a leaf with multiple L1 tokens, only one of which has bundleLpFees.
      const fillA = await buildFillForRepaymentChain(spokePool_2, depositor, depositA, 1, originChainId);

      await updateAllClients();
      const merkleRoot1 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(0), spokePoolClients);
      const orderedL1Tokens = [l1Token_1.address, l1TokenNew.address].sort((addressA, addressB) =>
        compareAddresses(addressA, addressB)
      );
      const expectedLeaf = {
        groupIndex: 0,
        chainId: originChainId,
        bundleLpFees: [
          orderedL1Tokens[0] === l1Token_1.address ? toBN(0) : getRealizedLpFeeForFills([fillA]),
          orderedL1Tokens[0] === l1TokenNew.address ? toBN(0) : getRealizedLpFeeForFills([fillA]),
        ],
        netSendAmounts: [toBN(0), toBN(0)],
        runningBalances: [
          orderedL1Tokens[0] === l1Token_1.address
            ? depositB.amount.mul(toBN(-1))
            : depositA.amount.sub(getRefundForFills([fillA])).mul(toBN(-1)),
          orderedL1Tokens[0] === l1TokenNew.address
            ? depositB.amount.mul(toBN(-1))
            : depositA.amount.sub(getRefundForFills([fillA])).mul(toBN(-1)),
        ],
        l1Tokens: orderedL1Tokens,
        leafId: 0,
      };
      expect(deepEqualsWithBigNumber(merkleRoot1.leaves, [expectedLeaf])).to.be.true;
    });
    it("Token transfer exceeds threshold", async function () {
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
      const fill = await buildFillForRepaymentChain(spokePool_2, depositor, deposit, 1, destinationChainId);
      await updateAllClients();
      const merkleRoot1 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(0), spokePoolClients);

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
      expect(deepEqualsWithBigNumber(merkleRoot1.leaves, expectedLeaves1)).to.be.true;

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
      const merkleRoot2 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(1), spokePoolClients);
      const expectedLeaves2 = expectedLeaves1.map((leaf) => {
        return {
          ...leaf,
          runningBalances: [toBN(0)],
          netSendAmounts: leaf.runningBalances,
        };
      });
      expect(deepEqualsWithBigNumber(merkleRoot2.leaves, expectedLeaves2)).to.be.true;
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
      const merkleRoot1 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(0), spokePoolClients);
      const expectedLeaves1 = [
        {
          chainId: originChainId,
          bundleLpFees: [toBN(0)],
          netSendAmounts: [toBN(0)],
          runningBalances: [startingRunningBalances.sub(amountToDeposit)],
          groupIndex: 0,
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
      ];
      expect(deepEqualsWithBigNumber(merkleRoot1.leaves, expectedLeaves1)).to.be.true;

      // Submit a partial fill on destination chain. This tests that the previous running balance is added to
      // running balances modified by repayments, slow fills, and deposits.
      const fill = await buildFillForRepaymentChain(spokePool_2, depositor, deposit, 0.5, destinationChainId);
      const slowFillPayment = getRefund(deposit.amount.sub(fill.totalFilledAmount), deposit.realizedLpFeePct);
      await updateAllClients();
      const expectedLeaves2 = [
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
      ];
      const merkleRoot2 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(1), spokePoolClients);
      expect(deepEqualsWithBigNumber(merkleRoot2.leaves, expectedLeaves2)).to.be.true;
    });
    it("Spoke pool balance threshold, above and below", async function () {
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
      const fill = await buildFillForRepaymentChain(spokePool_2, depositor, deposit, 1, destinationChainId);
      await updateAllClients();
      await configStore.updateTokenConfig(
        l1Token_1.address,
        JSON.stringify({
          rateModel: sampleRateModel,
          transferThreshold: "0",
          spokeTargetBalances: {
            [originChainId]: {
              // Threshold above the deposit amount.
              threshold: amountToDeposit.mul(2).toString(),
              target: amountToDeposit.div(2).toString(),
            },
            [destinationChainId]: {
              // Threshold above the deposit amount.
              threshold: amountToDeposit.mul(2).toString(),
              target: amountToDeposit.div(2).toString(),
            },
          },
        })
      );
      await configStoreClient.update();
      const merkleRoot1 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(0), spokePoolClients);

      const orderedChainIds = [originChainId, destinationChainId].sort((x, y) => x - y);
      const expectedLeaves1 = orderedChainIds
        .map((chainId) => {
          return {
            groupIndex: 0,
            chainId,
            bundleLpFees: chainId === originChainId ? [toBN(0)] : [getRealizedLpFeeForFills([fill])],
            // Running balance is <<< spoke pool balance threshold, so running balance should be non-zero and net send
            // amount should be 0 for the origin chain. This should _not affect_ the destination chain, since spoke
            // pool balance thresholds only apply to funds being sent from spoke to hub.
            runningBalances: chainId === originChainId ? [deposit.amount.mul(toBN(-1))] : [toBN(0)],
            netSendAmounts: chainId === originChainId ? [toBN(0)] : [getRefundForFills([fill])],
            l1Tokens: [l1Token_1.address],
          };
        })
        .map((leaf, i) => {
          return { ...leaf, leafId: i };
        });
      expect(deepEqualsWithBigNumber(merkleRoot1.leaves, expectedLeaves1)).to.be.true;

      // Now set the threshold much lower than the running balance and check that running balances for all
      // chains gets set to 0 and net send amount is equal to the running balance. This also tests that the
      // dataworker is comparing the absolute value of the running balance with the threshold, not the signed value.
      await configStore.updateTokenConfig(
        l1Token_1.address,
        JSON.stringify({
          rateModel: sampleRateModel,
          transferThreshold: "0",
          spokeTargetBalances: {
            [originChainId]: {
              // Threshold is equal to the deposit amount.
              threshold: amountToDeposit.toString(),
              target: amountToDeposit.div(2).toString(),
            },
            [destinationChainId]: {
              // Threshold above the deposit amount.
              threshold: amountToDeposit.mul(2).toString(),
              target: amountToDeposit.div(2).toString(),
            },
          },
        })
      );
      await configStoreClient.update();
      const merkleRoot2 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(1), spokePoolClients);
      // We expect to have the target remaining on the spoke.
      // We expect to transfer the total deposit amount minus the remaining spoke balance.
      const expectedSpokeBalance = amountToDeposit.div(2);
      const expectedTransferAmount = amountToDeposit.sub(expectedSpokeBalance);
      const expectedLeaves2 = expectedLeaves1.map((leaf) => {
        return {
          ...leaf,
          runningBalances: leaf.chainId === originChainId ? [expectedSpokeBalance.mul(-1)] : leaf.runningBalances,
          netSendAmounts: leaf.chainId === originChainId ? [expectedTransferAmount.mul(-1)] : leaf.netSendAmounts,
        };
      });
      expect(deepEqualsWithBigNumber(merkleRoot2.leaves, expectedLeaves2)).to.be.true;
    });
    it("Spoke pool balance threshold, below transfer threshold", async function () {
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
      const fill = await buildFillForRepaymentChain(spokePool_2, depositor, deposit, 1, destinationChainId);
      await updateAllClients();
      await configStore.updateTokenConfig(
        l1Token_1.address,
        JSON.stringify({
          rateModel: sampleRateModel,
          transferThreshold: amountToDeposit.add(1).toString(),
          spokeTargetBalances: {
            [originChainId]: {
              // Threshold above the deposit amount.
              threshold: amountToDeposit.toString(),
              target: amountToDeposit.div(2).toString(),
            },
            [destinationChainId]: {
              // Threshold above the deposit amount.
              threshold: amountToDeposit.mul(2).toString(),
              target: amountToDeposit.div(2).toString(),
            },
          },
        })
      );
      await configStoreClient.update();
      const merkleRoot1 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(0), spokePoolClients);

      const orderedChainIds = [originChainId, destinationChainId].sort((x, y) => x - y);
      const expectedLeaves1 = orderedChainIds
        .map((chainId) => {
          return {
            groupIndex: 0,
            chainId,
            bundleLpFees: chainId === originChainId ? [toBN(0)] : [getRealizedLpFeeForFills([fill])],
            // Running balance is below the transfer threshold, so the spoke balance threshold should have no impact.
            runningBalances: chainId === originChainId ? [deposit.amount.mul(toBN(-1))] : [getRefundForFills([fill])],
            netSendAmounts: [toBN(0)],
            l1Tokens: [l1Token_1.address],
          };
        })
        .map((leaf, i) => {
          return { ...leaf, leafId: i };
        });
      expect(deepEqualsWithBigNumber(merkleRoot1.leaves, expectedLeaves1)).to.be.true;
      // Now set the threshold much lower than the running balance and check that running balances for all
      // chains gets set to 0 and net send amount is equal to the running balance. This also tests that the
      // dataworker is comparing the absolute value of the running balance with the threshold, not the signed value.
      await configStore.updateTokenConfig(
        l1Token_1.address,
        JSON.stringify({
          rateModel: sampleRateModel,
          transferThreshold: "0",
          spokeTargetBalances: {
            [originChainId]: {
              // Threshold is equal to the deposit amount.
              threshold: amountToDeposit.toString(),
              target: amountToDeposit.div(2).toString(),
            },
            [destinationChainId]: {
              // Threshold above the deposit amount.
              threshold: amountToDeposit.mul(2).toString(),
              target: amountToDeposit.div(2).toString(),
            },
          },
        })
      );
      await configStoreClient.update();
      const merkleRoot2 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(1), spokePoolClients);
      // We expect to have the target remaining on the spoke.
      // We expect to transfer the total deposit amount minus the remaining spoke balance.
      const expectedSpokeBalance = amountToDeposit.div(2);
      const expectedTransferAmount = amountToDeposit.sub(expectedSpokeBalance);
      const expectedLeaves2 = expectedLeaves1.map((leaf) => {
        return {
          ...leaf,
          runningBalances: leaf.chainId === originChainId ? [expectedSpokeBalance.mul(-1)] : [toBN(0)],
          netSendAmounts:
            leaf.chainId === originChainId ? [expectedTransferAmount.mul(-1)] : [getRefundForFills([fill])],
        };
      });
      expect(deepEqualsWithBigNumber(merkleRoot2.leaves, expectedLeaves2)).to.be.true;
    });
  });
  describe("UBA Root Bundles", function () {
    let ubaClient: MockUBAClient;
    const l1TokenSymbol = "L1Token1";
    beforeEach(async function () {
      await updateAllClients();
      ubaClient = new MockUBAClient(
        dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers,
        [l1TokenSymbol],
        hubPoolClient,
        spokePoolClients,
        spyLogger
      );
    });
    describe("Build pool rebalance root", function () {
      it("> 0 flows", async function () {
        ubaClient.setFlows(originChainId, l1TokenSymbol, [
          {
            flow: {
              ...spokePoolClient_1.getFills()[0],
            },
            systemFee: {
              lpFee: BigNumber.from(0),
              depositBalancingFee: BigNumber.from(0),
              systemFee: BigNumber.from(0),
            },
            relayerFee: {
              relayerGasFee: BigNumber.from(0),
              relayerCapitalFee: BigNumber.from(0),
              relayerBalancingFee: BigNumber.from(0),
              relayerFee: BigNumber.from(0),
              amountTooLow: false,
            },
            runningBalance: toBNWei("1"),
            incentiveBalance: toBNWei("1"),
            netRunningBalanceAdjustment: toBNWei("1"),
          },
        ]);

        const blockRanges = dataworkerInstance._getNextProposalBlockRanges(spokePoolClients);
        if (!blockRanges) {
          throw new Error("Can't propose new bundle");
        }
        const { poolRebalanceLeaves } = dataworkerInstance._UBA_buildPoolRebalanceLeaves(
          blockRanges,
          [originChainId, destinationChainId],
          ubaClient
        );
        expect(
          deepEqualsWithBigNumber(poolRebalanceLeaves[0], {
            chainId: originChainId,
            bundleLpFees: [BigNumber.from(0)],
            netSendAmounts: [toBNWei("1")],
            runningBalances: [toBNWei("1"), toBNWei("1")],
            groupIndex: 0,
            leafId: 0,
            l1Tokens: [l1Token_1.address],
          })
        ).to.be.true;
      });
      it("0 flows", async function () {
        const blockRanges = dataworkerInstance._getNextProposalBlockRanges(spokePoolClients);
        if (!blockRanges) {
          throw new Error("Can't propose new bundle");
        }
        const { poolRebalanceLeaves } = dataworkerInstance._UBA_buildPoolRebalanceLeaves(
          blockRanges,
          [originChainId, destinationChainId],
          ubaClient
        );
        expect(poolRebalanceLeaves.length).to.be.equal(0);
      });
    });
    describe("Build relayer refund root", function () {
      it("amountToReturn is 0", async function () {
        await updateAllClients();
        // No UBA flows in this test so all amounts to return will be 0
        const { poolRebalanceLeaves } = await dataworkerInstance._UBA_buildPoolRebalanceLeaves(
          getDefaultBlockRange(0),
          [originChainId, destinationChainId],
          ubaClient
        );
        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
          getDefaultBlockRange(0),
          spokePoolClients,
          true
        );
        expect(
          (
            await dataworkerInstance._UBA_buildRelayerRefundLeaves(
              data1.fillsToRefund,
              poolRebalanceLeaves,
              getDefaultBlockRange(0)
            )
          ).leaves
        ).to.deep.equal([]);

        // Submit deposits for multiple L2 tokens.
        const deposit1 = await buildDeposit(
          hubPoolClient,
          spokePool_1,
          erc20_1,
          l1Token_1,
          depositor,
          destinationChainId,
          amountToDeposit
        );
        const deposit2 = await buildDeposit(
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
        await updateAllClients();
        await buildFillForRepaymentChain(spokePool_2, depositor, deposit2, 0.25, destinationChainId);
        await buildFillForRepaymentChain(spokePool_2, depositor, deposit2, 1, destinationChainId);
        await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 0.25, destinationChainId);
        await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 1, destinationChainId);

        const depositorBeforeRelayer = toBN(depositor.address).lt(toBN(relayer.address));
        const leaf1 = {
          chainId: destinationChainId,
          amountToReturn: toBN(0),
          l2TokenAddress: erc20_2.address,
          refundAddresses: [
            depositorBeforeRelayer ? depositor.address : relayer.address,
            depositorBeforeRelayer ? relayer.address : depositor.address,
          ], // Sorted ascending alphabetically
          refundAmounts: [
            getRefund(deposit1.amount, deposit1.realizedLpFeePct),
            getRefund(deposit2.amount, deposit2.realizedLpFeePct),
          ], // Refund amounts should aggregate across all fills.
        };

        await updateAllClients();
        const data2 = await dataworkerInstance.clients.bundleDataClient.loadData(
          getDefaultBlockRange(1),
          spokePoolClients,
          true
        );
        const relayerRefundLeaves1 = await dataworkerInstance._UBA_buildRelayerRefundLeaves(
          data2.fillsToRefund,
          poolRebalanceLeaves,
          getDefaultBlockRange(1)
        );
        expect(relayerRefundLeaves1.leaves.length).to.equal(1);
        deepEqualsWithBigNumber(relayerRefundLeaves1.leaves[0], { ...leaf1, leafId: 0 });

        // Splits leaf into multiple leaves if refunds > MAX_REFUNDS_PER_RELAYER_REFUND_LEAF.
        const deposit4 = await buildDeposit(
          hubPoolClient,
          spokePool_1,
          erc20_1,
          l1Token_1,
          depositor,
          destinationChainId,
          amountToDeposit
        );
        // @dev: slice(10) so we don't have duplicates between allSigners and depositor/relayer/etc.
        const allSigners: SignerWithAddress[] = (await ethers.getSigners()).slice(10);
        expect(
          allSigners.length >= MAX_REFUNDS_PER_RELAYER_REFUND_LEAF + 1,
          "ethers.getSigners doesn't have enough signers"
        ).to.be.true;
        for (let i = 0; i < MAX_REFUNDS_PER_RELAYER_REFUND_LEAF + 1; i++) {
          await setupTokensForWallet(spokePool_2, allSigners[i], [erc20_2]);
          await buildFillForRepaymentChain(spokePool_2, allSigners[i], deposit4, 0.01 + i * 0.01, destinationChainId);
        }
        // Note: Higher refund amounts for same chain and L2 token should come first, so we test that by increasing
        // the fill amount in the above loop for each fill. Ultimately, the latest fills send the most tokens and
        // should come in the first leaf.
        await updateAllClients();
        const data4 = await dataworkerInstance.clients.bundleDataClient.loadData(
          getDefaultBlockRange(3),
          spokePoolClients,
          true
        );
        const relayerRefundLeaves3 = await dataworkerInstance._UBA_buildRelayerRefundLeaves(
          data4.fillsToRefund,
          poolRebalanceLeaves,
          getDefaultBlockRange(3)
        );
        expect(relayerRefundLeaves3.leaves.length).to.equal(2);

        // The order should be:
        // - Sort by repayment chain ID in ascending order, so leaf2 goes first since its the only one with an overridden
        // repayment chain ID.
        // - Sort by refund amount. So, the refund addresses in leaf1 go first, then the latest refunds. Each leaf can
        // have a maximum number of refunds so add the latest refund (recall the latest fills from the last loop
        // were the largest).
        leaf1.refundAddresses.push(allSigners[3].address);
        leaf1.refundAmounts.push(
          getRefund(deposit4.amount, deposit4.realizedLpFeePct).mul(toBNWei("0.04")).div(toBNWei("1"))
        );
        const leaf3 = {
          chainId: destinationChainId,
          amountToReturn: toBN(0),
          l2TokenAddress: erc20_2.address,
          refundAddresses: [allSigners[2].address, allSigners[1].address, allSigners[0].address],
          refundAmounts: [
            getRefund(deposit4.amount, deposit4.realizedLpFeePct).mul(toBNWei("0.03")).div(toBNWei("1")),
            getRefund(deposit4.amount, deposit4.realizedLpFeePct).mul(toBNWei("0.02")).div(toBNWei("1")),
            getRefund(deposit4.amount, deposit4.realizedLpFeePct).mul(toBNWei("0.01")).div(toBNWei("1")),
          ],
        };
        deepEqualsWithBigNumber(relayerRefundLeaves3.leaves[0], { ...leaf1, leafId: 0 });
        deepEqualsWithBigNumber(relayerRefundLeaves3.leaves[1], { ...leaf3, leafId: 1 });
      });
      it("amountToReturn is non 0", async function () {
        await updateAllClients();

        ubaClient.setFlows(originChainId, l1TokenSymbol, [
          {
            flow: {
              ...spokePoolClient_1.getFills()[0],
            },
            systemFee: {
              lpFee: BigNumber.from(0),
              depositBalancingFee: BigNumber.from(0),
              systemFee: BigNumber.from(0),
            },
            relayerFee: {
              relayerGasFee: BigNumber.from(0),
              relayerCapitalFee: BigNumber.from(0),
              relayerBalancingFee: BigNumber.from(0),
              relayerFee: BigNumber.from(0),
              amountTooLow: false,
            },
            runningBalance: toBNWei("1"),
            incentiveBalance: toBNWei("2"),
            netRunningBalanceAdjustment: toBNWei("-1"),
          },
        ]);

        const blockRanges = dataworkerInstance._getNextProposalBlockRanges(spokePoolClients);
        if (!blockRanges) {
          throw new Error("Can't propose new bundle");
        }
        const { poolRebalanceLeaves } = dataworkerInstance._UBA_buildPoolRebalanceLeaves(
          blockRanges,
          [originChainId, destinationChainId],
          ubaClient
        );

        // For the UBA, the token transfer threshold shouldn't  matter so set it absurdly high.
        await configStore.updateTokenConfig(
          l1Token_1.address,
          JSON.stringify({
            rateModel: sampleRateModel,
            transferThreshold: toBNWei("1000000").toString(),
          })
        );
        await updateAllClients();

        // This leaf's amountToReturn should be non zero since the UBA client was injected with a flow
        // with a negative netRunningBalanceAdjustment
        const leaf1 = {
          chainId: originChainId,
          amountToReturn: poolRebalanceLeaves[0].netSendAmounts[0].mul(toBN(-1)),
          l2TokenAddress: erc20_1.address,
          refundAddresses: [],
          refundAmounts: [],
        };
        const relayerRefundLeaves1 = await dataworkerInstance._UBA_buildRelayerRefundLeaves(
          {},
          poolRebalanceLeaves,
          blockRanges
        );
        expect(relayerRefundLeaves1.leaves.length).to.equal(1);
        deepEqualsWithBigNumber(relayerRefundLeaves1.leaves[0], { ...leaf1, leafId: 0 });

        // Now, submit fills on the origin chain such that the refunds for the origin chain need to be split amongst
        // more than one leaves.
        const deposit1 = await buildDeposit(
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
        ).to.be.true;
        const sortedAllSigners = [...allSigners].sort((x, y) => compareAddresses(x.address, y.address));
        const fills = [];
        for (let i = 0; i < MAX_REFUNDS_PER_RELAYER_REFUND_LEAF + 1; i++) {
          await setupTokensForWallet(spokePool_1, sortedAllSigners[i], [erc20_1]);
          fills.push(await buildFillForRepaymentChain(spokePool_1, sortedAllSigners[i], deposit1, 0.1, originChainId));
        }
        const refundAmountPerFill = getRefund(deposit1.amount, deposit1.realizedLpFeePct)
          .mul(toBNWei("0.1"))
          .div(toBNWei("1"));
        const newLeaf1 = {
          chainId: originChainId,
          // amountToReturn should be deposit amount minus ALL fills for origin chain minus unfilled amount for slow fill.
          amountToReturn: poolRebalanceLeaves[0].netSendAmounts[0].mul(toBN(-1)),
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

        await updateAllClients();
        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
          getDefaultBlockRange(1),
          spokePoolClients,
          true
        );
        const relayerRefundLeaves2 = await dataworkerInstance._UBA_buildRelayerRefundLeaves(
          data1.fillsToRefund,
          poolRebalanceLeaves,
          getDefaultBlockRange(1)
        );
        expect(relayerRefundLeaves2.leaves.length).to.equal(2);
        deepEqualsWithBigNumber(relayerRefundLeaves2.leaves[0], { ...newLeaf1, leafId: 0 });
        deepEqualsWithBigNumber(relayerRefundLeaves2.leaves[1], { ...leaf2, leafId: 1 });
      });
      it("Refunds are included in UBA mode", async function () {
        await updateAllClients();
        const { poolRebalanceLeaves } = await dataworkerInstance._UBA_buildPoolRebalanceLeaves(
          getDefaultBlockRange(0),
          [originChainId, destinationChainId],
          ubaClient
        );

        // Fill deposit and request refund on origin chain which is NOT the destination chain.
        const deposit1 = await buildDeposit(
          hubPoolClient,
          spokePool_1,
          erc20_1,
          l1Token_1,
          depositor,
          destinationChainId,
          amountToDeposit
        );

        await updateAllClients();
        await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 1, originChainId);

        await updateAllClients();
        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
          getDefaultBlockRange(1),
          spokePoolClients,
          true
        );
        const relayerRefundLeaves1 = await dataworkerInstance._UBA_buildRelayerRefundLeaves(
          data1.fillsToRefund,
          poolRebalanceLeaves,
          getDefaultBlockRange(1)
        );
        expect(relayerRefundLeaves1.leaves.length).to.equal(0);

        // Now, send a refund:
        await buildRefundRequest(spokePool_1, relayer, spokePoolClient_2.getFills()[0], erc20_1.address);
        await updateAllClients();
        const data2 = await dataworkerInstance.clients.bundleDataClient.loadData(
          getDefaultBlockRange(2),
          spokePoolClients,
          true
        );
        const relayerRefundLeaves2 = await dataworkerInstance._UBA_buildRelayerRefundLeaves(
          data2.fillsToRefund,
          poolRebalanceLeaves,
          getDefaultBlockRange(2)
        );
        const leaf1 = {
          chainId: originChainId,
          amountToReturn: toBN(0),
          l2TokenAddress: erc20_1.address,
          refundAddresses: [relayer.address],
          refundAmounts: [getRefund(deposit1.amount, deposit1.realizedLpFeePct)],
        };
        deepEqualsWithBigNumber(relayerRefundLeaves2.leaves[0], { ...leaf1, leafId: 0 });
      });
    });
    describe("Build slow relay root", function () {
      it("Maps unfilled deposit to UBA flow", async function () {
        await updateAllClients();

        // Submit deposits for multiple destination chain IDs.
        const deposit1 = await buildDeposit(
          hubPoolClient,
          spokePool_1,
          erc20_1,
          l1Token_1,
          depositor,
          destinationChainId,
          amountToDeposit
        );

        // Add fills for each deposit so dataworker includes deposits as slow relays:
        await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.1);

        // Returns expected merkle root where leaves are ordered by origin chain ID and then deposit ID
        // (ascending).
        await updateAllClients();

        const { unfilledDeposits } = await dataworkerInstance.clients.bundleDataClient.loadData(
          getDefaultBlockRange(0),
          spokePoolClients
        );

        // If the flow that triggered the slow relay is not in the UBA flows, then expect an error. This should
        // never happen in production because each flow that could trigger a slow relay will be included in the UBA
        // flows. If that deposit never gets fully filled, then it will appear as an `unfilledDeposit` returned by
        // `loadData`. If it does get fully filled, it will remain a UBA flow but not returned by `loadData`.
        expect(() =>
          dataworkerInstance._UBA_buildSlowRelayLeaves(ubaClient, getDefaultBlockRange(0), unfilledDeposits)
        ).to.throw(`No matching outflow found for deposit ID ${deposit1.depositId}`);

        const expectedRelayerBalancingFee = toBNWei("0.025");
        ubaClient.setFlows(deposit1.destinationChainId, l1TokenSymbol, [
          {
            flow: {
              ...spokePoolClient_2.getFills()[0],
            },
            systemFee: {
              lpFee: BigNumber.from(0),
              depositBalancingFee: BigNumber.from(0),
              systemFee: BigNumber.from(0),
            },
            relayerFee: {
              relayerGasFee: BigNumber.from(0),
              relayerCapitalFee: BigNumber.from(0),
              relayerBalancingFee: expectedRelayerBalancingFee,
              relayerFee: BigNumber.from(0),
              amountTooLow: false,
            },
            runningBalance: toBNWei("1"),
            incentiveBalance: toBNWei("1"),
            netRunningBalanceAdjustment: toBNWei("1"),
          },
        ]);
        const slowRelayLeaves = dataworkerInstance._UBA_buildSlowRelayLeaves(
          ubaClient,
          getDefaultBlockRange(0),
          unfilledDeposits
        );
        expect(slowRelayLeaves.leaves.length).to.equal(1);
        const expectedSlowRelayLeaves = buildSlowRelayLeaves([deposit1], [expectedRelayerBalancingFee]);
        const expectedMerkleRoot = await buildSlowRelayTree(expectedSlowRelayLeaves);
        expect(expectedSlowRelayLeaves[0].payoutAdjustmentPct).to.equal(slowRelayLeaves.leaves[0].payoutAdjustmentPct);
        expect(expectedMerkleRoot.getHexRoot()).to.equal(slowRelayLeaves.tree.getHexRoot());

        // If loadData doesn't return unfilled deposits, then no slow fill leaves.
        expect(
          dataworkerInstance._UBA_buildSlowRelayLeaves(ubaClient, getDefaultBlockRange(0), []).leaves.length
        ).to.equal(0);
      });
    });
  });
});
