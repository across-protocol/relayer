import { BundleDataClient, HubPoolClient, MultiCallerClient, SpokePoolClient } from "../src/clients";
import { MAX_UINT_VAL, toBN } from "../src/utils";
import {
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  amountToDeposit,
  destinationChainId,
  repaymentChainId,
} from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import { Contract, SignerWithAddress, depositV3, ethers, expect, fillV3 } from "./utils";

// Tested
import { BalanceAllocator } from "../src/clients/BalanceAllocator";
import { spokePoolClientsToProviders } from "../src/common";
import { Dataworker } from "../src/dataworker/Dataworker";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, hubPool: Contract, hubPoolClient: HubPoolClient;
let depositor: SignerWithAddress;

let dataworkerInstance: Dataworker, multiCallerClient: MultiCallerClient;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let updateAllClients: () => Promise<void>;

describe("Dataworker: Execute relayer refunds", async function () {
  const getNewBalanceAllocator = async (): Promise<BalanceAllocator> => {
    const providers = {
      ...spokePoolClientsToProviders(spokePoolClients),
      [(await hubPool.provider.getNetwork()).chainId]: hubPool.provider,
    };
    return new BalanceAllocator(providers);
  };
  beforeEach(async function () {
    ({
      hubPool,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      dataworkerInstance,
      multiCallerClient,
      updateAllClients,
      spokePoolClients,
    } = await setupDataworker(ethers, MAX_REFUNDS_PER_RELAYER_REFUND_LEAF, MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF, 0));
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
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
    await fillV3(spokePool_2, depositor, deposit, destinationChainId);
    await updateAllClients();

    await dataworkerInstance.proposeRootBundle(spokePoolClients);

    // Execute queue and check that root bundle is pending:
    await multiCallerClient.executeTransactionQueue();

    // Advance time and execute rebalance leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, await getNewBalanceAllocator());
    await multiCallerClient.executeTransactionQueue();

    // Manually relay the roots to spoke pools since adapter is a dummy and won't actually relay messages.
    await updateAllClients();
    const validatedRootBundles = hubPoolClient.getValidatedRootBundles();
    expect(validatedRootBundles.length).to.equal(1);
    const rootBundle = validatedRootBundles[0];
    await spokePool_1.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
    await spokePool_2.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
    await updateAllClients();
    await dataworkerInstance.executeRelayerRefundLeaves(spokePoolClients, await getNewBalanceAllocator());

    // Note: without sending tokens, only one of the leaves will be executable.
    // This is the leaf with the deposit that is being pulled back to the hub pool.
    expect(multiCallerClient.transactionCount()).to.equal(1);
    await multiCallerClient.executeTransactionQueue();

    await updateAllClients();

    // Note: we need to manually supply the tokens since the L1 tokens won't be recognized in the spoke pool.
    await erc20_2.mint(spokePool_2.address, amountToDeposit);
    await dataworkerInstance.executeRelayerRefundLeaves(spokePoolClients, await getNewBalanceAllocator());

    // The other transaction should now be enqueued.
    expect(multiCallerClient.transactionCount()).to.equal(1);

    await multiCallerClient.executeTransactionQueue();
  });
  describe("Computing refunds for bundles", function () {
    let relayer: SignerWithAddress;
    let bundleDataClient: BundleDataClient;

    beforeEach(async function () {
      relayer = depositor;
      bundleDataClient = dataworkerInstance.clients.bundleDataClient;
      await updateAllClients();

      const deposit1 = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        erc20_2.address,
        amountToDeposit
      );

      await updateAllClients();

      // Submit a valid fill.
      await fillV3(spokePool_2, relayer, deposit1, destinationChainId);

      await updateAllClients();
    });
    it("No validated bundle refunds", async function () {
      // Propose a bundle:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();

      // No bundle is validated so no refunds.
      const refunds = await bundleDataClient.getPendingRefundsFromValidBundles([relayer.address], 2);
      expect(bundleDataClient.getTotalRefund(refunds, relayer.address, destinationChainId, erc20_2.address)).to.equal(
        toBN(0)
      );
    });
    it("Get refunds from validated bundles", async function () {
      await updateAllClients();
      // Propose a bundle:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await multiCallerClient.executeTransactionQueue();

      // Advance time and execute leaves:
      await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
      await updateAllClients();
      await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, await getNewBalanceAllocator());
      await multiCallerClient.executeTransactionQueue();

      // Before relayer refund leaves are not executed, should have pending refunds:
      await updateAllClients();
      const validatedRootBundles = hubPoolClient.getValidatedRootBundles();
      expect(validatedRootBundles.length).to.equal(1);
      const refunds = await bundleDataClient.getPendingRefundsFromValidBundles([relayer.address], 2);
      const totalRefund1 = bundleDataClient.getTotalRefund(
        refunds,
        relayer.address,
        destinationChainId,
        erc20_2.address
      );
      expect(totalRefund1).to.gt(0);

      // Test edge cases of `getTotalRefund` that should return BN(0)
      expect(bundleDataClient.getTotalRefund(refunds, relayer.address, repaymentChainId, erc20_2.address)).to.equal(
        toBN(0)
      );
      expect(bundleDataClient.getTotalRefund(refunds, relayer.address, destinationChainId, erc20_1.address)).to.equal(
        toBN(0)
      );

      // Manually relay the roots to spoke pools since adapter is a dummy and won't actually relay messages.
      const rootBundle = validatedRootBundles[0];
      await spokePool_1.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
      await spokePool_2.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
      await updateAllClients();

      // Execute relayer refund leaves. Send funds to spoke pools to execute the leaves.
      await erc20_2.mint(spokePool_2.address, amountToDeposit);
      await dataworkerInstance.executeRelayerRefundLeaves(spokePoolClients, await getNewBalanceAllocator());
      await multiCallerClient.executeTransactionQueue();

      // Should now have zero pending refunds
      await updateAllClients();
      // If we call `getPendingRefundsFromLatestBundle` multiple times, there should be no error. If there is an error,
      // then it means that `getPendingRefundsFromLatestBundle` is mutating the return value of `.loadData` which is
      // stored in the bundle data client's cache. `getPendingRefundsFromLatestBundle` should instead be using a
      // deep cloned copy of `.loadData`'s output.
      await bundleDataClient.getPendingRefundsFromValidBundles([relayer.address], 2);
      const postExecutionRefunds = await bundleDataClient.getPendingRefundsFromValidBundles([relayer.address], 2);
      expect(
        bundleDataClient.getTotalRefund(postExecutionRefunds, relayer.address, destinationChainId, erc20_2.address)
      ).to.equal(toBN(0));

      // Submit fill2 and propose another bundle:
      const newDepositAmount = amountToDeposit.mul(2);
      const deposit2 = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        newDepositAmount,
        erc20_2.address,
        amountToDeposit
      );
      await updateAllClients();

      // Submit a valid fill.
      await fillV3(spokePool_2, relayer, deposit2, destinationChainId);
      await updateAllClients();

      // Validate another bundle:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await multiCallerClient.executeTransactionQueue();
      await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
      await updateAllClients();
      await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, await getNewBalanceAllocator());
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();

      expect(hubPoolClient.getValidatedRootBundles().length).to.equal(2);

      // Should include refunds for most recently validated bundle but not count first one
      // since they were already refunded.
      const refunds2 = await bundleDataClient.getPendingRefundsFromValidBundles([relayer.address], 2);
      expect(bundleDataClient.getTotalRefund(refunds2, relayer.address, destinationChainId, erc20_2.address)).to.gt(0);
    });
    it("Refunds in next bundle", async function () {
      // Before proposal should show refunds:
      expect(
        bundleDataClient.getRefundsFor(
          (await bundleDataClient.getNextBundleRefunds([relayer.address]))[0],
          relayer.address,
          destinationChainId,
          erc20_2.address
        )
      ).to.gt(0);

      // Propose a bundle:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();

      // After proposal but before execution should show upcoming refund:
      expect(
        bundleDataClient.getRefundsFor(
          (await bundleDataClient.getNextBundleRefunds([relayer.address]))[0],
          relayer.address,
          destinationChainId,
          erc20_2.address
        )
      ).to.gt(0);

      // Advance time and execute root bundle:
      await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
      await updateAllClients();
      await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, await getNewBalanceAllocator());
      await multiCallerClient.executeTransactionQueue();

      // Should reset to no refunds in "next bundle", though these will show up in pending bundle.
      await updateAllClients();
      expect(await bundleDataClient.getNextBundleRefunds([relayer.address])).to.deep.equal([{}]);
    });
  });
});
