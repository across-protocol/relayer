import { expect, ethers, Contract, deployNewToken, getDefaultBlockRange, buildFillForRepaymentChain } from "./utils";
import { SignerWithAddress, buildSlowRelayTree, enableRoutesOnHubPool } from "./utils";
import { buildDeposit, buildFill, buildModifiedFill, buildSlowRelayLeaves, buildSlowFill } from "./utils";
import {
  SpokePoolClient,
  HubPoolClient,
  AcrossConfigStoreClient,
  BundleDataClient,
  MultiCallerClient,
  BalanceAllocator,
} from "../src/clients";
import { amountToDeposit, repaymentChainId, destinationChainId, originChainId, CHAIN_ID_TEST_LIST } from "./constants";
import { IMPOSSIBLE_BLOCK_RANGE } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";

import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { toBN, getRefundForFills, getRealizedLpFeeForFills, MAX_UINT_VAL } from "../src/utils";
import { spokePoolClientsToProviders } from "../src/dataworker/DataworkerClientHelper";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, l1Token_2: Contract, hubPool: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient, bundleDataClient: BundleDataClient;
let hubPoolClient: HubPoolClient, configStoreClient: AcrossConfigStoreClient;
let multiCallerClient: MultiCallerClient;
let dataworkerInstance: Dataworker;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let updateAllClients: () => Promise<void>;

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
      configStoreClient,
      updateAllClients,
    } = await setupDataworker(ethers, 25, 25, toBN(0), 0));
    bundleDataClient = dataworkerInstance.clients.bundleDataClient;
    multiCallerClient = dataworkerInstance.clients.multiCallerClient;
  });

  it("Default conditions", async function () {
    // Throws error if hub pool client is not updated.
    expect(() => bundleDataClient.loadData(getDefaultBlockRange(0), spokePoolClients)).to.throw(
      /HubPoolClient not updated/
    );
    await hubPoolClient.update();

    // Throws error if config store client not updated.
    expect(() => bundleDataClient.loadData(getDefaultBlockRange(0), spokePoolClients)).to.throw(
      /ConfigStoreClient not updated/
    );
    await configStoreClient.update();

    // Throws error if spoke pool clients not updated
    expect(() => bundleDataClient.loadData(getDefaultBlockRange(0), spokePoolClients)).to.throw(
      /origin SpokePoolClient/
    );
    await spokePoolClient_1.update();
    await spokePoolClient_2.update();

    // Before any deposits, returns empty dictionaries.
    await updateAllClients();
    expect(bundleDataClient.loadData(getDefaultBlockRange(1), spokePoolClients)).to.deep.equal({
      unfilledDeposits: [],
      deposits: [],
      fillsToRefund: {},
      allValidFills: [],
    });
  });
  describe("Computing refunds for bundle", function () {
    let fill1, deposit1;
    beforeEach(async function () {
      await updateAllClients();

      deposit1 = await buildDeposit(
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
    it("Refunds in latest bundle when latest is pending", async function () {
      // Propose a bundle:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();

      const refunds = await bundleDataClient.getPendingRefundsFromLatestBundle();
      expect(bundleDataClient.getRefundsFor(refunds, relayer.address, destinationChainId, erc20_2.address)).to.equal(
        getRefundForFills([fill1])
      );

      // Test edge cases of `getRefundsFor` that should return BN(0)
      expect(bundleDataClient.getRefundsFor(refunds, relayer.address, repaymentChainId, erc20_2.address)).to.equal(
        toBN(0)
      );
      expect(bundleDataClient.getRefundsFor(refunds, relayer.address, destinationChainId, erc20_1.address)).to.equal(
        toBN(0)
      );
      expect(bundleDataClient.getRefundsFor(refunds, hubPool.address, destinationChainId, erc20_2.address)).to.equal(
        toBN(0)
      );

      // Calling deductExecutedRefunds directly should produce same output.
      const bundle = hubPoolClient.getMostRecentProposedRootBundle(hubPoolClient.latestBlockNumber);
      const deductedRefunds = bundleDataClient.deductExecutedRefunds(refunds, bundle);
      expect(
        bundleDataClient.getRefundsFor(deductedRefunds, relayer.address, destinationChainId, erc20_2.address)
      ).to.equal(getRefundForFills([fill1]));
    });
    it("Refunds in latest bundle when latest is executed", async function () {
      // Propose a bundle:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();

      const latestBlock = await hubPool.provider.getBlockNumber();
      const blockRange = CHAIN_ID_TEST_LIST.map((_) => [0, latestBlock]);
      const expectedPoolRebalanceRoot = dataworkerInstance.buildPoolRebalanceRoot(blockRange, spokePoolClients);
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
      const refunds = await bundleDataClient.getPendingRefundsFromLatestBundle();
      expect(bundleDataClient.getRefundsFor(refunds, relayer.address, destinationChainId, erc20_2.address)).to.equal(
        getRefundForFills([fill1])
      );

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
      await bundleDataClient.getPendingRefundsFromLatestBundle();
      const postExecutionRefunds = await bundleDataClient.getPendingRefundsFromLatestBundle();
      expect(
        bundleDataClient.getRefundsFor(postExecutionRefunds, relayer.address, destinationChainId, erc20_2.address)
      ).to.equal(toBN(0));
    });
    it("Refunds in next bundle", async function () {
      // When this is the first root bundle:
      const refunds = bundleDataClient.getNextBundleRefunds();
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
      const blockRange = CHAIN_ID_TEST_LIST.map((_) => [0, latestBlock]);
      const expectedPoolRebalanceRoot = dataworkerInstance.buildPoolRebalanceRoot(blockRange, spokePoolClients);
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
          bundleDataClient.getNextBundleRefunds(),
          relayer.address,
          destinationChainId,
          erc20_2.address
        )
      ).to.equal(getRefundForFills([fill2]));
    });
  });
  it("Returns unfilled deposits", async function () {
    await updateAllClients();

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
      l1Token_2,
      depositor,
      originChainId,
      amountToDeposit
    );

    // Unfilled deposits are ignored.
    await updateAllClients();
    const data1 = dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(0), spokePoolClients);
    expect(data1.unfilledDeposits).to.deep.equal([]);

    // Two deposits with no fills per destination chain ID.
    await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit.mul(toBN(2))
    );
    await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_2,
      depositor,
      originChainId,
      amountToDeposit.mul(toBN(2))
    );
    await updateAllClients();
    const data2 = dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(1), spokePoolClients);
    expect(data2.unfilledDeposits).to.deep.equal([]);

    // Fills for 0 amount do not count do not make deposit eligible for slow fill:
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 0);
    await updateAllClients();
    expect(
      dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(2), spokePoolClients).unfilledDeposits
    ).to.deep.equal([]);

    // Fills that don't match deposits do not affect unfilledAmount counter.
    // Note: We switch the spoke pool address in the following fills from the fills that eventually do match with
    //       the deposits.
    await buildFill(spokePool_1, erc20_2, depositor, relayer, deposit1, 0.5);
    await buildFill(spokePool_2, erc20_1, depositor, relayer, deposit2, 0.25);

    // One partially filled deposit per destination chain ID.
    const fill1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.5);
    const fill2 = await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 0.25);
    await updateAllClients();
    const data3 = dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(3), spokePoolClients);
    expect(data3.unfilledDeposits).to.deep.equal([
      { unfilledAmount: amountToDeposit.sub(fill1.fillAmount), deposit: deposit1 },
      { unfilledAmount: amountToDeposit.sub(fill2.fillAmount), deposit: deposit2 },
    ]);

    // If block range does not cover fills, then unfilled deposits are not included.
    expect(
      dataworkerInstance.clients.bundleDataClient.loadData(IMPOSSIBLE_BLOCK_RANGE, spokePoolClients).unfilledDeposits
    ).to.deep.equal([]);

    // All deposits are fulfilled; unfilled deposits that are fully filled should be ignored.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 1);
    await updateAllClients();
    const data5 = dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(4), spokePoolClients);
    expect(data5.unfilledDeposits).to.deep.equal([]);

    // TODO: Add test where deposit has matched fills but none were the first ever fill for that deposit (i.e. where
    // fill.amount != fill.totalAmountFilled). This can only be done after adding in block range constraints on Fill
    // events queried.

    // Fill events emitted by slow relays are included in unfilled amount calculations.
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
    const fill3 = await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit5, 0.25);

    // One unfilled deposit that we're going to slow fill:
    await updateAllClients();
    const data6 = dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), spokePoolClients);
    expect(data6.unfilledDeposits).to.deep.equal([
      { unfilledAmount: amountToDeposit.sub(fill3.fillAmount), deposit: deposit5 },
    ]);

    const slowRelays = buildSlowRelayLeaves([deposit5]);
    const tree = await buildSlowRelayTree(slowRelays);
    await spokePool_1.relayRootBundle(tree.getHexRoot(), tree.getHexRoot());
    await buildSlowFill(spokePool_1, fill3, depositor, []);

    // The unfilled deposit has now been fully filled.
    await updateAllClients();
    const data7 = dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(6), spokePoolClients);
    expect(data7.unfilledDeposits).to.deep.equal([]);
  });
  it("Returns fills to refund", async function () {
    await updateAllClients();

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
      l1Token_2,
      depositor,
      originChainId,
      amountToDeposit
    );

    // Fills should be keyed by repayment chain and repayment token. For this test, make sure that the repayment chain
    // ID is associated with some ERC20:
    const repaymentToken = await deployNewToken(relayer);
    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: repaymentChainId, destinationToken: repaymentToken, l1Token: l1Token_1 },
    ]);
    await updateAllClients();

    // Submit a valid fill.
    const fill1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.5);
    await updateAllClients();
    const data1 = dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(0), spokePoolClients);
    expect(data1.fillsToRefund).to.deep.equal({
      [repaymentChainId]: {
        [repaymentToken.address]: {
          fills: [fill1],
          refunds: { [relayer.address]: getRefundForFills([fill1]) },
          totalRefundAmount: getRefundForFills([fill1]),
          realizedLpFees: getRealizedLpFeeForFills([fill1]),
        },
      },
    });

    // If block range does not cover fills, then they are not included
    expect(
      dataworkerInstance.clients.bundleDataClient.loadData(IMPOSSIBLE_BLOCK_RANGE, spokePoolClients).fillsToRefund
    ).to.deep.equal({});

    // Submit fills without matching deposits. These should be ignored by the client.
    // Note: Switch just the relayer fee % to make fills invalid. This also ensures that client is correctly
    // distinguishing between valid speed up fills with modified relayer fee %'s and invalid fill relay calls
    // with all correct fill params except for the relayer fee %.
    await buildFill(spokePool_1, erc20_1, depositor, relayer, { ...deposit2, relayerFeePct: toBN(0) }, 0.5);
    await updateAllClients();
    const data3 = dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(1), spokePoolClients);
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
      { ...deposit2, realizedLpFeePct: deposit2.realizedLpFeePct.div(toBN(2)) },
      0.25
    );
    // Note: This fill has identical deposit data to fill2 except for the destination token being different
    await buildFill(spokePool_1, erc20_2, depositor, relayer, deposit2, 0.25);
    await updateAllClients();
    const data4 = dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(2), spokePoolClients);
    expect(data4.fillsToRefund).to.deep.equal(data1.fillsToRefund);

    // Slow relay fills are added.
    const deposit3 = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_2,
      depositor,
      originChainId,
      amountToDeposit
    );
    const fill3 = await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit3, 0.25);
    const slowRelays = buildSlowRelayLeaves([deposit3]);
    const tree = await buildSlowRelayTree(slowRelays);
    await spokePool_1.relayRootBundle(tree.getHexRoot(), tree.getHexRoot());
    const slowFill3 = await buildSlowFill(spokePool_1, fill3, depositor, []);
    await updateAllClients();
    const data5 = dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(3), spokePoolClients);
    expect(data5.fillsToRefund).to.deep.equal({
      [slowFill3.destinationChainId]: {
        [erc20_1.address]: {
          fills: [slowFill3], // Slow fill gets added to fills list
          realizedLpFees: getRealizedLpFeeForFills([slowFill3]), // Slow fill does affect realized LP fee
        },
      },
      [repaymentChainId]: {
        [repaymentToken.address]: {
          fills: [fill1, fill3],
          refunds: { [relayer.address]: getRefundForFills([fill1, fill3]) },
          totalRefundAmount: getRefundForFills([fill1, fill3]),
          realizedLpFees: getRealizedLpFeeForFills([fill1, fill3]),
        },
      },
    });

    // Speed up relays are included. Re-use the same fill information
    const fill4 = await buildModifiedFill(spokePool_2, depositor, relayer, fill1, 2, 0.1);
    expect(fill4.totalFilledAmount.gt(fill4.fillAmount), "speed up fill didn't match original deposit");
    await updateAllClients();
    const data6 = dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(4), spokePoolClients);
    expect(data6.fillsToRefund).to.deep.equal({
      [slowFill3.destinationChainId]: {
        [erc20_1.address]: {
          fills: [slowFill3],
          realizedLpFees: getRealizedLpFeeForFills([slowFill3]),
        },
      },
      [repaymentChainId]: {
        [repaymentToken.address]: {
          fills: [fill1, fill4, fill3],
          refunds: { [relayer.address]: getRefundForFills([fill1, fill3, fill4]) },
          totalRefundAmount: getRefundForFills([fill1, fill3, fill4]),
          realizedLpFees: getRealizedLpFeeForFills([fill1, fill3, fill4]),
        },
      },
    });
  });
  it("Returns deposits", async function () {
    await updateAllClients();

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
    const originBlock = await spokePool_2.provider.getBlockNumber();
    const realizedLpFeePctData = await configStoreClient.computeRealizedLpFeePct(deposit1, l1Token_1.address);

    // Should include all deposits, even those not matched by a relay
    await updateAllClients();
    const data1 = dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), spokePoolClients);
    expect(data1.deposits).to.deep.equal([
      { ...deposit1, blockNumber: realizedLpFeePctData.quoteBlock, originBlockNumber: originBlock },
    ]);

    // If block range does not cover deposits, then they are not included
    expect(
      dataworkerInstance.clients.bundleDataClient.loadData(IMPOSSIBLE_BLOCK_RANGE, spokePoolClients).deposits
    ).to.deep.equal([]);
  });
});
