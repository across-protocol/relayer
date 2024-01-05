import { HubPoolClient, MultiCallerClient, SpokePoolClient } from "../src/clients";
import { MAX_UINT_VAL, toBNWei } from "../src/utils";
import {
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  amountToDeposit,
} from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import {
  Contract,
  FakeContract,
  SignerWithAddress,
  buildDeposit,
  buildFillForRepaymentChain,
  ethers,
  expect,
  smock,
  toBN,
  zeroAddress,
} from "./utils";

// Tested
import { BalanceAllocator } from "../src/clients/BalanceAllocator";
import { spokePoolClientsToProviders } from "../src/common";
import { Dataworker } from "../src/dataworker/Dataworker";
import { MockHubPoolClient } from "./mocks/MockHubPoolClient";

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

    // Should be 3 transactions: 1 for the to chain, 1 for the from chain, and 1 for the extra ETH sent to cover
    // arbitrum gas fees. exchangeRateCurrent isn't updated because liquidReserves wouldn't increase after calling
    // sync() on the spoke pool.
    expect(multiCallerClient.transactionCount()).to.equal(3);
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
  describe("_updateExchangeRates", function () {
    let mockHubPoolClient: MockHubPoolClient, fakeHubPool: FakeContract;
    beforeEach(async function () {
      fakeHubPool = await smock.fake(hubPool.interface, { address: hubPool.address });
      mockHubPoolClient = new MockHubPoolClient(hubPoolClient.logger, fakeHubPool, hubPoolClient.configStoreClient);
      mockHubPoolClient.setTokenInfoToReturn({ address: l1Token_1.address, decimals: 18, symbol: "TEST" });
      dataworkerInstance.clients.hubPoolClient = mockHubPoolClient;
    });
    it("exits early if we recently synced l1 token", async function () {
      mockHubPoolClient.currentTime = 10_000;
      mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 10_000);
      await dataworkerInstance._updateExchangeRates([l1Token_1.address], true);
      expect(multiCallerClient.transactionCount()).to.equal(0);
    });
    it("exits early if liquid reserves wouldn't increase for token post-update", async function () {
      // Last update was at time 0, current time is at 10_000, so definitely past the update threshold
      mockHubPoolClient.currentTime = 10_000;
      mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0);

      // Hardcode multicall output such that it looks like liquid reserves stayed the same
      fakeHubPool.multicall.returns([
        hubPool.interface.encodeFunctionResult("pooledTokens", [
          zeroAddress, // lp token address
          true, // enabled
          0, // last lp fee update
          toBN(0), // utilized reserves
          toBN(0), // liquid reserves
          toBN(0), // unaccumulated fees
        ]),
        zeroAddress, // sync output
        hubPool.interface.encodeFunctionResult("pooledTokens", [
          zeroAddress, // lp token address
          true, // enabled
          0, // last lp fee update
          toBN(0), // utilized reserves
          toBN(0), // liquid reserves, equal to "current" reserves
          toBN(0), // unaccumulated fees
        ]),
      ]);

      await dataworkerInstance._updateExchangeRates([l1Token_1.address], true);
      expect(multiCallerClient.transactionCount()).to.equal(0);

      // Add test when liquid reserves decreases
      fakeHubPool.multicall.returns([
        hubPool.interface.encodeFunctionResult("pooledTokens", [
          zeroAddress, // lp token address
          true, // enabled
          0, // last lp fee update
          toBN(0), // utilized reserves
          toBNWei(1), // liquid reserves
          toBN(0), // unaccumulated fees
        ]),
        zeroAddress, // sync output
        hubPool.interface.encodeFunctionResult("pooledTokens", [
          zeroAddress, // lp token address
          true, // enabled
          0, // last lp fee update
          toBN(0), // utilized reserves
          toBNWei(1).sub(1), // liquid reserves, less than "current" reserves
          toBN(0), // unaccumulated fees
        ]),
      ]);

      await dataworkerInstance._updateExchangeRates([l1Token_1.address], true);
      expect(multiCallerClient.transactionCount()).to.equal(0);
    });
    it("submits update if liquid reserves would increase for token post-update and last update was old enough", async function () {
      // Last update was at time 0, current time is at 10_000, so definitely past the update threshold
      mockHubPoolClient.currentTime = 10_000;
      mockHubPoolClient.setLpTokenInfo(l1Token_1.address, 0);

      // Hardcode multicall output such that it looks like liquid reserves increased
      fakeHubPool.multicall.returns([
        hubPool.interface.encodeFunctionResult("pooledTokens", [
          "0x0000000000000000000000000000000000000000", // lp token address
          true, // enabled
          0, // last lp fee update
          toBN(0), // utilized reserves
          toBNWei(1), // liquid reserves
          toBN(0), // unaccumulated fees
        ]),
        "0x0000000000000000000000000000000000000000",
        hubPool.interface.encodeFunctionResult("pooledTokens", [
          "0x0000000000000000000000000000000000000000", // lp token address
          true, // enabled
          0, // last lp fee update
          toBN(0), // utilized reserves
          toBNWei(1).add(1), // liquid reserves, higher than "current" reserves
          toBN(0), // unaccumulated fees
        ]),
      ]);

      await dataworkerInstance._updateExchangeRates([l1Token_1.address], true);
      expect(multiCallerClient.transactionCount()).to.equal(1);
    });
  });
});
