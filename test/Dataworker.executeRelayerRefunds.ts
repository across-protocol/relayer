import { HubPoolClient, MultiCallerClient, SpokePoolClient } from "../src/clients";
import { EvmAddress, buildRelayerRefundTree, MAX_UINT_VAL, RelayerRefundLeaf, toBNWei } from "../src/utils";
import {
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  amountToDeposit,
  destinationChainId,
} from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import { Contract, SignerWithAddress, depositV3, ethers, expect, fillV3Relay } from "./utils";

// Tested
import { BalanceAllocator } from "../src/clients/BalanceAllocator";
import { spokePoolClientsToProviders } from "../src/common";
import { Dataworker } from "../src/dataworker/Dataworker";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, hubPool: Contract, hubPoolClient: HubPoolClient, spokePool_4: Contract;
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
      spokePool_4,
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
    await fillV3Relay(spokePool_2, deposit, depositor, destinationChainId);
    await updateAllClients();

    await dataworkerInstance.proposeRootBundle(spokePoolClients);

    // Execute queue and check that root bundle is pending:
    await multiCallerClient.executeTxnQueues();

    // Advance time and execute rebalance leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, await getNewBalanceAllocator());
    await multiCallerClient.executeTxnQueues();

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
    await multiCallerClient.executeTxnQueues();

    await updateAllClients();

    // Note: we need to manually supply the tokens since the L1 tokens won't be recognized in the spoke pool.
    await erc20_2.mint(spokePool_2.address, amountToDeposit);
    await dataworkerInstance.executeRelayerRefundLeaves(spokePoolClients, await getNewBalanceAllocator());

    // The other transaction should now be enqueued.
    expect(multiCallerClient.transactionCount()).to.equal(1);

    await multiCallerClient.executeTxnQueues();
  });
  it("Modifies BalanceAllocator when executing hub chain leaf", async function () {
    const refundLeaves: RelayerRefundLeaf[] = [
      {
        amountToReturn: toBNWei("1"),
        chainId: hubPoolClient.chainId,
        refundAmounts: [],
        leafId: 0,
        l2TokenAddress: EvmAddress.from(l1Token_1.address),
        refundAddresses: [],
      },
    ];
    const relayerRefundTree = buildRelayerRefundTree(refundLeaves);
    const balanceAllocator = await getNewBalanceAllocator();
    await spokePool_4.relayRootBundle(
      relayerRefundTree.getHexRoot(),
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );
    await l1Token_1.mint(spokePool_4.address, amountToDeposit);
    await updateAllClients();
    await dataworkerInstance._executeRelayerRefundLeaves(
      refundLeaves,
      balanceAllocator,
      spokePoolClients[hubPoolClient.chainId],
      relayerRefundTree,
      0
    );
    expect(
      balanceAllocator.getUsed(
        hubPoolClient.chainId,
        EvmAddress.from(l1Token_1.address),
        EvmAddress.from(hubPool.address)
      )
    ).to.equal(toBNWei("-1"));
  });
  describe("Computing refunds for bundles", function () {
    let relayer: SignerWithAddress;

    beforeEach(async function () {
      relayer = depositor;
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
      await fillV3Relay(spokePool_2, deposit1, relayer, destinationChainId);

      await updateAllClients();
    });
  });
});
