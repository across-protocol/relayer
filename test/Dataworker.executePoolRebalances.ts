import { buildFillForRepaymentChain } from "./utils";
import { SignerWithAddress, expect, ethers, Contract, buildDeposit } from "./utils";
import { HubPoolClient, MultiCallerClient, SpokePoolClient } from "../src/clients";
import { amountToDeposit } from "./constants";
import { MAX_REFUNDS_PER_RELAYER_REFUND_LEAF, MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF } from "./constants";
import { DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import { MAX_UINT_VAL } from "../src/utils";

// Tested
import { Dataworker } from "../src/dataworker/Dataworker";
import { spokePoolClientsToProviders } from "../src/common";
import { BalanceAllocator } from "../src/clients/BalanceAllocator";

// Set to arbitrum to test that the dataworker sends ETH to the HubPool to test L1 --> Arbitrum message transfers.
const destinationChainId = 42161;

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract;
let l1Token_1: Contract, hubPool: Contract;
let depositor: SignerWithAddress;

let hubPoolClient: HubPoolClient;
let dataworkerInstance: Dataworker, multiCallerClient: MultiCallerClient;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let updateAllClients: () => Promise<void>;

describe("Dataworker: Execute pool rebalances", async function () {
  beforeEach(async function () {
    ({
      hubPool,
      spokePool_1,
      erc20_1,
      spokePool_2,
      hubPoolClient,
      l1Token_1,
      depositor,
      dataworkerInstance,
      multiCallerClient,
      updateAllClients,
      spokePoolClients,
    } = await setupDataworker(
      ethers,
      MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
      MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
      DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD,
      0,
      destinationChainId
    ));
  });
  it("Simple lifecycle", async function () {
    await updateAllClients();

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

    const providers = {
      ...spokePoolClientsToProviders(spokePoolClients),
      [hubPoolClient.chainId]: hubPool.provider,
    };

    await dataworkerInstance.proposeRootBundle(spokePoolClients);

    // Execute queue and check that root bundle is pending:
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTransactionQueue();

    // Advance time and execute leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, new BalanceAllocator(providers));

    // Should be 4 transactions: 1 for `exchangeRateCurrent`, 1 for the to chain, 1 for the from chain, and 1 for the extra ETH sent to cover
    // arbitrum gas fees.Should NOT be 3 since not enough time has passed since the last lp fee update.
    expect(multiCallerClient.transactionCount()).to.equal(4);
    await multiCallerClient.executeTransactionQueue();

    // TEST 3:
    // Submit another root bundle proposal and check bundle block range. There should be no leaves in the new range
    // yet. In the bundle block range, all chains should have increased their start block, including those without
    // pool rebalance leaves because they should use the chain's end block from the latest fully executed proposed
    // root bundle, which should be the bundle block in expectedPoolRebalanceRoot2 + 1.
    await updateAllClients();
    await dataworkerInstance.proposeRootBundle(spokePoolClients);

    // Advance time and execute leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, new BalanceAllocator(providers));
    expect(multiCallerClient.transactionCount()).to.equal(0);

    // TEST 4:
    // Submit another fill and check that dataworker proposes another root with 1 leaf.
    await buildFillForRepaymentChain(spokePool_2, depositor, deposit, 1, destinationChainId);
    await updateAllClients();
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    await multiCallerClient.executeTransactionQueue();

    // Advance time and execute leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, new BalanceAllocator(providers));

    // Dataworker actually executes the leaf:
    let pendingBundle = await hubPool.rootBundleProposal();
    expect(pendingBundle.unclaimedPoolRebalanceLeafCount).to.equal(1);
    await multiCallerClient.executeTransactionQueue();

    pendingBundle = await hubPool.rootBundleProposal();
    expect(pendingBundle.unclaimedPoolRebalanceLeafCount).to.equal(0);
  });
});
