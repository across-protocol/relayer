import { HubPoolClient, MultiCallerClient, SpokePoolClient } from "../src/clients";
import { BalanceAllocator } from "../src/clients/BalanceAllocator";
import { spokePoolClientsToProviders } from "../src/common";
import { MAX_UINT_VAL } from "../src/utils";
import {
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  amountToDeposit,
  destinationChainId,
  originChainId,
} from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import { Contract, SignerWithAddress, depositV3, ethers, expect, fillV3Relay, requestSlowFill } from "./utils";
import { interfaces } from "@across-protocol/sdk";

// Tested
import { Dataworker } from "../src/dataworker/Dataworker";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, hubPool: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress;

let hubPoolClient: HubPoolClient;
let dataworkerInstance: Dataworker, multiCallerClient: MultiCallerClient;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let updateAllClients: () => Promise<void>;

describe("Dataworker: Execute slow relays", async function () {
  beforeEach(async function () {
    ({
      hubPool,
      spokePool_1,
      erc20_1,
      spokePool_2,
      erc20_2,
      hubPoolClient,
      l1Token_1,
      depositor,
      relayer,
      dataworkerInstance,
      multiCallerClient,
      updateAllClients,
      spokePoolClients,
    } = await setupDataworker(ethers, MAX_REFUNDS_PER_RELAYER_REFUND_LEAF, MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF, 0));
  });
  it("Executes V3 slow fills", async function () {
    await updateAllClients();

    // Send a deposit and a fill so that dataworker builds simple roots.
    await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    await updateAllClients();
    const deposit = spokePoolClients[originChainId].getDeposits()[0];
    await requestSlowFill(spokePool_2, depositor, deposit);

    await updateAllClients();

    await dataworkerInstance.proposeRootBundle(spokePoolClients);

    // Execute queue and check that root bundle is pending:
    expect(multiCallerClient.transactionCount()).to.equal(1);
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTxnQueues();

    const providers = {
      ...spokePoolClientsToProviders(spokePoolClients),
      [(await hubPool.provider.getNetwork()).chainId]: hubPool.provider,
    };

    // Advance time and execute rebalance leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, new BalanceAllocator(providers));
    await multiCallerClient.executeTxnQueues();

    // Manually relay the roots to spoke pools since adapter is a dummy and won't actually relay messages.
    await updateAllClients();
    const validatedRootBundles = hubPoolClient.getValidatedRootBundles();
    for (const rootBundle of validatedRootBundles) {
      await spokePool_2.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
    }
    await updateAllClients();

    // Note: we need to manually supply the tokens since the L1 tokens won't be recognized in the spoke pool.
    // It should only require ~1/2 of the amount because there was a prev fill that provided the other half.
    await erc20_2.mint(spokePool_2.address, amountToDeposit);

    await updateAllClients();
    await dataworkerInstance.executeSlowRelayLeaves(spokePoolClients, new BalanceAllocator(providers));

    expect(multiCallerClient.transactionCount()).to.equal(1);
    await multiCallerClient.executeTxnQueues();

    await updateAllClients();
    const fills = spokePoolClients[destinationChainId].getFills();
    expect(fills.length).to.equal(1);
    expect(fills[0].relayExecutionInfo.fillType).to.equal(interfaces.FillType.SlowFill);
  });
  it("Ignores V3 slow fills that were replaced by a fast fill", async function () {
    await updateAllClients();

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
    await requestSlowFill(spokePool_2, depositor, deposit);

    await updateAllClients();

    await dataworkerInstance.proposeRootBundle(spokePoolClients);

    // Execute queue and check that root bundle is pending:
    expect(multiCallerClient.transactionCount()).to.equal(1);
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTxnQueues();

    const providers = {
      ...spokePoolClientsToProviders(spokePoolClients),
      [(await hubPool.provider.getNetwork()).chainId]: hubPool.provider,
    };

    // Advance time and execute rebalance leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, new BalanceAllocator(providers));
    await multiCallerClient.executeTxnQueues();

    // Manually relay the roots to spoke pools since adapter is a dummy and won't actually relay messages.
    await updateAllClients();
    const validatedRootBundles = hubPoolClient.getValidatedRootBundles();
    for (const rootBundle of validatedRootBundles) {
      await spokePool_2.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
    }
    await updateAllClients();

    // Note: we need to manually supply the tokens since the L1 tokens won't be recognized in the spoke pool.
    // It should only require ~1/2 of the amount because there was a prev fill that provided the other half.
    await erc20_2.mint(spokePool_2.address, amountToDeposit);

    await updateAllClients();

    // Check that dataworker wanted to execute the slow fill:
    await dataworkerInstance.executeSlowRelayLeaves(spokePoolClients, new BalanceAllocator(providers));
    expect(multiCallerClient.transactionCount()).to.equal(1);

    // Replace slow fill, and check that it no longer tries to get executed by dataworker.
    await fillV3Relay(spokePool_2, deposit, relayer);
    await updateAllClients();
    multiCallerClient.clearTransactionQueue();
    await dataworkerInstance.executeSlowRelayLeaves(spokePoolClients, new BalanceAllocator(providers));
    expect(multiCallerClient.transactionCount()).to.equal(0);
  });
  it("Ignores expired deposits", async function () {
    await updateAllClients();

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
    await requestSlowFill(spokePool_2, depositor, deposit);

    await updateAllClients();

    await dataworkerInstance.proposeRootBundle(spokePoolClients);

    // Execute queue and check that root bundle is pending:
    expect(multiCallerClient.transactionCount()).to.equal(1);
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTxnQueues();

    const providers = {
      ...spokePoolClientsToProviders(spokePoolClients),
      [(await hubPool.provider.getNetwork()).chainId]: hubPool.provider,
    };
    // Advance time and execute rebalance leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, new BalanceAllocator(providers));
    await multiCallerClient.executeTxnQueues();

    // Manually relay the roots to spoke pools since adapter is a dummy and won't actually relay messages.
    await updateAllClients();
    const validatedRootBundles = hubPoolClient.getValidatedRootBundles();
    for (const rootBundle of validatedRootBundles) {
      await spokePool_2.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
    }
    await updateAllClients();

    // Note: we need to manually supply the tokens since the L1 tokens won't be recognized in the spoke pool.
    // It should only require ~1/2 of the amount because there was a prev fill that provided the other half.
    await erc20_2.mint(spokePool_2.address, amountToDeposit);

    await updateAllClients();

    // Check that dataworker skips the slow fill once we're past the deadline.
    await spokePool_2.setCurrentTime(deposit.fillDeadline + 1);
    await updateAllClients();
    await dataworkerInstance.executeSlowRelayLeaves(spokePoolClients, new BalanceAllocator(providers));
    expect(multiCallerClient.transactionCount()).to.equal(0);
  });
});
