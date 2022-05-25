import { buildFillForRepaymentChain } from "./utils";
import { SignerWithAddress, expect, ethers, Contract, buildDeposit } from "./utils";
import { HubPoolClient, AcrossConfigStoreClient, MultiCallerClient, SpokePoolClient } from "../src/clients";
import { amountToDeposit, destinationChainId } from "./constants";
import { MAX_REFUNDS_PER_RELAYER_REFUND_LEAF, MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import { MAX_UINT_VAL } from "../src/utils";
import { BalanceAllocator } from "../src/clients/BalanceAllocator";
import { spokePoolClientsToProviders } from "../src/dataworker/DataworkerClientHelper";

// Tested
import { Dataworker } from "../src/dataworker/Dataworker";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, hubPool: Contract;
let depositor: SignerWithAddress;

let hubPoolClient: HubPoolClient, configStoreClient: AcrossConfigStoreClient;
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
      configStoreClient,
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
      ethers.BigNumber.from(0),
      0
    ));
  });
  it("Simple lifecycle", async function () {
    await updateAllClients();

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

    const providers = {
      ...spokePoolClientsToProviders(spokePoolClients),
      [(await hubPool.provider.getNetwork()).chainId]: hubPool.provider,
    };

    await dataworkerInstance.proposeRootBundle(spokePoolClients);

    // Execute queue and check that root bundle is pending:
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTransactionQueue();

    // Advance time and execute rebalance leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, new BalanceAllocator(providers));
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

    // TEST 4:
    // Submit a new root with no additional actions taken to make sure that this doesn't break anything.
    await updateAllClients();
    await dataworkerInstance.proposeRootBundle(spokePoolClients);

    // Execute queue and execute leaves:
    await multiCallerClient.executeTransactionQueue();

    // Advance time and execute leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, new BalanceAllocator(providers));

    // Should be 1 leaf since this is _only_ a second partial fill repayment and doesn't involve the deposit chain.
    await multiCallerClient.executeTransactionQueue();

    await dataworkerInstance.executeSlowRelayLeaves(spokePoolClients, new BalanceAllocator(providers));

    // There should be no slow relays to execute because the spoke doesn't have enough funds.
    expect(multiCallerClient.transactionCount()).to.equal(0);

    // Note: we need to manually supply the tokens since the L1 tokens won't be recognized in the spoke pool.
    // It should only require ~1/2 of the amount because there was a prev fill that provided the other half.
    await erc20_2.mint(spokePool_2.address, amountToDeposit.div(2).sub(1));

    await updateAllClients();
    await dataworkerInstance.executeSlowRelayLeaves(spokePoolClients, new BalanceAllocator(providers));

    // There should be a slow relays to execute because the spoke doesn't has funds.
    expect(multiCallerClient.transactionCount()).to.equal(1);
    await multiCallerClient.executeTransactionQueue();
  });
});
