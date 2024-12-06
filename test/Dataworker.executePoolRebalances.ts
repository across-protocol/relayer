import { ConfigStoreClient, HubPoolClient, MultiCallerClient, SpokePoolClient } from "../src/clients";
import {
  BaseContract,
  bnZero,
  buildPoolRebalanceLeafTree,
  CHAIN_IDs,
  ERC20,
  getCurrentTime,
  MAX_UINT_VAL,
  MerkleTree,
  RelayerRefundLeaf,
  toBNWei,
  TOKEN_SYMBOLS_MAP,
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
  fillV3,
  smock,
  sinon,
  randomAddress,
  lastSpyLogIncludes,
  assert,
  lastSpyLogLevel,
} from "./utils";

// Tested
import { BalanceAllocator } from "../src/clients/BalanceAllocator";
import { ARBITRUM_ORBIT_L1L2_MESSAGE_FEE_DATA, spokePoolClientsToProviders } from "../src/common";
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
    await fillV3(spokePool_2, depositor, deposit, destinationChainId);
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
    await fillV3(spokePool_2, depositor, deposit, destinationChainId);
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
  it("Should not double update an LP token", async function () {
    // In this test, the HubPool client returns the liquid reserves as 0 for a token.

    // So, executing the ethereum leaves results in an exchangeRate() update call.

    // The subsequent call to execute non-ethereum leaves should not result in an extra exchange rate call
    // if a sync was already included.

    // Set LP reserves to 0 for the token.
    const { mockHubPoolClient } = await createMockHubPoolClient();
    dataworkerInstance.clients.hubPoolClient = mockHubPoolClient;
    mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, bnZero);

    // Make sure post-sync reserves are greater than the net send amount.
    const balanceAllocator = getNewBalanceAllocator();
    balanceAllocator.testSetBalance(1, l1Token_1.address, hubPool.address, toBNWei("2"));

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

    const leafCount = await dataworkerInstance._executePoolLeaves(
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
  describe("update exchange rates", function () {
    let mockHubPoolClient: MockHubPoolClient, fakeHubPool: FakeContract;
    beforeEach(async function () {
      ({ mockHubPoolClient, fakeHubPool } = await createMockHubPoolClient());
      dataworkerInstance.clients.hubPoolClient = mockHubPoolClient;

      await updateAllClients();
    });
    describe("_updateExchangeRatesBeforeExecutingHubChainLeaves", function () {
      let balanceAllocator: BalanceAllocator;
      beforeEach(function () {
        balanceAllocator = getNewBalanceAllocator();
      });
      it("ignores negative net send amounts", async function () {
        const liquidReserves = toBNWei("1");
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
        const latestReserves = await dataworkerInstance._updateExchangeRatesBeforeExecutingHubChainLeaves(
          balanceAllocator,
          { netSendAmounts: [toBNWei(-1)], l1Tokens: [l1Token_1.address] },
          true
        );
        expect(latestReserves[l1Token_1.address]).to.equal(liquidReserves);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("considers positive net send amounts", async function () {
        const currentReserves = toBNWei("2");
        const netSendAmount = toBNWei("1");
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, currentReserves);

        const latestReserves = await dataworkerInstance._updateExchangeRatesBeforeExecutingHubChainLeaves(
          balanceAllocator,
          { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address] },
          true
        );
        expect(latestReserves[l1Token_1.address]).to.equal(currentReserves.sub(netSendAmount));
        expect(multiCallerClient.transactionCount()).to.equal(0);
        expect(lastSpyLogIncludes(spy, "current liquid reserves > netSendAmount")).to.be.true;
      });
      it("logs error if updated liquid reserves aren't enough to execute leaf", async function () {
        const netSendAmount = toBNWei("1");
        const liquidReserves = netSendAmount.sub(1);
        const postUpdateLiquidReserves = liquidReserves.sub(1);
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
        balanceAllocator.testSetBalance(
          hubPoolClient.chainId,
          l1Token_1.address,
          hubPool.address,
          postUpdateLiquidReserves
        );

        const latestReserves = await dataworkerInstance._updateExchangeRatesBeforeExecutingHubChainLeaves(
          balanceAllocator,
          { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address] },
          true
        );
        expect(lastSpyLogLevel(spy)).to.equal("warn");
        expect(lastSpyLogIncludes(spy, "Not enough funds to execute Ethereum pool rebalance leaf")).to.be.true;
        expect(latestReserves[l1Token_1.address]).to.equal(liquidReserves);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("submits update if updated liquid reserves cover execution of pool leaf", async function () {
        const netSendAmount = toBNWei("1");
        const updatedLiquidReserves = netSendAmount.add(1);
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, bnZero);
        balanceAllocator.testSetBalance(
          hubPoolClient.chainId,
          l1Token_1.address,
          hubPool.address,
          updatedLiquidReserves
        );

        const latestReserves = await dataworkerInstance._updateExchangeRatesBeforeExecutingHubChainLeaves(
          balanceAllocator,
          { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address] },
          true
        );
        expect(latestReserves[l1Token_1.address]).to.equal(updatedLiquidReserves.sub(netSendAmount));
        expect(multiCallerClient.transactionCount()).to.equal(1);
      });
    });
    describe("_updateExchangeRatesBeforeExecutingNonHubChainLeaves", function () {
      let balanceAllocator: BalanceAllocator;
      beforeEach(function () {
        balanceAllocator = getNewBalanceAllocator();
      });
      it("uses input liquid reserves value for a token if it exists", async function () {
        // In this test the `liquidReserves` > `netSendAmount` but we pass in the
        // `passedInLiquidReserves` value which is less than `liquidReserves`. So, the function
        // should attempt an update.
        const netSendAmount = toBNWei("1");
        const liquidReserves = toBNWei("3");
        const passedInLiquidReserves = toBNWei("0");

        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
        balanceAllocator.testSetBalance(hubPoolClient.chainId, l1Token_1.address, hubPool.address, netSendAmount);

        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {
            [l1Token_1.address]: passedInLiquidReserves,
          },
          balanceAllocator,
          [
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 1 },
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 10 },
          ],
          true
        );
        expect(updated.size).to.equal(1);
        expect(updated.has(l1Token_1.address)).to.be.true;
        const errorLogs = spy.getCalls().filter((call) => call.lastArg.level === "warn");
        expect(errorLogs.length).to.equal(1);
        expect(errorLogs[0].lastArg.message).to.contain("Not enough funds to execute ALL non-Ethereum");
      });
      it("exits early if current liquid reserves are greater than all individual net send amount", async function () {
        const netSendAmount = toBNWei("1");
        const liquidReserves = toBNWei("3");
        // For this test, do not pass in a liquid reserves object and force dataworker to load
        // from HubPoolClient
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          [
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 1 },
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 10 },
          ],
          true
        );
        expect(updated.size).to.equal(0);
        expect(multiCallerClient.transactionCount()).to.equal(0);
        expect(lastSpyLogIncludes(spy, "Skipping exchange rate update")).to.be.true;
      });
      it("exits early if total required net send amount is 0", async function () {
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, toBNWei("0"));
        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          [{ netSendAmounts: [toBNWei(0)], l1Tokens: [l1Token_1.address], chainId: 1 }],
          true
        );
        expect(updated.size).to.equal(0);
        expect(multiCallerClient.transactionCount()).to.equal(0);
        expect(
          spy.getCalls().filter((call) => call.lastArg.message.includes("Skipping exchange rate update")).length
        ).to.equal(0);
      });
      it("groups aggregate net send amounts by L1 token", async function () {
        // Total net send amount is 1 for each token but they are not summed together because they are different,
        // so the liquid reserves of 1 for each individual token is enough.
        const liquidReserves = toBNWei("1");
        const l1Token2 = erc20_1.address;
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
        mockHubPoolClient.setLpTokenInfo(l1Token2, 0, liquidReserves);
        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          [
            { netSendAmounts: [liquidReserves], l1Tokens: [l1Token_1.address], chainId: 1 },
            { netSendAmounts: [liquidReserves], l1Tokens: [l1Token2], chainId: 10 },
          ],
          true
        );
        expect(updated.size).to.equal(0);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("Logs error if any l1 token's aggregate net send amount exceeds post-sync liquid reserves", async function () {
        const liquidReserves = toBNWei("1");
        const postUpdateLiquidReserves = liquidReserves.mul(toBNWei("1.1")).div(toBNWei("1"));
        const l1Token2 = erc20_1.address;

        // Current reserves are 1 which is insufficient to execute all leaves.
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
        mockHubPoolClient.setLpTokenInfo(l1Token2, 0, liquidReserves);

        // Post-sync reserves are still insufficient to execute all leaves.
        balanceAllocator.testSetBalance(
          hubPoolClient.chainId,
          l1Token_1.address,
          hubPool.address,
          postUpdateLiquidReserves
        );
        balanceAllocator.testSetBalance(hubPoolClient.chainId, l1Token2, hubPool.address, postUpdateLiquidReserves);

        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          [
            { netSendAmounts: [liquidReserves], l1Tokens: [l1Token_1.address], chainId: 1 },
            // This one exceeds the post-update liquid reserves for the l1 token.
            { netSendAmounts: [liquidReserves.mul(2)], l1Tokens: [l1Token2], chainId: 10 },
          ],
          true
        );
        expect(updated.size).to.equal(1);
        expect(updated.has(l1Token2)).to.be.true;
        const errorLogs = spy.getCalls().filter((call) => call.lastArg.level === "warn");
        expect(errorLogs.length).to.equal(1);
        expect(errorLogs[0].lastArg.message).to.contain("Not enough funds to execute ALL non-Ethereum");
      });
      it("Logs one error for each L1 token whose aggregate net send amount exceeds post-sync liquid reserves", async function () {
        const liquidReserves = toBNWei("1");
        const postUpdateLiquidReserves = liquidReserves.mul(toBNWei("1.1")).div(toBNWei("1"));
        const l1Token2 = erc20_1.address;

        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
        mockHubPoolClient.setLpTokenInfo(l1Token2, 0, liquidReserves);

        balanceAllocator.testSetBalance(
          hubPoolClient.chainId,
          l1Token_1.address,
          hubPool.address,
          postUpdateLiquidReserves
        );
        balanceAllocator.testSetBalance(hubPoolClient.chainId, l1Token2, hubPool.address, postUpdateLiquidReserves);

        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          [
            // Both net send amounts exceed the post update liquid reserves
            { netSendAmounts: [liquidReserves.mul(2)], l1Tokens: [l1Token_1.address], chainId: 1 },
            { netSendAmounts: [liquidReserves.mul(2)], l1Tokens: [l1Token2], chainId: 10 },
          ],
          true
        );
        expect(updated.size).to.equal(2);
        expect(updated.has(l1Token2)).to.be.true;
        expect(updated.has(l1Token_1.address)).to.be.true;
        const errorLogs = spy.getCalls().filter((call) => call.lastArg.level === "warn");
        expect(errorLogs.length).to.equal(2);
      });
      it("ignores negative net send amounts", async function () {
        const liquidReserves = toBNWei("2");
        const postUpdateLiquidReserves = liquidReserves;

        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);

        balanceAllocator.testSetBalance(
          hubPoolClient.chainId,
          l1Token_1.address,
          hubPool.address,
          postUpdateLiquidReserves
        );

        await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          [
            { netSendAmounts: [liquidReserves.mul(2)], l1Tokens: [l1Token_1.address], chainId: 1 },
            // This negative liquid reserves doesn't offset the positive one, it just gets ignored.
            { netSendAmounts: [liquidReserves.mul(-10)], l1Tokens: [l1Token_1.address], chainId: 10 },
          ],
          true
        );
        const errorLog = spy.getCalls().filter((call) => call.lastArg.level === "warn");
        expect(errorLog.length).to.equal(1);
        expect(errorLog[0].lastArg.message).to.contain("Not enough funds to execute ALL non-Ethereum");
      });
      it("submits update: liquid reserves post-sync are enough to execute leaf", async function () {
        // Liquid reserves cover one leaf but not two.
        const postUpdateLiquidReserves = toBNWei("20");

        // Current reserves are insufficient to cover the two leaves:
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, bnZero);

        balanceAllocator.testSetBalance(
          hubPoolClient.chainId,
          l1Token_1.address,
          hubPool.address,
          postUpdateLiquidReserves
        );

        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          // Each leaf's net send amount is individually less than the post-updateliquid reserves,
          // but the sum of the three is greater than the post-update liquid reserves.
          // This should force the dataworker to submit an update.
          [
            { netSendAmounts: [toBNWei("4")], l1Tokens: [l1Token_1.address], chainId: 1 },
            { netSendAmounts: [toBNWei("9")], l1Tokens: [l1Token_1.address], chainId: 10 },
            { netSendAmounts: [toBNWei("7")], l1Tokens: [l1Token_1.address], chainId: 137 },
          ],
          true
        );
        expect(updated.size).to.equal(1);
        expect(updated.has(l1Token_1.address)).to.be.true;
        expect(multiCallerClient.transactionCount()).to.equal(1);
      });
      it("Logs error and does not submit update if liquid reserves post-sync are <= current liquid reserves and are insufficient to execute leaf", async function () {
        const liquidReserves = toBNWei("1");
        const postUpdateLiquidReserves = liquidReserves.sub(1);

        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);

        balanceAllocator.testSetBalance(
          hubPoolClient.chainId,
          l1Token_1.address,
          hubPool.address,
          postUpdateLiquidReserves
        );

        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          [{ netSendAmounts: [liquidReserves.mul(2)], l1Tokens: [l1Token_1.address], chainId: 1 }],
          true
        );
        expect(updated.size).to.equal(0);
        const errorLogs = spy.getCalls().filter((call) => call.lastArg.level === "warn");
        expect(errorLogs.length).to.equal(1);
        expect(errorLogs[0].lastArg.message).to.contain("Not enough funds to execute ALL non-Ethereum");
        expect(lastSpyLogIncludes(spy, "liquid reserves would not increase")).to.be.true;
      });
    });
    describe("_updateOldExchangeRates", function () {
      it("exits early if we recently synced l1 token", async function () {
        mockHubPoolClient.currentTime = 10_000;
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 10_000, toBNWei("0"));
        await dataworkerInstance._updateOldExchangeRates([l1Token_1.address], true);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("exits early if liquid reserves wouldn't increase for token post-update", async function () {
        // Last update was at time 0, current time is at 1_000_000, so definitely past the update threshold
        mockHubPoolClient.currentTime = 1_000_000;
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0);

        // Hardcode multicall output such that it looks like liquid reserves stayed the same
        fakeHubPool.multicall.returns([
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            bnZero, // liquid reserves
            bnZero, // unaccumulated fees
          ]),
          ZERO_ADDRESS, // sync output
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            bnZero, // liquid reserves, equal to "current" reserves
            bnZero, // unaccumulated fees
          ]),
        ]);

        await dataworkerInstance._updateOldExchangeRates([l1Token_1.address], true);
        expect(multiCallerClient.transactionCount()).to.equal(0);

        // Add test when liquid reserves decreases
        fakeHubPool.multicall.returns([
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            toBNWei(1), // liquid reserves
            bnZero, // unaccumulated fees
          ]),
          ZERO_ADDRESS, // sync output
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            toBNWei(1).sub(1), // liquid reserves, less than "current" reserves
            bnZero, // unaccumulated fees
          ]),
        ]);

        await dataworkerInstance._updateOldExchangeRates([l1Token_1.address], true);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("submits update if liquid reserves would increase for token post-update and last update was old enough", async function () {
        // Last update was at time 0, current time is at 1_000_000, so definitely past the update threshold
        mockHubPoolClient.currentTime = 1_000_000;
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0);

        // Hardcode multicall output such that it looks like liquid reserves increased
        fakeHubPool.multicall.returns([
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            toBNWei(1), // liquid reserves
            bnZero, // unaccumulated fees
          ]),
          ZERO_ADDRESS,
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            toBNWei(1).add(1), // liquid reserves, higher than "current" reserves
            bnZero, // unaccumulated fees
          ]),
        ]);

        await dataworkerInstance._updateOldExchangeRates([l1Token_1.address], true);
        expect(multiCallerClient.transactionCount()).to.equal(1);
      });
    });
  });
  describe("_executePoolRebalanceLeaves", async function () {
    let token1: string, token2: string, balanceAllocator: BalanceAllocator;
    beforeEach(function () {
      token1 = randomAddress();
      token2 = randomAddress();
      balanceAllocator = getNewBalanceAllocator();
      balanceAllocator.testSetBalance(hubPoolClient.chainId, token1, hubPool.address, toBNWei("2"));
      balanceAllocator.testSetBalance(hubPoolClient.chainId, token2, hubPool.address, toBNWei("2"));
    });
    it("non-orbit leaf", async function () {
      // Should just submit execution
      const leaves: PoolRebalanceLeaf[] = [
        {
          chainId: 10,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1"), toBNWei("1")],
          netSendAmounts: [toBNWei("1"), toBNWei("1")],
          runningBalances: [toBNWei("1"), toBNWei("1")],
          leafId: 0,
          l1Tokens: [token1, token2],
        },
        {
          chainId: 137,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1"), toBNWei("1")],
          netSendAmounts: [toBNWei("1"), toBNWei("1")],
          runningBalances: [toBNWei("1"), toBNWei("1")],
          leafId: 0,
          l1Tokens: [token1, token2],
        },
      ];
      const result = await dataworkerInstance._executePoolRebalanceLeaves(
        spokePoolClients,
        leaves,
        balanceAllocator,
        buildPoolRebalanceLeafTree(leaves),
        true
      );
      expect(result).to.equal(2);

      expect(multiCallerClient.transactionCount()).to.equal(2);
      const queuedTransactions = multiCallerClient.getQueuedTransactions(hubPoolClient.chainId);
      expect(queuedTransactions[0].method).to.equal("executeRootBundle");
      expect(queuedTransactions[0].message).to.match(/chain 10/);
      expect(queuedTransactions[1].method).to.equal("executeRootBundle");
      expect(queuedTransactions[1].message).to.match(/chain 137/);
    });
    it("Subtracts virtual balance from hub pool", async function () {
      // All chain leaves remove virtual balance from hub pool
      const leaves: PoolRebalanceLeaf[] = [
        {
          chainId: 42161,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [toBNWei("1")],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [token1],
        },
        {
          chainId: hubPoolClient.chainId,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [toBNWei("1")],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [token1],
        },
      ];
      const result = await dataworkerInstance._executePoolRebalanceLeaves(
        spokePoolClients,
        leaves,
        balanceAllocator,
        buildPoolRebalanceLeafTree(leaves),
        true
      );
      expect(result).to.equal(2);
      expect(await balanceAllocator.getUsed(hubPoolClient.chainId, token1, hubPoolClient.hubPool.address)).to.equal(
        toBNWei("2")
      );
    });
    it("Adds virtual balance to SpokePool for ethereum leaves", async function () {
      const leaves: PoolRebalanceLeaf[] = [
        {
          chainId: hubPoolClient.chainId,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [toBNWei("1")],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [token1],
        },
      ];
      const result = await dataworkerInstance._executePoolRebalanceLeaves(
        spokePoolClients,
        leaves,
        balanceAllocator,
        buildPoolRebalanceLeafTree(leaves),
        true
      );
      expect(result).to.equal(1);
      expect(
        await balanceAllocator.getUsed(
          hubPoolClient.chainId,
          token1,
          spokePoolClients[hubPoolClient.chainId].spokePool.address
        )
      ).to.equal(toBNWei("-1"));
    });
    it("funds arbitrum leaf", async function () {
      // Adds one fee per net send amount + one extra if groupIndex = 0
      const leaves: PoolRebalanceLeaf[] = [
        {
          chainId: 42161,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1"), toBNWei("1")],
          netSendAmounts: [toBNWei("1"), toBNWei("1")],
          runningBalances: [toBNWei("1"), toBNWei("1")],
          leafId: 0,
          l1Tokens: [token1, token2],
        },
        {
          chainId: 42161,
          groupIndex: 1,
          bundleLpFees: [toBNWei("1"), toBNWei("1")],
          netSendAmounts: [toBNWei("1"), toBNWei("1")],
          runningBalances: [toBNWei("1"), toBNWei("1")],
          leafId: 0,
          l1Tokens: [token1, token2],
        },
      ];
      // Should have a total of 2 + 1 + 2 = 5 fees.
      const { amountWei, amountMultipleToFund } = ARBITRUM_ORBIT_L1L2_MESSAGE_FEE_DATA[CHAIN_IDs.ARBITRUM];
      const expectedFee = toBNWei(amountWei).mul(amountMultipleToFund);
      const expectedFeeLeaf1 = expectedFee.mul(2).add(expectedFee);
      const expectedFeeLeaf2 = expectedFee.mul(2);
      const result = await dataworkerInstance._executePoolRebalanceLeaves(
        spokePoolClients,
        leaves,
        balanceAllocator,
        buildPoolRebalanceLeafTree(leaves),
        true
      );
      expect(result).to.equal(2);

      // Should submit two transactions to load ETH for each leaf plus pool rebalance leaf execution.
      expect(multiCallerClient.transactionCount()).to.equal(4);
      const queuedTransactions = multiCallerClient.getQueuedTransactions(hubPoolClient.chainId);
      expect(queuedTransactions[0].method).to.equal("loadEthForL2Calls");
      expect(queuedTransactions[0].value).to.equal(expectedFeeLeaf1);
      expect(queuedTransactions[1].method).to.equal("loadEthForL2Calls");
      expect(queuedTransactions[1].value).to.equal(expectedFeeLeaf2);
      expect(queuedTransactions[2].method).to.equal("executeRootBundle");
      expect(queuedTransactions[3].method).to.equal("executeRootBundle");
    });
    it("funds custom gas token orbit leaf", async function () {
      // Replicate custom gas token setups:
      const azero = await smock.fake(ERC20.abi, {
        address: TOKEN_SYMBOLS_MAP.AZERO.addresses[CHAIN_IDs.MAINNET],
        provider: hubPoolClient.hubPool.signer.provider,
      });
      // Custom gas token funder for AZERO
      const { amountWei, amountMultipleToFund, feePayer } = ARBITRUM_ORBIT_L1L2_MESSAGE_FEE_DATA[CHAIN_IDs.ALEPH_ZERO];
      assert(feePayer !== undefined);
      const customGasTokenFunder = feePayer;
      azero.balanceOf.whenCalledWith(customGasTokenFunder).returns(0);
      expect(await balanceAllocator.getBalance(hubPoolClient.chainId, azero.address, customGasTokenFunder)).to.equal(0);

      // Adds one fee per net send amount + one extra if groupIndex = 0
      const leaves: PoolRebalanceLeaf[] = [
        {
          chainId: 41455,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1"), toBNWei("1")],
          netSendAmounts: [toBNWei("1"), toBNWei("1")],
          runningBalances: [toBNWei("1"), toBNWei("1")],
          leafId: 0,
          l1Tokens: [token1, token2],
        },
        {
          chainId: 41455,
          groupIndex: 1,
          bundleLpFees: [toBNWei("1"), toBNWei("1")],
          netSendAmounts: [toBNWei("1"), toBNWei("1")],
          runningBalances: [toBNWei("1"), toBNWei("1")],
          leafId: 0,
          l1Tokens: [token1, token2],
        },
      ];
      // Should have a total of 2 + 1 + 2 = 5 fees.
      const expectedFee = toBNWei(amountWei).mul(amountMultipleToFund);
      const expectedFeeLeaf1 = expectedFee.mul(2).add(expectedFee);
      const expectedFeeLeaf2 = expectedFee.mul(2);
      azero.balanceOf
        .whenCalledWith(await hubPoolClient.hubPool.signer.getAddress())
        .returns(expectedFeeLeaf1.add(expectedFeeLeaf2));
      const result = await dataworkerInstance._executePoolRebalanceLeaves(
        spokePoolClients,
        leaves,
        balanceAllocator,
        buildPoolRebalanceLeafTree(leaves),
        true
      );
      expect(result).to.equal(2);

      // Should submit two transactions to load ETH for each leaf plus pool rebalance leaf execution.
      expect(multiCallerClient.transactionCount()).to.equal(4);
      const queuedTransactions = multiCallerClient.getQueuedTransactions(hubPoolClient.chainId);
      expect(queuedTransactions[0].method).to.equal("transfer");
      expect(queuedTransactions[0].args).to.deep.equal([customGasTokenFunder, expectedFeeLeaf1]);
      expect(queuedTransactions[1].method).to.equal("transfer");
      expect(queuedTransactions[1].args).to.deep.equal([customGasTokenFunder, expectedFeeLeaf2]);
      expect(queuedTransactions[2].method).to.equal("executeRootBundle");
      expect(queuedTransactions[3].method).to.equal("executeRootBundle");
    });
    it("fails to fund custom gas token orbit leaf", async function () {
      // Replicate custom gas token setups, but this time do not set a balance for the custom gas token funder.
      const azero = await smock.fake(ERC20.abi, {
        address: TOKEN_SYMBOLS_MAP.AZERO.addresses[CHAIN_IDs.MAINNET],
        provider: hubPoolClient.hubPool.signer.provider,
      });
      // Custom gas token funder for AZERO
      const customGasTokenFunder = "0x0d57392895Db5aF3280e9223323e20F3951E81B1";
      azero.balanceOf.whenCalledWith(customGasTokenFunder).returns(0);
      expect(await balanceAllocator.getBalance(hubPoolClient.chainId, azero.address, customGasTokenFunder)).to.equal(0);

      // Adds one fee per net send amount + one extra if groupIndex = 0
      const leaves: PoolRebalanceLeaf[] = [
        {
          chainId: 41455,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1"), toBNWei("1")],
          netSendAmounts: [toBNWei("1"), toBNWei("1")],
          runningBalances: [toBNWei("1"), toBNWei("1")],
          leafId: 0,
          l1Tokens: [token1, token2],
        },
      ];
      // Should throw an error if caller doesn't have enough custom gas token to fund
      // DonationBox.
      const result = await dataworkerInstance._executePoolRebalanceLeaves(
        spokePoolClients,
        leaves,
        balanceAllocator,
        buildPoolRebalanceLeafTree(leaves),
        true
      );
      expect(result).to.equal(0);
      expect(lastSpyLogLevel(spy)).to.equal("error");
      expect(lastSpyLogIncludes(spy, "Failed to fund")).to.be.true;
    });
    it("Ignores leaves without sufficient reserves to execute", async function () {
      // Should only be able to execute the first leaf
      balanceAllocator.testSetBalance(hubPoolClient.chainId, token1, hubPoolClient.hubPool.address, toBNWei("1"));

      const leaves: PoolRebalanceLeaf[] = [
        {
          chainId: 10,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [toBNWei("1")],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [token1],
        },
        {
          chainId: 137,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1")],
          netSendAmounts: [toBNWei("1")],
          runningBalances: [toBNWei("1")],
          leafId: 0,
          l1Tokens: [token1],
        },
      ];
      const result = await dataworkerInstance._executePoolRebalanceLeaves(
        spokePoolClients,
        leaves,
        balanceAllocator,
        buildPoolRebalanceLeafTree(leaves),
        true
      );
      expect(result).to.equal(1);
    });
  });
  describe("_getExecutablePoolRebalanceLeaves", function () {
    let token1: string, token2: string, balanceAllocator: BalanceAllocator;
    beforeEach(function () {
      token1 = randomAddress();
      token2 = randomAddress();
      balanceAllocator = getNewBalanceAllocator();
    });
    it("All l1 tokens on single leaf are executable", async function () {
      balanceAllocator.testSetBalance(hubPoolClient.chainId, token1, hubPoolClient.hubPool.address, toBNWei("1"));
      balanceAllocator.testSetBalance(hubPoolClient.chainId, token2, hubPoolClient.hubPool.address, toBNWei("1"));
      const leaves = await dataworkerInstance._getExecutablePoolRebalanceLeaves(
        [
          {
            chainId: 10,
            groupIndex: 0,
            bundleLpFees: [toBNWei("1"), toBNWei("1")],
            netSendAmounts: [toBNWei("1"), toBNWei("1")],
            runningBalances: [toBNWei("1"), toBNWei("1")],
            leafId: 0,
            l1Tokens: [token1, token2],
          },
        ],
        balanceAllocator
      );
      expect(leaves.length).to.equal(1);
    });
    it("Some l1 tokens on single leaf are not executable", async function () {
      // Not enough to cover one net send amounts of 1
      balanceAllocator.testSetBalance(hubPoolClient.chainId, token1, hubPoolClient.hubPool.address, toBNWei("0"));
      balanceAllocator.testSetBalance(hubPoolClient.chainId, token2, hubPoolClient.hubPool.address, toBNWei("1"));
      const leaves = await dataworkerInstance._getExecutablePoolRebalanceLeaves(
        [
          {
            chainId: 10,
            groupIndex: 0,
            bundleLpFees: [toBNWei("1"), toBNWei("1")],
            netSendAmounts: [toBNWei("1"), toBNWei("1")],
            runningBalances: [toBNWei("1"), toBNWei("1")],
            leafId: 0,
            l1Tokens: [token1, token2],
          },
        ],
        balanceAllocator
      );
      expect(leaves.length).to.equal(0);
      const errorLogs = spy.getCalls().filter((call) => call.lastArg.level === "error");
      expect(errorLogs.length).to.equal(1);
      expect(errorLogs[0].lastArg.message).to.contain("Not enough funds to execute");
    });
    it("All l1 tokens on multiple leaves are executable", async function () {
      // Covers 2 leaves each with one net send amount of 1
      balanceAllocator.testSetBalance(hubPoolClient.chainId, token1, hubPoolClient.hubPool.address, toBNWei("2"));
      balanceAllocator.testSetBalance(hubPoolClient.chainId, token2, hubPoolClient.hubPool.address, toBNWei("2"));
      const leaves = await dataworkerInstance._getExecutablePoolRebalanceLeaves(
        [
          {
            chainId: 10,
            groupIndex: 0,
            bundleLpFees: [toBNWei("1"), toBNWei("1")],
            netSendAmounts: [toBNWei("1"), toBNWei("1")],
            runningBalances: [toBNWei("1"), toBNWei("1")],
            leafId: 0,
            l1Tokens: [token1, token2],
          },
          {
            chainId: 42161,
            groupIndex: 0,
            bundleLpFees: [toBNWei("1"), toBNWei("1")],
            netSendAmounts: [toBNWei("1"), toBNWei("1")],
            runningBalances: [toBNWei("1"), toBNWei("1")],
            leafId: 0,
            l1Tokens: [token1, token2],
          },
        ],
        balanceAllocator
      );
      expect(leaves.length).to.equal(2);
    });
    it("Some l1 tokens are not executable after first leaf is executed", async function () {
      // 1 only covers the first leaf
      balanceAllocator.testSetBalance(hubPoolClient.chainId, token1, hubPoolClient.hubPool.address, toBNWei("1"));
      balanceAllocator.testSetBalance(hubPoolClient.chainId, token2, hubPoolClient.hubPool.address, toBNWei("2"));

      const leaves = await dataworkerInstance._getExecutablePoolRebalanceLeaves(
        [
          {
            chainId: 10,
            groupIndex: 0,
            bundleLpFees: [toBNWei("1"), toBNWei("1")],
            netSendAmounts: [toBNWei("1"), toBNWei("1")],
            runningBalances: [toBNWei("1"), toBNWei("1")],
            leafId: 0,
            l1Tokens: [token1, token2],
          },
          {
            chainId: 42161,
            groupIndex: 0,
            bundleLpFees: [toBNWei("1"), toBNWei("1")],
            netSendAmounts: [toBNWei("1"), toBNWei("1")],
            runningBalances: [toBNWei("1"), toBNWei("1")],
            leafId: 0,
            l1Tokens: [token1, token2],
          },
        ],
        balanceAllocator
      );
      expect(leaves.length).to.equal(1);
      expect(leaves[0].chainId).to.equal(10);
      const errorLogs = spy.getCalls().filter((call) => call.lastArg.level === "error");
      expect(errorLogs.length).to.equal(1);
    });
  });
});
