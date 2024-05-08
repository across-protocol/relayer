import {
  BalanceAllocator,
  BundleDataClient,
  ConfigStoreClient,
  HubPoolClient,
  MultiCallerClient,
  SpokePoolClient,
  TokenTransferClient,
} from "../src/clients";
import { CrossChainTransferClient } from "../src/clients/bridges";
import { spokePoolClientsToProviders } from "../src/common";
import { Dataworker } from "../src/dataworker/Dataworker";
import { BalanceType, V3DepositWithBlock } from "../src/interfaces";
import { ALL_CHAINS_NAME, Monitor, REBALANCE_FINALIZE_GRACE_PERIOD } from "../src/monitor/Monitor";
import { MonitorConfig } from "../src/monitor/MonitorConfig";
import { MAX_UINT_VAL, getNetworkName, toBN } from "../src/utils";
import * as constants from "./constants";
import { amountToDeposit, destinationChainId, mockTreeRoot, originChainId, repaymentChainId } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import { MockAdapterManager, SimpleMockHubPoolClient } from "./mocks";
import {
  BigNumber,
  Contract,
  SignerWithAddress,
  createSpyLogger,
  depositV3,
  fillV3Relay,
  ethers,
  expect,
  lastSpyLogIncludes,
  toBNWei,
} from "./utils";

describe("Monitor", async function () {
  const TEST_NETWORK_NAMES = ["Hardhat1", "Hardhat2", "unknown", ALL_CHAINS_NAME];
  let l1Token: Contract, l2Token: Contract, erc20_2: Contract;
  let hubPool: Contract, spokePool_1: Contract, spokePool_2: Contract;
  let dataworker: SignerWithAddress, depositor: SignerWithAddress;
  let dataworkerInstance: Dataworker;
  let bundleDataClient: BundleDataClient;
  let configStoreClient: ConfigStoreClient;
  let hubPoolClient: HubPoolClient, multiCallerClient: MultiCallerClient;
  let tokenTransferClient: TokenTransferClient;
  let monitorInstance: Monitor;
  let spokePoolClients: { [chainId: number]: SpokePoolClient };
  let crossChainTransferClient: CrossChainTransferClient;
  let adapterManager: MockAdapterManager;
  let defaultMonitorEnvVars: Record<string, string>;
  let updateAllClients: () => Promise<void>;
  const { spy, spyLogger } = createSpyLogger();

  const executeBundle = async (hubPool: Contract) => {
    const latestBlock = await hubPool.provider.getBlockNumber();
    const blockRange = constants.CHAIN_ID_TEST_LIST.map(() => [0, latestBlock]);
    const expectedPoolRebalanceRoot = await dataworkerInstance.buildPoolRebalanceRoot(blockRange, spokePoolClients);
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    for (const leaf of expectedPoolRebalanceRoot.leaves) {
      await hubPool.executeRootBundle(
        leaf.chainId,
        leaf.groupIndex,
        leaf.bundleLpFees,
        leaf.netSendAmounts,
        leaf.runningBalances,
        leaf.leafId,
        leaf.l1Tokens,
        expectedPoolRebalanceRoot.tree.getHexProof(leaf)
      );
    }
  };

  const computeRelayerRefund = async (request: V3DepositWithBlock & { paymentChainId: number }): Promise<BigNumber> => {
    // @dev Monitor currently doesn't factor in LP fee into relayer refund calculation for simplicity and speed.
    return request.inputAmount;
  };

  beforeEach(async function () {
    let _hubPoolClient: HubPoolClient;
    let _updateAllClients: () => Promise<void>;
    ({
      configStoreClient,
      hubPool,
      dataworker,
      dataworkerInstance,
      depositor,
      erc20_1: l2Token,
      erc20_2,
      l1Token_1: l1Token,
      spokePool_1,
      spokePool_2,
      hubPoolClient: _hubPoolClient,
      spokePoolClients,
      multiCallerClient,
      updateAllClients: _updateAllClients,
    } = await setupDataworker(
      ethers,
      constants.MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
      constants.MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
      0
    ));

    // Use a mock hub pool client for these tests so we can hardcode the L1TokenInfo for arbitrary tokens.
    hubPoolClient = new SimpleMockHubPoolClient(
      spyLogger,
      hubPool,
      configStoreClient,
      _hubPoolClient.deploymentBlock,
      _hubPoolClient.chainId
    );
    updateAllClients = async () => {
      await _updateAllClients();
      await hubPoolClient.update();
    };

    [l2Token.address, erc20_2.address, l1Token.address].forEach((token) =>
      (hubPoolClient as SimpleMockHubPoolClient).mapTokenInfo(token, "L1Token1")
    );

    defaultMonitorEnvVars = {
      STARTING_BLOCK_NUMBER: "0",
      ENDING_BLOCK_NUMBER: "100",
      UTILIZATION_ENABLED: "true",
      UNKNOWN_ROOT_BUNDLE_CALLERS_ENABLED: "true",
      UNKNOWN_RELAYER_CALLERS_ENABLED: "true",
      UTILIZATION_THRESHOLD: "0",
      WHITELISTED_DATA_WORKERS: "",
      WHITELISTED_RELAYERS: "",
      MONITOR_REPORT_ENABLED: "true",
      MONITOR_REPORT_INTERVAL: "10",
      MONITORED_RELAYERS: `["${depositor.address}"]`,
    };
    const monitorConfig = new MonitorConfig(defaultMonitorEnvVars);

    // @dev: Force maxRelayerLookBack to undefined to skip lookback block resolution.
    // This overrules the readonly property for MonitorConfig.maxRelayerLookBack (...bodge!!).
    // @todo: Relocate getUnfilledDeposits() into a class to permit it to be overridden in test.
    (monitorConfig as unknown)["maxRelayerLookBack"] = undefined;

    // Set the config store version to 0 to match the default version in the ConfigStoreClient.
    process.env.CONFIG_STORE_VERSION = "0";

    const chainIds = [hubPoolClient.chainId, repaymentChainId, originChainId, destinationChainId];
    bundleDataClient = new BundleDataClient(
      spyLogger,
      { configStoreClient, multiCallerClient, hubPoolClient },
      spokePoolClients,
      chainIds
    );

    const providers = Object.fromEntries(
      Object.entries(spokePoolClients).map(([chainId, client]) => [chainId, client.spokePool.provider])
    );
    tokenTransferClient = new TokenTransferClient(spyLogger, providers, [depositor.address]);

    adapterManager = new MockAdapterManager(null, null, null, null);
    adapterManager.setSupportedChains(chainIds);
    crossChainTransferClient = new CrossChainTransferClient(spyLogger, chainIds, adapterManager);
    monitorInstance = new Monitor(spyLogger, monitorConfig, {
      bundleDataClient,
      configStoreClient,
      multiCallerClient,
      hubPoolClient,
      spokePoolClients,
      tokenTransferClient,
      crossChainTransferClient,
    });

    await updateAllClients();
  });

  it("Monitor should log when an unknown disputer proposes or disputes a root bundle", async function () {
    await monitorInstance.update();
    await monitorInstance.checkUnknownRootBundleCallers();
    const unknownProposerMessage = "Unknown bundle caller (proposed) 🥸";
    const unknownDisputerMessage = "Unknown bundle caller (disputed) 🧨";
    expect(lastSpyLogIncludes(spy, unknownProposerMessage)).to.be.false;
    expect(lastSpyLogIncludes(spy, unknownDisputerMessage)).to.be.false;

    const bundleBlockEvalNumbers = [11];
    await hubPool
      .connect(dataworker)
      .proposeRootBundle(bundleBlockEvalNumbers, 1, mockTreeRoot, mockTreeRoot, mockTreeRoot);
    await updateAllClients();
    await monitorInstance.update();

    await monitorInstance.checkUnknownRootBundleCallers();
    expect(lastSpyLogIncludes(spy, unknownProposerMessage)).to.be.true;

    await hubPool.connect(dataworker).disputeRootBundle();
    await updateAllClients();
    await monitorInstance.update();
    await monitorInstance.checkUnknownRootBundleCallers();

    expect(lastSpyLogIncludes(spy, unknownDisputerMessage)).to.be.true;
  });

  it("Monitor should report balances", async function () {
    await monitorInstance.update();
    const reports = monitorInstance.initializeBalanceReports(
      monitorInstance.monitorConfig.monitoredRelayers,
      monitorInstance.clients.hubPoolClient.getL1Tokens(),
      TEST_NETWORK_NAMES
    );
    await monitorInstance.updateCurrentRelayerBalances(reports);

    expect(reports[depositor.address]["L1Token1"][ALL_CHAINS_NAME][BalanceType.CURRENT].toString()).to.be.equal(
      "60000000000000000000000"
    );
  });

  it("Monitor should get relayer refunds", async function () {
    await updateAllClients();
    await monitorInstance.update();
    // Send a deposit and a fill so that dataworker builds simple roots.
    const inputAmount = amountToDeposit;
    const outputAmount = inputAmount.mul(99).div(100);
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      l2Token.address,
      inputAmount,
      l1Token.address,
      outputAmount
    );
    const fill = await fillV3Relay(spokePool_2, deposit, depositor);
    await monitorInstance.update();

    // Have the data worker propose a new bundle.
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    await l1Token.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTransactionQueue();

    // While the new bundle is still pending, refunds are in the "next" category
    await updateAllClients();
    await monitorInstance.update();
    let reports = monitorInstance.initializeBalanceReports(
      monitorInstance.monitorConfig.monitoredRelayers,
      monitorInstance.clients.hubPoolClient.getL1Tokens(),
      TEST_NETWORK_NAMES
    );
    await monitorInstance.updateLatestAndFutureRelayerRefunds(reports);
    expect(reports[depositor.address]["L1Token1"][ALL_CHAINS_NAME][BalanceType.PENDING]).to.be.equal(toBN(0));

    const relayerRefund = await computeRelayerRefund({ ...deposit, paymentChainId: fill.repaymentChainId });
    expect(reports[depositor.address]["L1Token1"][ALL_CHAINS_NAME][BalanceType.NEXT]).to.be.equal(relayerRefund);

    // Execute pool rebalance leaves.
    await executeBundle(hubPool);

    // Before relayer refund leaves are executed, the refund is now in the pending column
    await updateAllClients();
    await monitorInstance.update();
    reports = monitorInstance.initializeBalanceReports(
      monitorInstance.monitorConfig.monitoredRelayers,
      monitorInstance.clients.hubPoolClient.getL1Tokens(),
      TEST_NETWORK_NAMES
    );
    await monitorInstance.updateLatestAndFutureRelayerRefunds(reports);
    expect(reports[depositor.address]["L1Token1"][ALL_CHAINS_NAME][BalanceType.NEXT]).to.be.equal(toBN(0));
    expect(reports[depositor.address]["L1Token1"][ALL_CHAINS_NAME][BalanceType.PENDING]).to.be.equal(relayerRefund);

    // Manually relay the roots to spoke pools since adapter is a dummy and won't actually relay messages.
    const validatedRootBundles = hubPoolClient.getValidatedRootBundles();
    for (const rootBundle of validatedRootBundles) {
      await spokePool_1.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
      await spokePool_2.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
    }
    await updateAllClients();

    // Execute relayer refund leaves. Send funds to spoke pools to execute the leaves.
    await erc20_2.mint(spokePool_2.address, relayerRefund);
    const providers = {
      ...spokePoolClientsToProviders(spokePoolClients),
      [(await hubPool.provider.getNetwork()).chainId]: hubPool.provider,
    };
    await monitorInstance.update();
    await dataworkerInstance.executeRelayerRefundLeaves(spokePoolClients, new BalanceAllocator(providers));
    await multiCallerClient.executeTransactionQueue();

    // Now, pending refunds should be 0.
    await monitorInstance.update();
    reports = monitorInstance.initializeBalanceReports(
      monitorInstance.monitorConfig.monitoredRelayers,
      monitorInstance.clients.hubPoolClient.getL1Tokens(),
      TEST_NETWORK_NAMES
    );
    await monitorInstance.updateLatestAndFutureRelayerRefunds(reports);
    expect(reports[depositor.address]["L1Token1"][ALL_CHAINS_NAME][BalanceType.NEXT]).to.be.equal(toBN(0));
    expect(reports[depositor.address]["L1Token1"][ALL_CHAINS_NAME][BalanceType.PENDING]).to.be.equal(toBN(0));

    // Simulate some pending cross chain transfers.
    crossChainTransferClient.increaseOutstandingTransfer(
      depositor.address,
      l1Token.address,
      toBN(5),
      destinationChainId
    );
    await monitorInstance.updateLatestAndFutureRelayerRefunds(reports);
    expect(
      reports[depositor.address]["L1Token1"][getNetworkName(destinationChainId)][BalanceType.PENDING_TRANSFERS]
    ).to.be.equal(toBN(5));
  });

  it("Monitor should report stuck rebalances", async function () {
    await updateAllClients();
    await monitorInstance.update();
    // Send a deposit and a fill so that dataworker builds simple roots.
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      l2Token.address,
      amountToDeposit,
      l1Token.address,
      amountToDeposit.mul(99).div(100)
    );
    await fillV3Relay(spokePool_2, deposit, depositor);
    await monitorInstance.update();

    // Have the data worker propose a new bundle.
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    await l1Token.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTransactionQueue();

    // Execute pool rebalance leaves.
    await executeBundle(hubPool);

    // Fast-forward by 2 hours to pass the grace period.
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + REBALANCE_FINALIZE_GRACE_PERIOD + 1);

    // Simulate some pending cross chain transfers to SpokePools.
    adapterManager.setMockedOutstandingCrossChainTransfers(
      originChainId,
      spokePool_1.address,
      l1Token.address,
      toBN(5)
    );
    await updateAllClients();
    await monitorInstance.update();
    await monitorInstance.checkStuckRebalances();

    expect(lastSpyLogIncludes(spy, "HubPool -> SpokePool rebalances stuck 🦴")).to.be.true;
    const log = spy.lastCall;
    expect(log.lastArg.mrkdwn).to.contains(
      `Rebalances of ${await l1Token.symbol()} to ${getNetworkName(originChainId)} is stuck`
    );
  });

  it("Monitor should report unfilled deposits", async function () {
    await updateAllClients();
    await monitorInstance.update();
    const inputToken = l2Token.address;
    const outputToken = erc20_2.address;
    await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      amountToDeposit,
      outputToken,
      amountToDeposit
    );

    await monitorInstance.update();
    await monitorInstance.reportUnfilledDeposits();

    expect(lastSpyLogIncludes(spy, "Unfilled deposits ⏱")).to.be.true;
    const log = spy.lastCall;
    expect(log.lastArg.mrkdwn).to.contains("100.00");
  });

  it("Monitor should send token refills", async function () {
    const refillConfig = [
      {
        account: hubPool.address,
        isHubPool: true,
        chainId: hubPoolClient.chainId,
        trigger: 1,
        target: 2,
      },
      {
        account: spokePool_1.address,
        isHubPool: false,
        chainId: originChainId,
        trigger: 1,
        target: 2,
      },
    ];
    const monitorEnvs = {
      ...defaultMonitorEnvVars,
      REFILL_BALANCES: JSON.stringify(refillConfig),
    };
    const _monitorConfig = new MonitorConfig(monitorEnvs);
    const _monitor = new Monitor(spyLogger, _monitorConfig, {
      bundleDataClient,
      configStoreClient,
      multiCallerClient,
      hubPoolClient,
      spokePoolClients,
      tokenTransferClient,
      crossChainTransferClient,
    });
    await _monitor.update();

    expect(await spokePool_1.provider.getBalance(spokePool_1.address)).to.equal(0);

    await _monitor.refillBalances();

    expect(multiCallerClient.transactionCount()).to.equal(1);
    await multiCallerClient.executeTransactionQueue();

    expect(await spokePool_1.provider.getBalance(spokePool_1.address)).to.equal(toBNWei("2"));
  });
});
