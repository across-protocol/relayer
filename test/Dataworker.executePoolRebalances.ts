import { ConfigStoreClient, HubPoolClient, MultiCallerClient, SpokePoolClient } from "../src/clients";
import {
  BaseContract,
  bnZero,
  getCurrentTime,
  MAX_UINT_VAL,
  MerkleTree,
  RelayerRefundLeaf,
  toBNWei,
} from "../src/utils";
import {
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  amountToDeposit,
  ZERO_ADDRESS,
} from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import {
  Contract,
  FakeContract,
  SignerWithAddress,
  depositV3,
  ethers,
  expect,
  fillV3Relay,
  smock,
  sinon,
  lastSpyLogIncludes,
  randomAddress,
} from "./utils";

// Tested
import { BalanceAllocator } from "../src/clients/BalanceAllocator";
import { spokePoolClientsToProviders } from "../src/common";
import { Dataworker } from "../src/dataworker/Dataworker";
import { MockHubPoolClient } from "./mocks/MockHubPoolClient";
import { PoolRebalanceLeaf, SlowFillLeaf } from "../src/interfaces";

// Set to arbitrum to test that the dataworker sends ETH to the HubPool to test L1 --> Arbitrum message transfers.
const destinationChainId = 42161;

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, hubPool: Contract, spokePool_4: Contract;
let depositor: SignerWithAddress, spy: sinon.SinonSpy;

let hubPoolClient: HubPoolClient;
let dataworkerInstance: Dataworker, multiCallerClient: MultiCallerClient;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let updateAllClients: () => Promise<void>;

describe("Dataworker: Execute pool rebalances", async function () {
  function getNewBalanceAllocator(): BalanceAllocator {
    const providers = {
      ...spokePoolClientsToProviders(spokePoolClients),
      [hubPoolClient.chainId]: hubPool.provider,
    };
    return new BalanceAllocator(providers);
  }
  async function createMockHubPoolClient(): Promise<{
    mockHubPoolClient: MockHubPoolClient;
    fakeHubPool: FakeContract<BaseContract>;
  }> {
    const fakeHubPool = await smock.fake(hubPool.interface, { address: hubPool.address });
    const mockHubPoolClient = new MockHubPoolClient(
      hubPoolClient.logger,
      fakeHubPool as unknown as Contract,
      hubPoolClient.configStoreClient as unknown as ConfigStoreClient
    );
    mockHubPoolClient.chainId = hubPoolClient.chainId;
    mockHubPoolClient.setTokenInfoToReturn({ address: l1Token_1.address, decimals: 18, symbol: "TEST" });
    mockHubPoolClient.setTokenMapping(l1Token_1.address, hubPoolClient.chainId, l1Token_1.address);

    // Sub in a dummy root bundle proposal for use in HubPoolClient update.
    const zero = "0x0000000000000000000000000000000000000000000000000000000000000000";
    fakeHubPool.multicall.returns([
      hubPool.interface.encodeFunctionResult("getCurrentTime", [getCurrentTime().toString()]),
      hubPool.interface.encodeFunctionResult("rootBundleProposal", [zero, zero, zero, 0, ZERO_ADDRESS, 0, 0]),
    ]);
    return {
      mockHubPoolClient,
      fakeHubPool,
    };
  }
  beforeEach(async function () {
    ({
      hubPool,
      spokePool_1,
      spokePool_4,
      erc20_1,
      erc20_2,
      spokePool_2,
      hubPoolClient,
      l1Token_1,
      depositor,
      dataworkerInstance,
      multiCallerClient,
      updateAllClients,
      spokePoolClients,
      spy,
    } = await setupDataworker(
      ethers,
      MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
      MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
      0,
      destinationChainId
    ));
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

    // Executing leaves before there is a bundle should do nothing:
    let leafCount = await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, getNewBalanceAllocator());
    expect(leafCount).to.equal(0);
    expect(lastSpyLogIncludes(spy, "No pending proposal")).to.be.true;

    await dataworkerInstance.proposeRootBundle(spokePoolClients);

    // Execute queue and check that root bundle is pending:
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTxnQueues();

    // Executing leaves before bundle challenge period has passed should do nothing:
    await updateAllClients();
    leafCount = await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, getNewBalanceAllocator());
    expect(leafCount).to.equal(0);
    expect(lastSpyLogIncludes(spy, "Challenge period not passed")).to.be.true;

    // Advance time and execute leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    leafCount = await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, getNewBalanceAllocator());
    expect(leafCount).to.equal(2);

    // Should be 4 transactions: 1 for the to chain, 1 for the from chain, 1 for the extra ETH sent to cover
    // arbitrum gas fees, and 1 to update the exchangeRate to execute the destination chain leaf.
    // console.log(spy.getCall(-1))
    expect(multiCallerClient.transactionCount()).to.equal(4);
    await multiCallerClient.executeTxnQueues();

    // If we attempt execution again, the hub pool client should show them as already executed.
    await updateAllClients();
    leafCount = await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, getNewBalanceAllocator());
    expect(leafCount).to.equal(0);

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
    leafCount = await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, getNewBalanceAllocator());
    expect(leafCount).to.equal(0);
    expect(multiCallerClient.transactionCount()).to.equal(0);
  });
  it("Executes mainnet leaves before non-mainnet leaves", async function () {
    // Send deposit on SpokePool with same chain ID as hub chain.
    // Fill it on a different spoke pool.
    await updateAllClients();

    // Mainnet deposit should produce a mainnet pool leaf.
    const deposit = await depositV3(
      spokePool_4,
      destinationChainId,
      depositor,
      l1Token_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    await updateAllClients();
    // Fill and take repayment on a non-mainnet spoke pool.
    await fillV3Relay(spokePool_2, deposit, depositor, destinationChainId);
    await updateAllClients();

    const balanceAllocator = getNewBalanceAllocator();
    await dataworkerInstance.proposeRootBundle(spokePoolClients);

    // Execute queue and check that root bundle is pending:
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTxnQueues();

    // Advance time and execute leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    const leafCount = await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, balanceAllocator);
    expect(leafCount).to.equal(2);

    const leafExecutions = multiCallerClient.getQueuedTransactions(hubPoolClient.chainId).map((tx, index) => {
      return {
        ...tx,
        index,
      };
    });
    const poolLeafExecutions = leafExecutions.filter((tx) => tx.method === "executeRootBundle");
    expect(poolLeafExecutions[0].args[0]).to.equal(hubPoolClient.chainId);
    const refundLeafExecutions = leafExecutions.filter((tx) => tx.method === "executeRelayerRefundLeaf");
    expect(refundLeafExecutions.length).to.equal(1);

    // Hub chain relayer refund leaves should also execute before non-mainnet pool leaves
    expect(refundLeafExecutions[0].index).to.be.greaterThan(poolLeafExecutions[0].index);
    expect(refundLeafExecutions[0].index).to.be.lessThan(poolLeafExecutions[1].index);
    expect(poolLeafExecutions[1].args[0]).to.equal(destinationChainId);
  });
  describe("_executePoolLeavesAndSyncL1Tokens", function () {
    let mockHubPoolClient: MockHubPoolClient, balanceAllocator: BalanceAllocator;
    beforeEach(async function () {
      ({ mockHubPoolClient } = await createMockHubPoolClient());
      dataworkerInstance.clients.hubPoolClient = mockHubPoolClient;

      // Make sure post-sync reserves are greater than the net send amount.
      balanceAllocator = getNewBalanceAllocator();
    });
    it("Should not double update an LP token", async function () {
      // In this test, the HubPool client returns the liquid reserves as 0 for a token.

      // So, executing the ethereum leaves results in an exchangeRate() update call.

      // The subsequent call to execute non-ethereum leaves should not result in an extra exchange rate call
      // if a sync was already included.

      // Set LP reserves to 0 for the token.
      mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, bnZero);

      // Make sure post-sync reserves are greater than the net send amount.
      balanceAllocator.testSetBalance(hubPoolClient.chainId, l1Token_1.address, hubPool.address, toBNWei("2"));

      const poolRebalanceLeaves: PoolRebalanceLeaf[] = [
        {
          chainId: hubPoolClient.chainId,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [toBNWei("1")],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
        {
          chainId: 10,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [toBNWei("1")],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
      ];

      const leafCount = await dataworkerInstance._executePoolLeavesAndSyncL1Tokens(
        spokePoolClients,
        balanceAllocator,
        poolRebalanceLeaves,
        new MerkleTree<PoolRebalanceLeaf>(poolRebalanceLeaves, () => "test"),
        [],
        new MerkleTree<RelayerRefundLeaf>([], () => "test"),
        [],
        new MerkleTree<SlowFillLeaf>([], () => "test"),
        true
      );
      expect(leafCount).to.equal(2);

      // Should sync LP token for first leaf execution, but not for the second. This tests that latestLiquidReserves
      // are passed correctly into _updateExchangeRatesBeforeExecutingNonHubChainLeaves so that currentReserves
      // don't get set to the HubPool.pooledTokens.liquidReserves value. If this was done incorrectly then I would
      // expect a second exchangeRateCurrent method before the second executeRootBundle call.
      const enqueuedTxns = multiCallerClient.getQueuedTransactions(hubPoolClient.chainId);
      expect(enqueuedTxns.map((txn) => txn.method)).to.deep.equal([
        "exchangeRateCurrent",
        "executeRootBundle",
        "executeRootBundle",
      ]);
    });
    it("Executing hub chain pool leaves should decrement available liquid reserves for subsequent executions", async function () {
      // In this test, the HubPool client returns the liquid reserves as sufficient for
      // executing Hub chain leaves for a token.

      // The subsequent call to execute non-ethereum leaves should force an LP token update
      // before executing the non hub chain leaves.

      const netSendAmount = toBNWei("1");
      const liquidReserves = toBNWei("1");
      mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);

      // Make sure post-sync reserves are >= than the net send amount.
      const postUpdateLiquidReserves = toBNWei("2");
      balanceAllocator.testSetBalance(
        hubPoolClient.chainId,
        l1Token_1.address,
        hubPool.address,
        postUpdateLiquidReserves
      );

      const poolRebalanceLeaves: PoolRebalanceLeaf[] = [
        {
          chainId: 10,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [netSendAmount],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
        {
          chainId: hubPoolClient.chainId,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [netSendAmount],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
      ];

      const leafCount = await dataworkerInstance._executePoolLeavesAndSyncL1Tokens(
        spokePoolClients,
        balanceAllocator,
        poolRebalanceLeaves,
        new MerkleTree<PoolRebalanceLeaf>(poolRebalanceLeaves, () => "test"),
        [],
        new MerkleTree<RelayerRefundLeaf>([], () => "test"),
        [],
        new MerkleTree<SlowFillLeaf>([], () => "test"),
        true
      );
      expect(leafCount).to.equal(2);

      // The order should be: executeRootBundle, exchangeRateCurrent, execute
      const enqueuedTxns = multiCallerClient.getQueuedTransactions(hubPoolClient.chainId);
      expect(enqueuedTxns.map((txn) => txn.method)).to.deep.equal([
        "executeRootBundle",
        "exchangeRateCurrent",
        "executeRootBundle",
      ]);
    });
    it("Executing hub chain refund leaves should increment available liquid reserves for subsequent executions", async function () {
      // In this test, the refund leaf returns reserves to the hub chain, which gives enough post-sync liquid
      // reserves to execute the non hub chain leaf.

      const netSendAmount = toBNWei("1");
      const liquidReserves = toBNWei("0");
      mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);

      const poolRebalanceLeaves: PoolRebalanceLeaf[] = [
        {
          chainId: 10,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [netSendAmount],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
        {
          chainId: hubPoolClient.chainId,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [toBNWei("0")],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
      ];

      // Need to set a balance for the spoke pool to make the dataworker believe this leaf can be executed.
      balanceAllocator.testSetBalance(
        hubPoolClient.chainId,
        l1Token_1.address,
        spokePoolClients[hubPoolClient.chainId].spokePool.address,
        netSendAmount
      );

      const relayerRefundLeaves: RelayerRefundLeaf[] = [
        {
          chainId: hubPoolClient.chainId,
          l2TokenAddress: l1Token_1.address,
          amountToReturn: netSendAmount,
          refundAddresses: [],
          refundAmounts: [],
          leafId: 0,
        },
      ];

      const leafCount = await dataworkerInstance._executePoolLeavesAndSyncL1Tokens(
        spokePoolClients,
        balanceAllocator,
        poolRebalanceLeaves,
        new MerkleTree<PoolRebalanceLeaf>(poolRebalanceLeaves, () => "test"),
        relayerRefundLeaves,
        new MerkleTree<RelayerRefundLeaf>(relayerRefundLeaves, () => "test"),
        [],
        new MerkleTree<SlowFillLeaf>([], () => "test"),
        true
      );
      expect(leafCount).to.equal(2);

      // Execute mainnet refund leaf after mainnet pool leaf. Then update exchange rates to execute non-mainnet pool leaf.
      const enqueuedTxns = multiCallerClient.getQueuedTransactions(hubPoolClient.chainId);
      expect(enqueuedTxns.map((txn) => txn.method)).to.deep.equal([
        "executeRootBundle",
        "executeRelayerRefundLeaf",
        "exchangeRateCurrent",
        "executeRootBundle",
      ]);
    });
    it("Executes mainnet slow fill leaves", async function () {
      // In this test, we verify slow fill leaves are executed after mainnet pool leaves.

      const slowFillAmount = toBNWei("1");
      const liquidReserves = toBNWei("0");
      mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);

      const poolRebalanceLeaves: PoolRebalanceLeaf[] = [
        {
          chainId: hubPoolClient.chainId,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [toBNWei("0")],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
      ];

      // Need to set a balance for the spoke pool to make the dataworker believe this leaf can be executed.
      balanceAllocator.testSetBalance(
        hubPoolClient.chainId,
        l1Token_1.address,
        spokePoolClients[hubPoolClient.chainId].spokePool.address,
        slowFillAmount
      );
      const slowFillLeaves: SlowFillLeaf[] = [
        {
          relayData: {
            originChainId: 10,
            depositor: randomAddress(),
            recipient: randomAddress(),
            depositId: bnZero,
            inputToken: randomAddress(),
            inputAmount: slowFillAmount,
            outputToken: l1Token_1.address,
            outputAmount: slowFillAmount,
            message: "0x",
            fillDeadline: 0,
            exclusiveRelayer: randomAddress(),
            exclusivityDeadline: 0,
          },
          chainId: hubPoolClient.chainId,
          updatedOutputAmount: slowFillAmount,
        },
      ];

      const leafCount = await dataworkerInstance._executePoolLeavesAndSyncL1Tokens(
        spokePoolClients,
        balanceAllocator,
        poolRebalanceLeaves,
        new MerkleTree<PoolRebalanceLeaf>(poolRebalanceLeaves, () => "test"),
        [],
        new MerkleTree<RelayerRefundLeaf>([], () => "test"),
        slowFillLeaves,
        new MerkleTree<SlowFillLeaf>(slowFillLeaves, () => "test"),
        true
      );
      expect(leafCount).to.equal(1);

      // Execute mainnet refund leaf after mainnet pool leaf. Then update exchange rates to execute non-mainnet pool leaf.
      const enqueuedTxns = multiCallerClient.getQueuedTransactions(hubPoolClient.chainId);
      expect(enqueuedTxns.map((txn) => txn.method)).to.deep.equal(["executeRootBundle", "executeSlowRelayLeaf"]);
    });
    it("No non-mainnet leaves", async function () {
      // In this test, check that if there are no mainnet leaves, then the dataworker should just execute non
      // mainnet leaves.
      const netSendAmount = toBNWei("1");
      const liquidReserves = toBNWei("1");
      mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);

      const poolRebalanceLeaves: PoolRebalanceLeaf[] = [
        {
          chainId: 10,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [netSendAmount],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
      ];

      const leafCount = await dataworkerInstance._executePoolLeavesAndSyncL1Tokens(
        spokePoolClients,
        balanceAllocator,
        poolRebalanceLeaves,
        new MerkleTree<PoolRebalanceLeaf>(poolRebalanceLeaves, () => "test"),
        [],
        new MerkleTree<RelayerRefundLeaf>([], () => "test"),
        [],
        new MerkleTree<SlowFillLeaf>([], () => "test"),
        true
      );
      expect(leafCount).to.equal(1);

      const enqueuedTxns = multiCallerClient.getQueuedTransactions(hubPoolClient.chainId);
      expect(enqueuedTxns.map((txn) => txn.method)).to.deep.equal(["executeRootBundle"]);
    });
    it("Fails to execute mainnet leaf, still executes non-mainnet leaves", async function () {
      // In this test, the hub pool leaf can't be funded using liquid reserves, but the
      // dataworker should still try to execute the non-mainnet leaves.

      const hubChainNetSendAmount = toBNWei("10");
      const nonHubChainNetSendAmount = toBNWei("1");
      const liquidReserves = toBNWei("1");
      mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
      balanceAllocator.testSetBalance(hubPoolClient.chainId, l1Token_1.address, hubPool.address, liquidReserves);

      const poolRebalanceLeaves: PoolRebalanceLeaf[] = [
        {
          chainId: 10,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [nonHubChainNetSendAmount],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
        {
          chainId: hubPoolClient.chainId,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [hubChainNetSendAmount],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
      ];

      const leafCount = await dataworkerInstance._executePoolLeavesAndSyncL1Tokens(
        spokePoolClients,
        balanceAllocator,
        poolRebalanceLeaves,
        new MerkleTree<PoolRebalanceLeaf>(poolRebalanceLeaves, () => "test"),
        [],
        new MerkleTree<RelayerRefundLeaf>([], () => "test"),
        [],
        new MerkleTree<SlowFillLeaf>([], () => "test"),
        true
      );
      expect(leafCount).to.equal(1);

      const enqueuedTxns = multiCallerClient.getQueuedTransactions(hubPoolClient.chainId);
      expect(enqueuedTxns.map((txn) => txn.method)).to.deep.equal(["executeRootBundle"]);
    });
    it("Fails to execute some non-mainnet leaves", async function () {
      // In this test, there is a mainnet leaf that can be executed, but one of the non-mainnet leaves cannot
      // be executed.
      const netSendAmount = toBNWei("1");

      // This liquid reserve is only sufficient to execute one of the non-mainnet leaves.
      const liquidReserves = toBNWei("1");
      mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
      balanceAllocator.testSetBalance(hubPoolClient.chainId, l1Token_1.address, hubPool.address, liquidReserves);

      const poolRebalanceLeaves: PoolRebalanceLeaf[] = [
        {
          chainId: 10,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [netSendAmount],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
        {
          chainId: 137,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [netSendAmount],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
        {
          chainId: hubPoolClient.chainId,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [toBNWei("0")],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
      ];

      const leafCount = await dataworkerInstance._executePoolLeavesAndSyncL1Tokens(
        spokePoolClients,
        balanceAllocator,
        poolRebalanceLeaves,
        new MerkleTree<PoolRebalanceLeaf>(poolRebalanceLeaves, () => "test"),
        [],
        new MerkleTree<RelayerRefundLeaf>([], () => "test"),
        [],
        new MerkleTree<SlowFillLeaf>([], () => "test"),
        true
      );
      expect(leafCount).to.equal(2);

      const enqueuedTxns = multiCallerClient.getQueuedTransactions(hubPoolClient.chainId);
      expect(enqueuedTxns.map((txn) => txn.method)).to.deep.equal(["executeRootBundle", "executeRootBundle"]);

      const errorLogs = spy.getCalls().filter((call) => call.lastArg.level === "error");
      expect(errorLogs.length).to.equal(1);
      expect(errorLogs[0].lastArg.message).to.contain("Not enough funds to execute pool rebalance leaf for chain 137");
    });
    it("Only mainnet leaves", async function () {
      // Should not throw if there are only mainnet leaves.
      const liquidReserves = toBNWei("1");
      mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);

      const poolRebalanceLeaves: PoolRebalanceLeaf[] = [
        {
          chainId: hubPoolClient.chainId,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [toBNWei("0")],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [l1Token_1.address],
        },
      ];

      const leafCount = await dataworkerInstance._executePoolLeavesAndSyncL1Tokens(
        spokePoolClients,
        balanceAllocator,
        poolRebalanceLeaves,
        new MerkleTree<PoolRebalanceLeaf>(poolRebalanceLeaves, () => "test"),
        [],
        new MerkleTree<RelayerRefundLeaf>([], () => "test"),
        [],
        new MerkleTree<SlowFillLeaf>([], () => "test"),
        true
      );
      expect(leafCount).to.equal(1);

      const enqueuedTxns = multiCallerClient.getQueuedTransactions(hubPoolClient.chainId);
      expect(enqueuedTxns.map((txn) => txn.method)).to.deep.equal(["executeRootBundle"]);
    });
  });
});
