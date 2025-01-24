import { HubPoolClient, MultiCallerClient, SpokePoolClient } from "../src/clients";
import { MAX_UINT_VAL } from "../src/utils";
import { CHAIN_ID_TEST_LIST, amountToDeposit, destinationChainId } from "./constants";
import { setupFastDataworker } from "./fixtures/Dataworker.Fixture";
import {
  Contract,
  SignerWithAddress,
  depositV3,
  ethers,
  expect,
  fillV3Relay,
  lastSpyLogIncludes,
  lastSpyLogLevel,
  requestSlowFill,
  sinon,
  toBNWei,
  utf8ToHex,
} from "./utils";

// Tested
import { Dataworker } from "../src/dataworker/Dataworker";
import { MockConfigStoreClient } from "./mocks";

let spy: sinon.SinonSpy;
let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, hubPool: Contract, configStore: Contract;
let depositor: SignerWithAddress;

let hubPoolClient: HubPoolClient, configStoreClient: MockConfigStoreClient;
let dataworkerInstance: Dataworker, multiCallerClient: MultiCallerClient;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let updateAllClients: () => Promise<void>;

describe("Dataworker: Propose root bundle", async function () {
  beforeEach(async function () {
    ({
      hubPool,
      spokePool_1,
      erc20_1,
      spokePool_2,
      erc20_2,
      mockedConfigStoreClient: configStoreClient,
      configStore,
      hubPoolClient,
      l1Token_1,
      depositor,
      dataworkerInstance,
      spokePoolClients,
      multiCallerClient,
      updateAllClients,
      spy,
    } = await setupFastDataworker(ethers));
  });

  it("Simple lifecycle", async function () {
    await updateAllClients();

    // TEST 1:
    // Before submitting any spoke pool transactions, check that dataworker behaves as expected with no roots.
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    expect(lastSpyLogIncludes(spy, "No pool rebalance leaves, cannot propose")).to.be.true;

    // TEST 2:
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
    await requestSlowFill(spokePool_2, depositor, deposit);
    await updateAllClients();
    const latestBlock2 = await hubPool.provider.getBlockNumber();
    const blockRange2 = CHAIN_ID_TEST_LIST.map(() => [0, latestBlock2]);

    // Construct expected roots before we propose new root so that last log contains logs about submitted txn.
    const expectedPoolRebalanceRoot2 = await dataworkerInstance.buildPoolRebalanceRoot(blockRange2, spokePoolClients);
    const expectedRelayerRefundRoot2 = await dataworkerInstance.buildRelayerRefundRoot(
      blockRange2,
      spokePoolClients,
      expectedPoolRebalanceRoot2.leaves,
      expectedPoolRebalanceRoot2.runningBalances
    );
    const expectedSlowRelayRefundRoot2 = await dataworkerInstance.buildSlowRelayRoot(blockRange2, spokePoolClients);
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    // Should have enqueued a new transaction:
    expect(lastSpyLogIncludes(spy, "Enqueing new root bundle proposal txn")).to.be.true;
    expect(spy.getCall(-1).lastArg.poolRebalanceRoot).to.equal(expectedPoolRebalanceRoot2.tree.getHexRoot());
    expect(spy.getCall(-1).lastArg.relayerRefundRoot).to.equal(expectedRelayerRefundRoot2.tree.getHexRoot());
    expect(spy.getCall(-1).lastArg.slowRelayRoot).to.equal(expectedSlowRelayRefundRoot2.tree.getHexRoot());

    // Execute queue and check that root bundle is pending:
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTxnQueues();
    await updateAllClients();
    expect(hubPoolClient.hasPendingProposal()).to.equal(true);

    // Attempting to propose another root fails:
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    expect(lastSpyLogIncludes(spy, "Has pending proposal, cannot propose")).to.be.true;

    // Advance time and execute leaves:
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    for (const leaf of expectedPoolRebalanceRoot2.leaves) {
      await hubPool.executeRootBundle(
        leaf.chainId,
        leaf.groupIndex,
        leaf.bundleLpFees,
        leaf.netSendAmounts,
        leaf.runningBalances,
        leaf.leafId,
        leaf.l1Tokens,
        expectedPoolRebalanceRoot2.tree.getHexProof(leaf)
      );
    }

    // TEST 3:
    // Submit another root bundle proposal and check bundle block range. There should be no leaves in the new range
    // yet. In the bundle block range, all chains should have increased their start block, including those without
    // pool rebalance leaves because they should use the chain's end block from the latest fully executed proposed
    // root bundle, which should be the bundle block in expectedPoolRebalanceRoot2 + 1.
    await updateAllClients();
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    expect(lastSpyLogIncludes(spy, "No pool rebalance leaves, cannot propose")).to.be.true;

    // TEST 4:
    // Submit another fill and check that dataworker proposes another root:
    await fillV3Relay(spokePool_2, deposit, depositor, destinationChainId);
    await updateAllClients();
    const latestBlock4 = await hubPool.provider.getBlockNumber();
    const blockRange4 = [
      [latestBlock2 + 1, latestBlock4],
      [latestBlock2 + 1, latestBlock4],
      [latestBlock2 + 1, latestBlock4],
      [latestBlock2 + 1, latestBlock4],
    ];
    const expectedPoolRebalanceRoot4 = await dataworkerInstance.buildPoolRebalanceRoot(blockRange4, spokePoolClients);
    const expectedRelayerRefundRoot4 = await dataworkerInstance.buildRelayerRefundRoot(
      blockRange4,
      spokePoolClients,
      expectedPoolRebalanceRoot4.leaves,
      expectedPoolRebalanceRoot4.runningBalances
    );
    const expectedSlowRelayRefundRoot4 = await dataworkerInstance.buildSlowRelayRoot(blockRange4, spokePoolClients);

    // TEST 5:
    // Won't submit anything if the USD threshold to propose a root is set and set too high:
    await dataworkerInstance.proposeRootBundle(spokePoolClients, toBNWei("1000000"));
    expect(lastSpyLogIncludes(spy, "Root bundle USD volume does not exceed threshold, exiting early")).to.be.true;

    // TEST 4: cont.
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    // Should have enqueued a new transaction:
    expect(lastSpyLogIncludes(spy, "Enqueing new root bundle proposal txn")).to.be.true;
    expect(spy.getCall(-1).lastArg.poolRebalanceRoot).to.equal(expectedPoolRebalanceRoot4.tree.getHexRoot());
    expect(spy.getCall(-1).lastArg.relayerRefundRoot).to.equal(expectedRelayerRefundRoot4.tree.getHexRoot());
    expect(spy.getCall(-1).lastArg.slowRelayRoot).to.equal(expectedSlowRelayRefundRoot4.tree.getHexRoot());

    // Execute queue and check that root bundle is pending:
    await multiCallerClient.executeTxnQueues();
    await updateAllClients();
    expect(hubPoolClient.hasPendingProposal()).to.equal(true);

    // Check that the cache is cleared.
    expect(dataworkerInstance.rootCache).to.not.deep.equal({});
    dataworkerInstance.clearCache();
    expect(dataworkerInstance.rootCache).to.deep.equal({});
  });
  it("Exits early if config store version is out of date", async function () {
    // Set up test so that the latest version in the config store contract is higher than
    // the version in the config store client.
    const update = await configStore.updateGlobalConfig(utf8ToHex("VERSION"), "1");
    const updateTime = (await configStore.provider.getBlock(update.blockNumber)).timestamp;
    configStoreClient.setConfigStoreVersion(0);

    // Now send a proposal after the update time. Dataworker should exit early.
    await spokePool_1.setCurrentTime(updateTime + 1);
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
    await fillV3Relay(spokePool_2, deposit, depositor, destinationChainId);
    await updateAllClients();
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    expect(multiCallerClient.transactionCount()).to.equal(0);
    expect(lastSpyLogIncludes(spy, "Skipping proposal because missing updated ConfigStore version")).to.be.true;
    expect(lastSpyLogLevel(spy)).to.equal("warn");
  });
});
