import {
  BalanceAllocator,
  BundleDataClient,
  ConfigStoreClient,
  HubPoolClient,
  MultiCallerClient,
  SpokePoolClient,
} from "../src/clients";
import {
  CHAIN_ID_TEST_LIST,
  IMPOSSIBLE_BLOCK_RANGE,
  amountToDeposit,
  destinationChainId,
  originChainId,
  repaymentChainId,
} from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import {
  Contract,
  SignerWithAddress,
  assertPromiseError,
  buildDeposit,
  buildFill,
  buildFillForRepaymentChain,
  buildModifiedFill,
  buildSlowFill,
  buildSlowRelayLeaves,
  buildSlowRelayTree,
  ethers,
  expect,
  getDefaultBlockRange,
  getLastBlockNumber,
  sinon,
  spyLogIncludes,
} from "./utils";

import { spokePoolClientsToProviders } from "../src/common";
import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { Deposit, DepositWithBlock, Fill } from "../src/interfaces";
import { MAX_UINT_VAL, getCurrentTime, getRealizedLpFeeForFills, getRefundForFills, toBN } from "../src/utils";
import { MockSpokePoolClient } from "./mocks";
import { interfaces } from "@across-protocol/sdk-v2";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, l1Token_2: Contract, hubPool: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient, bundleDataClient: BundleDataClient;
let hubPoolClient: HubPoolClient, configStoreClient: ConfigStoreClient;
let multiCallerClient: MultiCallerClient;
let dataworkerInstance: Dataworker;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let spy: sinon.SinonSpy;

let updateAllClients: () => Promise<void>;

const ignoredDepositParams = ["logIndex", "transactionHash", "transactionIndex", "blockTimestamp"];

// TODO: Rename this file to BundleDataClient
describe("Dataworker: Load data used in all functions", async function () {
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
      l1Token_2,
      depositor,
      relayer,
      dataworkerInstance,
      spokePoolClient_1,
      spokePoolClient_2,
      spokePoolClients,
      updateAllClients,
      spy,
    } = await setupDataworker(ethers, 25, 25, 0));
    bundleDataClient = dataworkerInstance.clients.bundleDataClient;
    multiCallerClient = dataworkerInstance.clients.multiCallerClient;
  });

  it("Default conditions", async function () {
    await configStoreClient.update();

    // Throws error if hub pool client is not updated.
    await hubPoolClient.update();

    // Throws error if spoke pool clients not updated
    await assertPromiseError(bundleDataClient.loadData(getDefaultBlockRange(0), spokePoolClients), "SpokePoolClient");
    await spokePoolClient_1.update();
    await spokePoolClient_2.update();

    // Before any deposits, returns empty dictionaries.
    await updateAllClients();
    expect(await bundleDataClient.loadData(getDefaultBlockRange(1), spokePoolClients)).to.deep.equal({
      unfilledDeposits: [],
      deposits: [],
      fillsToRefund: {},
      allValidFills: [],
      bundleDepositsV3: {},
      earlyDeposits: [],
    });
  });
  describe("Computing refunds for bundles", function () {
    let fill1: Fill;
    let deposit1: Deposit;

    beforeEach(async function () {
      await updateAllClients();

      deposit1 = await buildDeposit(
        hubPoolClient,
        spokePool_1,
        erc20_1,
        l1Token_1,
        depositor,
        destinationChainId,
        amountToDeposit
      );

      await updateAllClients();

      // Submit a valid fill.
      fill1 = await buildFillForRepaymentChain(
        spokePool_2,
        relayer,
        deposit1,
        0.5,
        destinationChainId,
        erc20_2.address
      );
      await updateAllClients();
    });
    it("No validated bundle refunds", async function () {
      // Propose a bundle:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();

      // No bundle is validated so no refunds.
      const refunds = await bundleDataClient.getPendingRefundsFromValidBundles(2);
      expect(bundleDataClient.getTotalRefund(refunds, relayer.address, destinationChainId, erc20_2.address)).to.equal(
        toBN(0)
      );
    });
    it("1 validated bundle with refunds", async function () {
      // Propose a bundle:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();

      const latestBlock = await hubPool.provider.getBlockNumber();
      const blockRange = CHAIN_ID_TEST_LIST.map(() => [0, latestBlock]);
      const expectedPoolRebalanceRoot = await dataworkerInstance.buildPoolRebalanceRoot(blockRange, spokePoolClients);
      await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
      for (const leaf of expectedPoolRebalanceRoot.leaves) {
        await hubPool.executeRootBundle(
          leaf.chainId,
          leaf.groupIndex,
          leaf.bundleLpFees,
          leaf.netSendAmounts,
          leaf.runningBalances,
          leaf.leafId,
          leaf.l1Tokens,
          expectedPoolRebalanceRoot.tree.getHexProof(leaf)
        );
      }

      // Before relayer refund leaves are executed, should have pending refunds:
      await updateAllClients();
      const refunds = await bundleDataClient.getPendingRefundsFromValidBundles(2);
      expect(bundleDataClient.getTotalRefund(refunds, relayer.address, destinationChainId, erc20_2.address)).to.equal(
        getRefundForFills([fill1])
      );

      // Test edge cases of `getTotalRefund` that should return BN(0)
      expect(bundleDataClient.getTotalRefund(refunds, relayer.address, repaymentChainId, erc20_2.address)).to.equal(
        toBN(0)
      );
      expect(bundleDataClient.getTotalRefund(refunds, relayer.address, destinationChainId, erc20_1.address)).to.equal(
        toBN(0)
      );
      expect(bundleDataClient.getTotalRefund(refunds, hubPool.address, destinationChainId, erc20_2.address)).to.equal(
        toBN(0)
      );

      // Manually relay the roots to spoke pools since adapter is a dummy and won't actually relay messages.
      const validatedRootBundles = hubPoolClient.getValidatedRootBundles();
      for (const rootBundle of validatedRootBundles) {
        await spokePool_1.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
        await spokePool_2.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
      }
      await updateAllClients();

      // Execute relayer refund leaves. Send funds to spoke pools to execute the leaves.
      await erc20_2.mint(spokePool_2.address, getRefundForFills([fill1]));
      const providers = {
        ...spokePoolClientsToProviders(spokePoolClients),
        [(await hubPool.provider.getNetwork()).chainId]: hubPool.provider,
      };
      await dataworkerInstance.executeRelayerRefundLeaves(spokePoolClients, new BalanceAllocator(providers));
      await multiCallerClient.executeTransactionQueue();

      // Should now have zero pending refunds
      await updateAllClients();
      // If we call `getPendingRefundsFromLatestBundle` multiple times, there should be no error. If there is an error,
      // then it means that `getPendingRefundsFromLatestBundle` is mutating the return value of `.loadData` which is
      // stored in the bundle data client's cache. `getPendingRefundsFromLatestBundle` should instead be using a
      // deep cloned copy of `.loadData`'s output.
      await bundleDataClient.getPendingRefundsFromValidBundles(2);
      const postExecutionRefunds = await bundleDataClient.getPendingRefundsFromValidBundles(2);
      expect(
        bundleDataClient.getTotalRefund(postExecutionRefunds, relayer.address, destinationChainId, erc20_2.address)
      ).to.equal(toBN(0));
    });
    it("2 validated bundles with refunds", async function () {
      // Propose and execute bundle containing fill1:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();

      const latestBlock = await hubPool.provider.getBlockNumber();
      const blockRange = CHAIN_ID_TEST_LIST.map(() => [0, latestBlock]);
      const expectedPoolRebalanceRoot = await dataworkerInstance.buildPoolRebalanceRoot(blockRange, spokePoolClients);
      await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
      for (const leaf of expectedPoolRebalanceRoot.leaves) {
        await hubPool.executeRootBundle(
          leaf.chainId,
          leaf.groupIndex,
          leaf.bundleLpFees,
          leaf.netSendAmounts,
          leaf.runningBalances,
          leaf.leafId,
          leaf.l1Tokens,
          expectedPoolRebalanceRoot.tree.getHexProof(leaf)
        );
      }

      // Submit fill2 and propose another bundle:
      const fill2 = await buildFillForRepaymentChain(
        spokePool_2,
        relayer,
        deposit1,
        0.2,
        destinationChainId,
        erc20_2.address
      );
      await updateAllClients();

      // Propose another bundle:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();

      // Check that pending refunds include both fills after pool leaves are executed
      await bundleDataClient.getPendingRefundsFromValidBundles(2);
      expect(
        bundleDataClient.getTotalRefund(
          await bundleDataClient.getPendingRefundsFromValidBundles(2),
          relayer.address,
          destinationChainId,
          erc20_2.address
        )
      ).to.equal(getRefundForFills([fill1]));
      const latestBlock2 = await hubPool.provider.getBlockNumber();
      const blockRange2 = CHAIN_ID_TEST_LIST.map(() => [latestBlock + 1, latestBlock2]);
      const expectedPoolRebalanceRoot2 = await dataworkerInstance.buildPoolRebalanceRoot(blockRange2, spokePoolClients);
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
      await updateAllClients();
      const postSecondProposalRefunds = await bundleDataClient.getPendingRefundsFromValidBundles(2);
      expect(
        bundleDataClient.getTotalRefund(postSecondProposalRefunds, relayer.address, destinationChainId, erc20_2.address)
      ).to.equal(getRefundForFills([fill1, fill2]));

      // Manually relay the roots to spoke pools since adapter is a dummy and won't actually relay messages.
      const validatedRootBundles = hubPoolClient.getValidatedRootBundles();
      for (const rootBundle of validatedRootBundles) {
        await spokePool_1.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
        await spokePool_2.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
      }
      await updateAllClients();

      // Execute refunds and test that pending refund amounts are decreasing.
      await erc20_2.mint(spokePool_2.address, getRefundForFills([fill1, fill2]));
      const providers = {
        ...spokePoolClientsToProviders(spokePoolClients),
        [(await hubPool.provider.getNetwork()).chainId]: hubPool.provider,
      };
      await dataworkerInstance.executeRelayerRefundLeaves(spokePoolClients, new BalanceAllocator(providers));
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();
      const postExecutedRefunds = await bundleDataClient.getPendingRefundsFromValidBundles(2);
      expect(
        bundleDataClient.getTotalRefund(postExecutedRefunds, relayer.address, destinationChainId, erc20_2.address)
      ).to.equal(toBN(0));
    });
    it("Refunds in next bundle", async function () {
      // When there is no history of proposed root bundles:
      const refunds = await bundleDataClient.getNextBundleRefunds();
      expect(bundleDataClient.getRefundsFor(refunds, relayer.address, destinationChainId, erc20_2.address)).to.equal(
        getRefundForFills([fill1])
      );

      // Propose a bundle:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();

      // Execute the bundle:
      const latestBlock = await hubPool.provider.getBlockNumber();
      const blockRange = CHAIN_ID_TEST_LIST.map(() => [0, latestBlock]);
      const expectedPoolRebalanceRoot = await dataworkerInstance.buildPoolRebalanceRoot(blockRange, spokePoolClients);
      await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
      for (const leaf of expectedPoolRebalanceRoot.leaves) {
        await hubPool.executeRootBundle(
          leaf.chainId,
          leaf.groupIndex,
          leaf.bundleLpFees,
          leaf.netSendAmounts,
          leaf.runningBalances,
          leaf.leafId,
          leaf.l1Tokens,
          expectedPoolRebalanceRoot.tree.getHexProof(leaf)
        );
      }

      // Next bundle should include fill2.
      const fill2 = await buildFillForRepaymentChain(
        spokePool_2,
        relayer,
        deposit1,
        0.4,
        destinationChainId,
        erc20_2.address
      );
      await updateAllClients();
      expect(
        bundleDataClient.getRefundsFor(
          await bundleDataClient.getNextBundleRefunds(),
          relayer.address,
          destinationChainId,
          erc20_2.address
        )
      ).to.equal(getRefundForFills([fill2]));

      // If we now propose a bundle including fill2, then next bundle will still fill2
      // because the bundle hasn't been fully executed yet. So its conceivable that this latest bundle is disputed,
      // so we still want to capture fill2 in the potential "next bundle" category.
      await updateAllClients();
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();
      expect(
        bundleDataClient.getRefundsFor(
          await bundleDataClient.getNextBundleRefunds(),
          relayer.address,
          destinationChainId,
          erc20_2.address
        )
      ).to.equal(getRefundForFills([fill2]));
    });
  });
  it("Returns unfilled deposits", async function () {
    await updateAllClients();

    const deposit1 = {
      ...(await buildDeposit(
        hubPoolClient,
        spokePool_1,
        erc20_1,
        l1Token_1,
        depositor,
        destinationChainId,
        amountToDeposit
      )),
      blockNumber: await getLastBlockNumber(),
    } as DepositWithBlock;
    deposit1.quoteBlockNumber = (await hubPoolClient.computeRealizedLpFeePct(deposit1, l1Token_1.address)).quoteBlock;

    const deposit2 = {
      ...(await buildDeposit(
        hubPoolClient,
        spokePool_2,
        erc20_2,
        l1Token_2,
        depositor,
        originChainId,
        amountToDeposit
      )),
      blockNumber: await getLastBlockNumber(),
    } as DepositWithBlock;
    deposit2.quoteBlockNumber = (await hubPoolClient.computeRealizedLpFeePct(deposit2, l1Token_2.address)).quoteBlock;

    // Unfilled deposits are ignored.
    await updateAllClients();
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(0), spokePoolClients);
    expect(data1.unfilledDeposits).to.deep.equal([]);

    // Two deposits with no fills per destination chain ID.
    await buildDeposit(
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit.mul(toBN(2))
    );
    await buildDeposit(
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_2,
      depositor,
      originChainId,
      amountToDeposit.mul(toBN(2))
    );
    await updateAllClients();
    const data2 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(1), spokePoolClients);
    expect(data2.unfilledDeposits).to.deep.equal([]);

    // Fills that don't match deposits do not affect unfilledAmount counter.
    // Note: We switch the spoke pool address in the following fills from the fills that eventually do match with
    //       the deposits.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, { ...deposit1, depositId: 99 }, 0.5);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, { ...deposit2, depositId: 99 }, 0.25);

    // One partially filled deposit per destination chain ID.
    const fill1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.5);
    const fill2 = await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 0.25);
    await updateAllClients();
    const data3 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(3), spokePoolClients);
    expect(data3.unfilledDeposits)
      .excludingEvery(ignoredDepositParams)
      .to.deep.equal([
        {
          unfilledAmount: amountToDeposit.sub(fill1.fillAmount),
          deposit: deposit1,
        },
        {
          unfilledAmount: amountToDeposit.sub(fill2.fillAmount),
          deposit: deposit2,
        },
      ]);

    // If block range does not cover fills, then unfilled deposits are not included.
    expect(
      (await dataworkerInstance.clients.bundleDataClient.loadData(IMPOSSIBLE_BLOCK_RANGE, spokePoolClients))
        .unfilledDeposits
    ).to.deep.equal([]);

    // All deposits are fulfilled; unfilled deposits that are fully filled should be ignored.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 1);
    await updateAllClients();
    const data5 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(4), spokePoolClients);
    expect(data5.unfilledDeposits).to.deep.equal([]);

    // TODO: Add test where deposit has matched fills but none were the first ever fill for that deposit (i.e. where
    // fill.amount != fill.totalAmountFilled). This can only be done after adding in block range constraints on Fill
    // events queried.

    // Fill events emitted by slow relays are included in unfilled amount calculations.
    const deposit5 = {
      ...(await buildDeposit(
        hubPoolClient,
        spokePool_2,
        erc20_2,
        l1Token_1,
        depositor,
        originChainId,
        amountToDeposit
      )),
      blockNumber: await getLastBlockNumber(),
      blockTimestamp: (await spokePool_2.provider.getBlock(await getLastBlockNumber())).timestamp,
    } as DepositWithBlock;
    deposit5.quoteBlockNumber = (await hubPoolClient.computeRealizedLpFeePct(deposit5, l1Token_1.address)).quoteBlock;
    const fill3 = await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit5, 0.25);

    // One unfilled deposit that we're going to slow fill:
    await updateAllClients();
    const data6 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), spokePoolClients);
    expect(data6.unfilledDeposits)
      .excludingEvery(ignoredDepositParams)
      .to.deep.equal([{ unfilledAmount: amountToDeposit.sub(fill3.fillAmount), deposit: deposit5 }]);

    const slowRelays = buildSlowRelayLeaves([deposit5]);
    const tree = await buildSlowRelayTree(slowRelays);
    await spokePool_1.relayRootBundle(tree.getHexRoot(), tree.getHexRoot());
    await buildSlowFill(spokePool_1, fill3, depositor, []);

    // The unfilled deposit has now been fully filled.
    await updateAllClients();
    const data7 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(6), spokePoolClients);
    expect(data7.unfilledDeposits).to.deep.equal([]);
  });
  it("Returns fills to refund", async function () {
    await updateAllClients();

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
      l1Token_2,
      depositor,
      originChainId,
      amountToDeposit
    );

    // Submit a valid fill.
    const fill1 = {
      ...(await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.5)),
      blockTimestamp: (await spokePool_2.provider.getBlock(await getLastBlockNumber())).timestamp,
    };
    await updateAllClients();
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(0), spokePoolClients);
    expect(data1.fillsToRefund)
      .excludingEvery(ignoredDepositParams)
      .to.deep.equal({
        [destinationChainId]: {
          [erc20_2.address]: {
            fills: [fill1],
            refunds: { [relayer.address]: getRefundForFills([fill1]) },
            totalRefundAmount: getRefundForFills([fill1]),
            realizedLpFees: getRealizedLpFeeForFills([fill1]),
          },
        },
      });

    // If block range does not cover fills, then they are not included
    expect(
      (await dataworkerInstance.clients.bundleDataClient.loadData(IMPOSSIBLE_BLOCK_RANGE, spokePoolClients))
        .fillsToRefund
    ).to.deep.equal({});

    // Submit fills without matching deposits. These should be ignored by the client.
    // Note: Switch just the relayer fee % to make fills invalid. This also ensures that client is correctly
    // distinguishing between valid speed up fills with modified relayer fee %'s and invalid fill relay calls
    // with all correct fill params except for the relayer fee %.
    await buildFill(spokePool_1, erc20_1, depositor, relayer, { ...deposit2, relayerFeePct: toBN(0) }, 0.5);
    await updateAllClients();
    const data3 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(1), spokePoolClients);
    expect(data3.fillsToRefund).to.deep.equal(data1.fillsToRefund);

    // Submit fills that match deposit in all properties except for realized lp fee % or l1 token. These should be
    // ignored because the rate model client deems them invalid. These are the two properties added to the deposit
    // object by the spoke pool client.
    // Note: This fill has identical deposit data to fill2 except for the realized lp fee %.
    await buildFill(
      spokePool_1,
      erc20_1,
      depositor,
      relayer,
      { ...deposit2, realizedLpFeePct: deposit2.realizedLpFeePct?.div(toBN(2)) },
      0.25
    );
    // Note: This fill has identical deposit data to fill2 except for the destination token being different
    await buildFill(spokePool_1, erc20_2, depositor, relayer, deposit2, 0.25);
    await updateAllClients();
    const data4 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(2), spokePoolClients);
    expect(data4.fillsToRefund).to.deep.equal(data1.fillsToRefund);

    // Slow relay fills are added.
    const deposit3 = await buildDeposit(
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_2,
      depositor,
      originChainId,
      amountToDeposit
    );
    const fill3 = {
      ...(await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit3, 0.25)),
      blockTimestamp: (await spokePool_1.provider.getBlock(await getLastBlockNumber())).timestamp,
    };

    const slowRelays = buildSlowRelayLeaves([deposit3]);
    const tree = await buildSlowRelayTree(slowRelays);
    await spokePool_1.relayRootBundle(tree.getHexRoot(), tree.getHexRoot());
    const slowFill3 = {
      ...(await buildSlowFill(spokePool_1, fill3, depositor, [])),
      blockTimestamp: (await spokePool_1.provider.getBlock(await getLastBlockNumber())).timestamp,
    };

    await updateAllClients();
    const data5 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(3), spokePoolClients);
    const expectedData5 = {
      ...data4.fillsToRefund,
      [slowFill3.destinationChainId]: {
        [erc20_1.address]: {
          fills: [fill3, slowFill3], // Slow fill gets added to fills list
          realizedLpFees: getRealizedLpFeeForFills([fill3, slowFill3]), // Slow fill does affect realized LP fee
          totalRefundAmount: getRefundForFills([fill3]),
          refunds: { [relayer.address]: getRefundForFills([fill3]) },
        },
      },
    };
    expect(data5.fillsToRefund).excludingEvery(ignoredDepositParams).to.deep.equal(expectedData5);

    // Speed up relays are included. Re-use the same fill information
    const fill4 = await buildModifiedFill(spokePool_2, depositor, relayer, fill1, 2, 0.1);
    expect(fill4.totalFilledAmount.gt(fill4.fillAmount), "speed up fill didn't match original deposit").to.be.true;
    await updateAllClients();
    const data6 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(4), spokePoolClients);
    expect(data6.fillsToRefund[destinationChainId][erc20_2.address].totalRefundAmount).to.equal(
      getRefundForFills([fill1, fill4])
    );
    expect(data6.fillsToRefund[destinationChainId][erc20_2.address].realizedLpFees).to.equal(
      getRealizedLpFeeForFills([fill1, fill4])
    );
  });
  it("Returns deposits", async function () {
    await updateAllClients();

    const deposit1 = await buildDeposit(
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );
    const blockNumber = await spokePool_2.provider.getBlockNumber();
    const realizedLpFeePctData = await hubPoolClient.computeRealizedLpFeePct(
      { ...deposit1, blockNumber },
      l1Token_1.address
    );

    // Should include all deposits, even those not matched by a relay
    await updateAllClients();
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), spokePoolClients);
    expect(data1.deposits)
      .excludingEvery(["blockTimestamp", "logIndex", "transactionHash", "transactionIndex"])
      .to.deep.equal([{ ...deposit1, quoteBlockNumber: realizedLpFeePctData.quoteBlock, blockNumber }]);

    // If block range does not cover deposits, then they are not included
    expect(
      (await dataworkerInstance.clients.bundleDataClient.loadData(IMPOSSIBLE_BLOCK_RANGE, spokePoolClients)).deposits
    ).to.deep.equal([]);
  });

  describe.skip("V3 Events", function () {
    // TODO: Move these functions into /utils
    const generateV2Deposit = (spokePoolClient: MockSpokePoolClient): Event => {
      const originToken = erc20_1.address;
      const message = "0x";
      const quoteTimestamp = getCurrentTime() - 10;
      return spokePoolClient.deposit({
        originToken,
        message,
        quoteTimestamp,
        destinationChainId,
        blockNumber: spokePoolClient_1.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.v2DepositWithBlock);
    };
    const generateV3Deposit = (spokePoolClient: MockSpokePoolClient): ethers.Event => {
      const inputToken = erc20_1.address;
      const message = "0x";
      const quoteTimestamp = getCurrentTime() - 10;
      return spokePoolClient.depositV3({
        inputToken,
        message,
        quoteTimestamp,
        destinationChainId,
        blockNumber: spokePoolClient_1.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.v3DepositWithBlock);
    };
    it("Returns deposits", async function () {
      await updateAllClients();

      const v3OriginSpokePoolClient = new MockSpokePoolClient(
        spokePoolClient_1.logger,
        spokePoolClient_1.spokePool,
        spokePoolClient_1.chainId,
        spokePoolClient_1.deploymentBlock
      );
      // Inject a series of v2DepositWithBlock and v3DepositWithBlock events.
      const depositV3Events: Event[] = [];
      const depositV2Events: Event[] = [];

      for (let idx = 0; idx < 10; ++idx) {
        depositV3Events.push(generateV3Deposit(v3OriginSpokePoolClient));
        depositV2Events.push(generateV2Deposit(v3OriginSpokePoolClient));
      }
      await v3OriginSpokePoolClient.update(["FundsDeposited", "V3FundsDeposited"]);

      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
        ...spokePoolClients,
        [originChainId]: v3OriginSpokePoolClient,
      });

      // client correctly sorts V2/V3 events into expected dictionaries.
      expect(data1.deposits.map((deposit) => deposit.depositId)).to.deep.equal(
        depositV2Events.map((event) => event.args.depositId)
      );
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].map((deposit) => deposit.depositId)).to.deep.equal(
        depositV3Events.map((event) => event.args.depositId)
      );
    });
    //   it("Returns fills to refund", async function () {});
    //   it("Returns slow fills", async function () {});
    //   it("Returns expired deposits", async function () {});
    //   it("Returns unexecutable slow fills", async function () {});
    //   it("Can fetch historical deposits not found in spoke pool client's memory", async function () {});
    //   it("Returns refunds from pending bundle", async function () {});
    //   it("Returns refunds from last two bundle", async function () {});
    //   it("Returns refunds from next bundle", async function () {});
  });

  it("Can fetch historical deposits not found in spoke pool client's memory", async function () {
    // Send a deposit.
    await updateAllClients();
    const deposit1 = await buildDeposit(
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit1Block = await spokePool_1.provider.getBlockNumber();

    // Construct a spoke pool client with a small search range that would not include the deposit.
    spokePoolClient_1.firstBlockToSearch = deposit1Block + 1;
    spokePoolClient_1.eventSearchConfig.fromBlock = spokePoolClient_1.firstBlockToSearch;
    await updateAllClients();
    expect(spokePoolClient_1.getDeposits().length).to.equal(0);

    // Send a fill now and force the bundle data client to query for the historical deposit.
    const fill1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.5);
    await updateAllClients();
    expect(spokePoolClient_2.getFills().length).to.equal(1);
    expect(spokePoolClient_1.getDeposits().length).to.equal(0);

    // For queryHistoricalDepositForFill to work we need to have a deployment block set for the spoke pool client.
    const bundleData = await bundleDataClient.loadData(getDefaultBlockRange(0), spokePoolClients);
    expect(spyLogIncludes(spy, -2, "Located deposit outside of SpokePoolClient's search range")).is.true;
    expect(bundleData.fillsToRefund)
      .excludingEvery(["blockTimestamp"])
      .to.deep.equal({
        [destinationChainId]: {
          [erc20_2.address]: {
            fills: [fill1],
            refunds: { [relayer.address]: getRefundForFills([fill1]) },
            totalRefundAmount: getRefundForFills([fill1]),
            realizedLpFees: getRealizedLpFeeForFills([fill1]),
          },
        },
      });
    expect(bundleData.deposits).to.deep.equal([]);
    expect(bundleData.allValidFills.length).to.equal(1);
    expect(bundleData.unfilledDeposits)
      .excludingEvery(["logIndex", "transactionHash", "transactionIndex", "blockNumber", "quoteBlockNumber"])
      .to.deep.equal([
        {
          unfilledAmount: amountToDeposit.sub(fill1.fillAmount),
          deposit: { ...deposit1 },
        },
      ]);
  });
});
