import { HubPoolClient, MultiCallerClient, SpokePoolClient } from "../src/clients";
import { bnZero, getCurrentTime, MAX_UINT_VAL, toBN, toBNWei } from "../src/utils";
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
  lastSpyLogLevel,
  smock,
  sinon,
  lastSpyLogIncludes,
} from "./utils";

// Tested
import { BalanceAllocator } from "../src/clients/BalanceAllocator";
import { spokePoolClientsToProviders } from "../src/common";
import { Dataworker } from "../src/dataworker/Dataworker";
import { MockHubPoolClient } from "./mocks/MockHubPoolClient";

// Set to arbitrum to test that the dataworker sends ETH to the HubPool to test L1 --> Arbitrum message transfers.
const destinationChainId = 42161;

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, hubPool: Contract;
let depositor: SignerWithAddress, spy: sinon.SinonSpy;

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
    let leafCount = await dataworkerInstance.executePoolRebalanceLeaves(
      spokePoolClients,
      new BalanceAllocator(providers)
    );
    expect(leafCount).to.equal(2);

    // Should be 4 transactions: 1 for the to chain, 1 for the from chain, 1 for the extra ETH sent to cover
    // arbitrum gas fees, and 1 to update the exchangeRate to execute the destination chain leaf.
    // console.log(spy.getCall(-1))
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
    leafCount = await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, new BalanceAllocator(providers));
    expect(leafCount).to.equal(0);
    expect(multiCallerClient.transactionCount()).to.equal(0);
  });
  describe("update exchange rates", function () {
    let mockHubPoolClient: MockHubPoolClient, fakeHubPool: FakeContract;
    beforeEach(async function () {
      fakeHubPool = await smock.fake(hubPool.interface, { address: hubPool.address });
      mockHubPoolClient = new MockHubPoolClient(hubPoolClient.logger, fakeHubPool, hubPoolClient.configStoreClient);
      mockHubPoolClient.setTokenInfoToReturn({ address: l1Token_1.address, decimals: 18, symbol: "TEST" });
      dataworkerInstance.clients.hubPoolClient = mockHubPoolClient;

      // Sub in a dummy root bundle proposal for use in HubPoolClient update.
      const zero = "0x0000000000000000000000000000000000000000000000000000000000000000";
      fakeHubPool.multicall.returns([
        hubPool.interface.encodeFunctionResult("getCurrentTime", [getCurrentTime().toString()]),
        hubPool.interface.encodeFunctionResult("rootBundleProposal", [zero, zero, zero, 0, ZERO_ADDRESS, 0, 0]),
      ]);

      await updateAllClients();
    });
    describe("_updateExchangeRatesBeforeExecutingHubChainLeaves", function () {
      it("exits early if net send amount is negative", async function () {
        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingHubChainLeaves(
          { netSendAmounts: [toBNWei(-1)], l1Tokens: [l1Token_1.address] },
          true
        );
        expect(Object.keys(updated)).to.have.length(0);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("exits early if current reserves are sufficient to pay for net send amounts", async function () {
        const netSendAmount = toBNWei("1");

        fakeHubPool.multicall.returns([
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            netSendAmount, // liquid reserves
            bnZero, // unaccumulated fees
          ]),
          ZERO_ADDRESS, // sync output
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            bnZero, // liquid reserves, post update. Doesn't matter for this test
            // because we should be early exiting if current liquid reserves are sufficient.
            bnZero, // unaccumulated fees
          ]),
        ]);

        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingHubChainLeaves(
          { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address] },
          true
        );
        expect(Object.keys(updated)).to.have.length(0);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("logs error if updated liquid reserves aren't enough to execute leaf", async function () {
        const netSendAmount = toBNWei("1");

        fakeHubPool.multicall.returns([
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            bnZero, // liquid reserves, set less than netSendAmount
            bnZero, // unaccumulated fees
          ]),
          ZERO_ADDRESS, // sync output
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            bnZero, // liquid reserves, still less than net send amount
            bnZero, // unaccumulated fees
          ]),
        ]);

        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingHubChainLeaves(
          { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address] },
          true
        );
        expect(Object.keys(updated)).to.have.length(0);
        expect(lastSpyLogLevel(spy)).to.equal("error");
        expect(lastSpyLogIncludes(spy, "Not enough funds to execute")).to.be.true;
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("submits update", async function () {
        const netSendAmount = toBNWei("1");
        const updatedLiquidReserves = netSendAmount.add(1);

        fakeHubPool.multicall.returns([
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            bnZero, // liquid reserves, set less than netSendAmount
            bnZero, // unaccumulated fees
          ]),
          ZERO_ADDRESS, // sync output
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            updatedLiquidReserves, // liquid reserves, >= than netSendAmount
            bnZero, // unaccumulated fees
          ]),
        ]);

        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingHubChainLeaves(
          { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address] },
          true
        );
        expect(Object.keys(updated)).to.have.length(1);
        expect(updated[l1Token_1.address]).to.equal(updatedLiquidReserves);
        expect(multiCallerClient.transactionCount()).to.equal(1);
      });
    });
    describe("_updateExchangeRatesBeforeExecutingNonHubChainLeaves", function () {
      let balanceAllocator;
      beforeEach(async function () {
        const providers = {
          ...spokePoolClientsToProviders(spokePoolClients),
          [hubPoolClient.chainId]: hubPool.provider,
        };
        balanceAllocator = new BalanceAllocator(providers);
      });
      it("exits early if net send amount is negative", async function () {
        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          [{ netSendAmounts: [toBNWei(-1)], l1Tokens: [l1Token_1.address], chainId: 1 }],
          true
        );
        expect(updated.size).to.equal(0);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("exits early if current liquid reserves are greater than net send amount", async function () {
        const netSendAmount = toBNWei("1");
        const liquidReserves = toBNWei("2");
        // For this test, do not pass in a liquid reserves object and force dataworker to load
        // from HubPoolClient
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          [{ netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 1 }],
          true
        );
        expect(updated.size).to.equal(0);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("exits early if passed in liquid reserves are greater than net send amount", async function () {
        const netSendAmount = toBNWei("1");
        const liquidReserves = toBNWei("2");
        // For this test, pass in a liquid reserves object
        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {
            [l1Token_1.address]: liquidReserves,
          },
          balanceAllocator,
          [{ netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 1 }],
          true
        );
        expect(updated.size).to.equal(0);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("logs error if updated liquid reserves aren't enough to execute leaf", async function () {
        const netSendAmount = toBNWei("1");
        const liquidReserves = toBNWei("0");
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
        balanceAllocator.addUsed(hubPoolClient.chainId, l1Token_1.address, hubPool.address, toBNWei(0));

        // Even after simulating sync, there are not enough liquid reserves.
        fakeHubPool.multicall.returns([
          ZERO_ADDRESS, // sync output
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            liquidReserves, // liquid reserves, >= than netSendAmount
            bnZero, // unaccumulated fees
          ]),
        ]);

        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          [{ netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 1 }],
          true
        );
        expect(lastSpyLogLevel(spy)).to.equal("error");
        expect(lastSpyLogIncludes(spy, "will fail due to lack of funds to send")).to.be.true;
        expect(updated.size).to.equal(0);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("submits update: liquid reserves post-sync are enough to execute leaf", async function () {
        const netSendAmount = toBNWei("10");
        const liquidReserves = toBNWei("1");
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
        balanceAllocator.addUsed(hubPoolClient.chainId, l1Token_1.address, hubPool.address, toBNWei(1));

        // At this point, passed in liquid reserves will be 1 and the balance allocator will add 1.
        // This won't be enough. However, we should test that the dataworker simulates sync-ing the exchange
        // rate and sees that the liquid reserves post-sync are enough to execute the leaf.
        fakeHubPool.multicall.returns([
          ZERO_ADDRESS, // sync output
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            netSendAmount, // liquid reserves, >= than netSendAmount
            bnZero, // unaccumulated fees
          ]),
        ]);

        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {
            [l1Token_1.address]: liquidReserves,
          },
          balanceAllocator,
          [{ netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 1 }],
          true
        );
        expect(updated.size).to.equal(1);
        expect(updated.has(l1Token_1.address)).to.be.true;
        expect(multiCallerClient.transactionCount()).to.equal(1);
      });
      it("submits update: liquid reserves plus balanceAllocator.used are sufficient", async function () {
        const netSendAmount = toBNWei("1");

        // Liquid reserves are read from HubPoolClient.
        // Liquid reserves are below net send amount, but virtual balance is above net send amount.
        const liquidReserves = toBNWei("0");
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
        balanceAllocator.addUsed(1, l1Token_1.address, hubPool.address, netSendAmount.mul(-1));
        fakeHubPool.multicall.returns([
          ZERO_ADDRESS, // sync output
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            liquidReserves, // liquid reserves, >= than netSendAmount
            bnZero, // unaccumulated fees
          ]),
        ]);
        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          [{ netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 1 }],
          true
        );
        expect(updated.size).to.equal(1);
        expect(updated.has(l1Token_1.address)).to.be.true;
        expect(multiCallerClient.transactionCount()).to.equal(1);
      });
      it("Skips duplicate L1 tokens", async function () {
        const netSendAmount = toBNWei("1");

        // Liquid reserves are passed as input.
        // Liquid reserves are below net send amount, but virtual balance is above net send amount.
        const liquidReserves = toBNWei("0");
        balanceAllocator.addUsed(1, l1Token_1.address, hubPool.address, netSendAmount.mul(-1));
        fakeHubPool.multicall.returns([
          ZERO_ADDRESS, // sync output
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            netSendAmount, // liquid reserves, >= than netSendAmount
            bnZero, // unaccumulated fees
          ]),
        ]);
        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {
            [l1Token_1.address]: liquidReserves,
          },
          balanceAllocator,
          [
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 137 },
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 10 },
          ],
          true
        );
        expect(updated.size).to.equal(1);
        expect(updated.has(l1Token_1.address)).to.be.true;
        expect(multiCallerClient.transactionCount()).to.equal(1);
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
});
