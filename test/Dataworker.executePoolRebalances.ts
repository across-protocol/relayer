import { HubPoolClient, MultiCallerClient, SpokePoolClient } from "../src/clients";
import {
  bnZero,
  buildPoolRebalanceLeafTree,
  CHAIN_IDs,
  ERC20,
  getCurrentTime,
  MAX_UINT_VAL,
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
  assertPromiseError,
  randomAddress,
} from "./utils";

// Tested
import { BalanceAllocator } from "../src/clients/BalanceAllocator";
import { spokePoolClientsToProviders } from "../src/common";
import { Dataworker } from "../src/dataworker/Dataworker";
import { MockHubPoolClient } from "./mocks/MockHubPoolClient";
import { PoolRebalanceLeaf } from "../src/interfaces";

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
    await multiCallerClient.executeTxnQueues();

    // Advance time and execute leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    const balanceAllocator = new BalanceAllocator(providers);
    let leafCount = await dataworkerInstance.executePoolRebalanceLeaves(spokePoolClients, balanceAllocator);
    expect(leafCount).to.equal(2);

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
      it("does not subtract negative net send amounts from available reserves", async function () {
        const liquidReserves = toBNWei("1");
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
        const { syncedL1Tokens, availableLiquidReserves } =
          await dataworkerInstance._updateExchangeRatesBeforeExecutingHubChainLeaves(
            { netSendAmounts: [toBNWei(-1)], l1Tokens: [l1Token_1.address] },
            true
          );
        expect(syncedL1Tokens.size).to.equal(0);
        expect(availableLiquidReserves[l1Token_1.address]).to.equal(liquidReserves);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("subtracts positive net send amounts from available reserves", async function () {
        const currentReserves = toBNWei("2");
        const netSendAmount = toBNWei("1");
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, currentReserves);

        const { syncedL1Tokens, availableLiquidReserves } =
          await dataworkerInstance._updateExchangeRatesBeforeExecutingHubChainLeaves(
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address] },
            true
          );
        expect(availableLiquidReserves[l1Token_1.address]).to.equal(currentReserves.sub(netSendAmount));
        expect(syncedL1Tokens.size).to.equal(0);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
      it("throws error if updated liquid reserves aren't enough to execute leaf", async function () {
        const netSendAmount = toBNWei("1");

        fakeHubPool.multicall.returns([
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

        await assertPromiseError(
          dataworkerInstance._updateExchangeRatesBeforeExecutingHubChainLeaves(
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address] },
            true
          ),
          "Not enough funds to execute Ethereum pool rebalance leaf"
        );
      });
      it("submits update if updated liquid reserves cover execution of pool leaf", async function () {
        const netSendAmount = toBNWei("1");
        const updatedLiquidReserves = netSendAmount.add(1);

        fakeHubPool.multicall.returns([
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

        const { syncedL1Tokens, availableLiquidReserves } =
          await dataworkerInstance._updateExchangeRatesBeforeExecutingHubChainLeaves(
            { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address] },
            true
          );
        expect(syncedL1Tokens.size).to.equal(1);
        expect(syncedL1Tokens.has(l1Token_1.address)).to.be.true;
        expect(availableLiquidReserves[l1Token_1.address]).to.equal(updatedLiquidReserves.sub(netSendAmount));
        expect(multiCallerClient.transactionCount()).to.equal(1);
      });
    });
    describe("_updateExchangeRatesBeforeExecutingNonHubChainLeaves", function () {
      it("exits early if current liquid reserves are greater than all individual net send amount", async function () {
        const netSendAmount = toBNWei("1");
        const liquidReserves = toBNWei("3");
        // For this test, do not pass in a liquid reserves object and force dataworker to load
        // from HubPoolClient
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, liquidReserves);
        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
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
        await assertPromiseError(
          dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
            {
              [l1Token_1.address]: liquidReserves,
              [l1Token2]: liquidReserves,
            },
            [
              { netSendAmounts: [liquidReserves], l1Tokens: [l1Token_1.address], chainId: 1 },
              // This one execeeds the liquid reserves for the l1 token.
              { netSendAmounts: [liquidReserves.mul(2)], l1Tokens: [l1Token2], chainId: 10 },
            ],
            true
          ),
          "Not enough funds to execute non-Ethereum"
        );
      });
      it("ignores negative net send amounts", async function () {
        const liquidReserves = toBNWei("2");
        await assertPromiseError(
          dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
            {
              [l1Token_1.address]: liquidReserves.sub(toBNWei("1")),
            },
            [
              { netSendAmounts: [liquidReserves], l1Tokens: [l1Token_1.address], chainId: 1 },
              // This negative liquid reserves doesn't offset the positive one, it just gets ignored.
              { netSendAmounts: [liquidReserves.mul(-1)], l1Tokens: [l1Token_1.address], chainId: 10 },
            ],
            true
          ),
          "Not enough funds to execute non-Ethereum"
        );
      });
      it("exits early if passed in liquid reserves are greater than net send amount", async function () {
        const netSendAmount = toBNWei("1");
        const liquidReserves = toBNWei("2");
        // For this test, pass in a liquid reserves object
        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {
            [l1Token_1.address]: liquidReserves,
          },
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

        await assertPromiseError(
          dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
            {},
            [
              { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 1 },
              { netSendAmounts: [netSendAmount], l1Tokens: [l1Token_1.address], chainId: 10 },
            ],
            true
          ),
          "Not enough funds to execute non-Ethereum"
        );
      });
      it("submits update: liquid reserves post-sync are enough to execute leaf", async function () {
        // Liquid reserves cover one leaf but not two.
        const postUpdateLiquidReserves = toBNWei("20");

        // Current reserves are insufficient to cover the two leaves:
        mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0, bnZero);

        // Post-update, liquid reserves will be enough to cover the two leaves:
        fakeHubPool.multicall.returns([
          ZERO_ADDRESS, // sync output
          hubPool.interface.encodeFunctionResult("pooledTokens", [
            ZERO_ADDRESS, // lp token address
            true, // enabled
            0, // last lp fee update
            bnZero, // utilized reserves
            postUpdateLiquidReserves,
            bnZero, // unaccumulated fees
          ]),
        ]);

        const updated = await dataworkerInstance._updateExchangeRatesBeforeExecutingNonHubChainLeaves(
          {},
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
        expect(spy.getCall(-1).lastArg.updatedLiquidReserves).to.equal(postUpdateLiquidReserves);
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
  describe("_executePoolRebalanceLeaves", async function () {
    let balanceAllocator: BalanceAllocator;
    beforeEach(async function () {
      const providers = {
        ...spokePoolClientsToProviders(spokePoolClients),
        [hubPoolClient.chainId]: hubPool.provider,
      };
      balanceAllocator = new BalanceAllocator(providers);
      expect(
        await balanceAllocator.getBalance(hubPoolClient.chainId, ZERO_ADDRESS, hubPoolClient.hubPool.address)
      ).to.equal(0);
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
          l1Tokens: [randomAddress(), randomAddress()],
        },
        {
          chainId: 137,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1"), toBNWei("1")],
          netSendAmounts: [toBNWei("1"), toBNWei("1")],
          runningBalances: [toBNWei("1"), toBNWei("1")],
          leafId: 0,
          l1Tokens: [randomAddress(), randomAddress()],
        },
      ];
      await dataworkerInstance._executePoolRebalanceLeaves(
        leaves,
        balanceAllocator,
        buildPoolRebalanceLeafTree(leaves),
        true
      );

      expect(multiCallerClient.transactionCount()).to.equal(2);
      const queuedTransactions = multiCallerClient.getQueuedTransactions(hubPoolClient.chainId);
      expect(queuedTransactions[0].method).to.equal("executeRootBundle");
      expect(queuedTransactions[0].message).to.match(/chain 10/);
      expect(queuedTransactions[1].method).to.equal("executeRootBundle");
      expect(queuedTransactions[1].message).to.match(/chain 137/);
    });
    it("contains arbitrum leaf", async function () {
      // Adds one fee per net send amount + one extra if groupIndex = 0
      const leaves: PoolRebalanceLeaf[] = [
        {
          chainId: 42161,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1"), toBNWei("1")],
          netSendAmounts: [toBNWei("1"), toBNWei("1")],
          runningBalances: [toBNWei("1"), toBNWei("1")],
          leafId: 0,
          l1Tokens: [randomAddress(), randomAddress()],
        },
        {
          chainId: 42161,
          groupIndex: 1,
          bundleLpFees: [toBNWei("1"), toBNWei("1")],
          netSendAmounts: [toBNWei("1"), toBNWei("1")],
          runningBalances: [toBNWei("1"), toBNWei("1")],
          leafId: 0,
          l1Tokens: [randomAddress(), randomAddress()],
        },
      ];
      // Should have a total of 2 + 1 + 2 = 5 fees.
      const expectedFee = toBNWei("0.02");
      const expectedFeeLeaf1 = expectedFee.mul(2).add(expectedFee);
      const expectedFeeLeaf2 = expectedFee.mul(2);
      await dataworkerInstance._executePoolRebalanceLeaves(
        leaves,
        balanceAllocator,
        buildPoolRebalanceLeafTree(leaves),
        true
      );

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
    it("contains custom gas token orbit leaf", async function () {
      // Replicate custom gas token setups:
      const azero = await smock.fake(ERC20.abi, {
        address: TOKEN_SYMBOLS_MAP.AZERO.addresses[CHAIN_IDs.MAINNET],
        provider: hubPoolClient.hubPool.signer.provider,
      });
      azero.balanceOf.whenCalledWith(hubPoolClient.hubPool.address).returns(0);
      expect(
        await balanceAllocator.getBalance(hubPoolClient.chainId, azero.address, hubPoolClient.hubPool.address)
      ).to.equal(0);

      // Adds one fee per net send amount + one extra if groupIndex = 0
      const leaves: PoolRebalanceLeaf[] = [
        {
          chainId: 41455,
          groupIndex: 0,
          bundleLpFees: [toBNWei("1"), toBNWei("1")],
          netSendAmounts: [toBNWei("1"), toBNWei("1")],
          runningBalances: [toBNWei("1"), toBNWei("1")],
          leafId: 0,
          l1Tokens: [randomAddress(), randomAddress()],
        },
        {
          chainId: 41455,
          groupIndex: 1,
          bundleLpFees: [toBNWei("1"), toBNWei("1")],
          netSendAmounts: [toBNWei("1"), toBNWei("1")],
          runningBalances: [toBNWei("1"), toBNWei("1")],
          leafId: 0,
          l1Tokens: [randomAddress(), randomAddress()],
        },
      ];
      // Should have a total of 2 + 1 + 2 = 5 fees.
      const expectedFee = toBNWei("0.49");
      const expectedFeeLeaf1 = expectedFee.mul(2).add(expectedFee);
      const expectedFeeLeaf2 = expectedFee.mul(2);
      await dataworkerInstance._executePoolRebalanceLeaves(
        leaves,
        balanceAllocator,
        buildPoolRebalanceLeafTree(leaves),
        true
      );

      // Should submit two transactions to load ETH for each leaf plus pool rebalance leaf execution.
      expect(multiCallerClient.transactionCount()).to.equal(4);
      const queuedTransactions = multiCallerClient.getQueuedTransactions(hubPoolClient.chainId);
      expect(queuedTransactions[0].method).to.equal("transfer");
      expect(queuedTransactions[0].args).to.deep.equal([hubPoolClient.hubPool.address, expectedFeeLeaf1]);
      expect(queuedTransactions[1].method).to.equal("transfer");
      expect(queuedTransactions[1].args).to.deep.equal([hubPoolClient.hubPool.address, expectedFeeLeaf2]);
      expect(queuedTransactions[2].method).to.equal("executeRootBundle");
      expect(queuedTransactions[3].method).to.equal("executeRootBundle");
    });
  });
});
