import { HubPoolClient, MultiCallerClient, SpokePoolClient } from "../src/clients";
import { bnZero, getCurrentTime, MAX_UINT_VAL, toBNWei } from "../src/utils";
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
let l1Token_1: Contract, hubPool: Contract, spokePool_4: Contract;
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
      spokePool_4,
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
    await multiCallerClient.executeTxnQueues();

    // Advance time and execute leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    const balanceAllocator = new BalanceAllocator(providers);
    let leafCount = await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, balanceAllocator);
    expect(leafCount).to.equal(2);

    // Used value should be positive.
    expect(balanceAllocator.getUsed(hubPoolClient.chainId, l1Token_1.address, hubPool.address)).to.gt(0);

    // Should be 4 transactions: 1 for the to chain, 1 for the from chain, 1 for the extra ETH sent to cover
    // arbitrum gas fees, and 1 to update the exchangeRate to execute the destination chain leaf.
    // console.log(spy.getCall(-1))
    expect(multiCallerClient.transactionCount()).to.equal(4);
    await multiCallerClient.executeTxnQueues();

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
  it("BalanceAllocator used values are correctly updated", async function () {
    // Send deposit on SpokePool with same chain ID as hub chain.
    // Fill it on a different spoke pool.
    // This should result in a net 0 used value for the hub pool.

    await updateAllClients();

    // Send a deposit and a fill so that dataworker builds simple roots.
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
    // Now, fill the deposit. This should result in a positive netSendAmount to the destination chain,
    // which should increase the used value for the hub pool.
    await fillV3(spokePool_2, depositor, deposit, destinationChainId);
    await updateAllClients();

    const providers = {
      ...spokePoolClientsToProviders(spokePoolClients),
      [hubPoolClient.chainId]: hubPool.provider,
    };

    await dataworkerInstance.proposeRootBundle(spokePoolClients);

    // Execute queue and check that root bundle is pending:
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTxnQueues();

    // Advance time and execute leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    const balanceAllocator = new BalanceAllocator(providers);
    const leafCount = await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, balanceAllocator);
    expect(leafCount).to.equal(2);

    // Deposit on Hub SpokePool should return funds to the hub pool, so there should be positive "used" value
    // for the spoke pool and negative for the hub pool.
    const usedHubPoolBalance = balanceAllocator.getUsed(hubPoolClient.chainId, l1Token_1.address, hubPool.address);
    // The used value for the hub pool should be slightly negative since it has accrued some
    // bundle LP fees after paying out the refund to the destination chain and taking in the deposit
    // from the origin chain.
    expect(usedHubPoolBalance).to.equal("-83532215599429900");
    expect(balanceAllocator.getUsed(hubPoolClient.chainId, l1Token_1.address, spokePool_4.address)).to.equal(
      amountToDeposit
    );
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
      });
      it("groups aggregate net send amounts by L1 token", async function () {
        // Total net send amount is 1 for each token but they are not summed together because they are different,
        // so the liquid reserves of 1 for each individual token is enough.
        const liquidReserves = toBNWei("1");
        const l1Token2 = erc20_1.address;
        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {
            [l1Token_1.address]: liquidReserves,
            [l1Token2]: liquidReserves,
          },

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
      it("errors if a single l1 token's aggregate net send amount exceeds liquid reserves", async function () {
        const liquidReserves = toBNWei("1");
        const l1Token2 = erc20_1.address;
        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {
            [l1Token_1.address]: liquidReserves,
            [l1Token2]: liquidReserves,
          },

          balanceAllocator,
          [
            { netSendAmounts: [liquidReserves], l1Tokens: [l1Token_1.address], chainId: 1 },
            // This one execeeds the liquid reserves for the l1 token.
            { netSendAmounts: [liquidReserves.mul(2)], l1Tokens: [l1Token2], chainId: 10 },
          ],
          true
        );
        expect(lastSpyLogLevel(spy)).to.equal("error");
        expect(lastSpyLogIncludes(spy, "will fail")).to.be.true;
        expect(spy.getCall(-1).lastArg.l1Token).to.equal(l1Token2);
        expect(updated.size).to.equal(0);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("ignores negative net send amounts", async function () {
        const liquidReserves = toBNWei("2");
        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {
            [l1Token_1.address]: liquidReserves.sub(toBNWei("1")),
          },

          balanceAllocator,
          [
            { netSendAmounts: [liquidReserves], l1Tokens: [l1Token_1.address], chainId: 1 },
            // This negative liquid reserves doesn't offset the positive one, it just gets ignored.
            { netSendAmounts: [liquidReserves.mul(-1)], l1Tokens: [l1Token_1.address], chainId: 10 },
          ],
          true
        );
        expect(lastSpyLogLevel(spy)).to.equal("error");
        expect(lastSpyLogIncludes(spy, "will fail")).to.be.true;
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
          [
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 1 },
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 10 },
          ],
          true
        );
        expect(updated.size).to.equal(0);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("logs error if updated liquid reserves aren't enough to execute leaf", async function () {
        const netSendAmount = toBNWei("1");
        const liquidReserves = toBNWei("1");
        // Total net send amount will be 2, but liquid reserves are only 1.
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);

        // Even after simulating sync, there are not enough liquid reserves.
        fakeHubPool.multicall.returns([
          ZERO_ADDRESS, // sync output
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            liquidReserves, // liquid reserves, still < than total netSendAmount
            bnZero, // unaccumulated fees
          ]),
        ]);

        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          [
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 1 },
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 10 },
          ],
          true
        );
        expect(lastSpyLogLevel(spy)).to.equal("error");
        expect(lastSpyLogIncludes(spy, "will fail")).to.be.true;
        expect(updated.size).to.equal(0);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("logs error if updated liquid reserves when accounting for BalanceAllocator.used aren't enough to execute leaf", async function () {
        const netSendAmount = toBNWei("1");
        // Normally 2 would be enough to cover to leaves with netSendAmount=1, but we're going to add
        // 1 to the used amount, so the virtualHubPool liquid reserves will only be 1, which
        // won't be enough.
        const liquidReserves = toBNWei("2");
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
        balanceAllocator.addUsed(1, l1Token_1.address, hubPool.address, toBNWei("1"));

        // Even after simulating sync, there are not enough liquid reserves.
        fakeHubPool.multicall.returns([
          ZERO_ADDRESS, // sync output
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            liquidReserves, // liquid reserves, >= than total netSendAmount
            bnZero, // unaccumulated fees
          ]),
        ]);

        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          [
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 1 },
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 10 },
          ],
          true
        );
        expect(lastSpyLogLevel(spy)).to.equal("error");
        expect(lastSpyLogIncludes(spy, "will fail")).to.be.true;
        expect(updated.size).to.equal(0);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("submits update: liquid reserves post-sync are enough to execute leaf", async function () {
        // Liquid reserves cover one leaf but not two.
        const netSendAmount = toBNWei("10");
        const liquidReserves = toBNWei("11");

        // Current reserves are insufficient to cover the two leaves:
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);

        // Post-update, liquid reserves will be enough to cover the two leaves:
        fakeHubPool.multicall.returns([
          ZERO_ADDRESS, // sync output
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            netSendAmount.mul(2),
            bnZero, // unaccumulated fees
          ]),
        ]);

        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          [
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 1 },
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 10 },
          ],
          true
        );
        expect(updated.size).to.equal(1);
        expect(spy.getCall(-1).lastArg.virtualHubPoolBalance).to.equal(netSendAmount.mul(2));
        expect(updated.has(l1Token_1.address)).to.be.true;
        expect(multiCallerClient.transactionCount()).to.equal(1);
      });
      it("submits update: liquid reserves post-sync plus BalanceAllocator.used are enough to execute leaf", async function () {
        // Liquid reserves cover both leaves.
        const netSendAmount = toBNWei("10");
        const liquidReserves = toBNWei("20");
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);

        // However, there are used balance we need to keep track of
        balanceAllocator.addUsed(1, l1Token_1.address, hubPool.address, toBNWei("1"));

        // Post-update, liquid reserves will be enough to cover the two leaves:
        fakeHubPool.multicall.returns([
          ZERO_ADDRESS, // sync output
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            netSendAmount.mul(3),
            bnZero, // unaccumulated fees
          ]),
        ]);

        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
          balanceAllocator,
          [
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 1 },
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 10 },
          ],
          true
        );
        expect(updated.size).to.equal(1);
        expect(spy.getCall(-1).lastArg.virtualHubPoolBalance).to.equal(netSendAmount.mul(3).sub(toBNWei("1")));
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
