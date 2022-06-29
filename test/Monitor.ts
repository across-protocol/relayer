import { buildDeposit, buildFillForRepaymentChain, createSpyLogger, lastSpyLogIncludes } from "./utils";
import { Contract, SignerWithAddress, ethers, expect } from "./utils";
import {
  AcrossConfigStoreClient,
  BundleDataClient,
  HubPoolClient,
  SpokePoolClient,
  MultiCallerClient,
  ProfitClient,
  TokenTransferClient,
  BalanceAllocator,
  CrossChainTransferClient,
  AdapterManager,
} from "../src/clients";
import { Monitor, ALL_CHAINS_NAME, UNKNOWN_TRANSFERS_NAME } from "../src/monitor/Monitor";
import { MonitorConfig } from "../src/monitor/MonitorConfig";
import { amountToDeposit, destinationChainId, mockTreeRoot, originChainId, repaymentChainId } from "./constants";
import * as constants from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import { Dataworker } from "../src/dataworker/Dataworker";
import { getNetworkName, getRefundForFills, MAX_UINT_VAL, toBN } from "../src/utils";
import { spokePoolClientsToProviders } from "../src/dataworker/DataworkerClientHelper";
import { MockAdapterManager } from "./mocks";
import { BalanceType } from "../src/interfaces";

let l1Token: Contract, l2Token: Contract, erc20_2: Contract;
let hubPool: Contract, spokePool_1: Contract, spokePool_2: Contract;
let dataworker: SignerWithAddress, depositor: SignerWithAddress;
let dataworkerInstance: Dataworker;
let bundleDataClient: BundleDataClient;
let configStoreClient: AcrossConfigStoreClient;
let hubPoolClient: HubPoolClient, multiCallerClient: MultiCallerClient, profitClient: ProfitClient;
let tokenTransferClient: TokenTransferClient;
let monitorInstance: Monitor;
let spokePoolClients: { [chainId: number]: SpokePoolClient };
let crossChainTransferClient: CrossChainTransferClient;
let adapterManager: MockAdapterManager;
let updateAllClients: () => Promise<void>;

const { spy, spyLogger } = createSpyLogger();

const TEST_NETWORK_NAMES = ["Hardhat1", "Hardhat2", "Unknown", ALL_CHAINS_NAME];

describe("Monitor", async function () {
  beforeEach(async function () {
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
      hubPoolClient,
      spokePoolClients,
      profitClient,
      multiCallerClient,
      updateAllClients,
    } = await setupDataworker(
      ethers,
      constants.MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
      constants.MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
      constants.DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD,
      0
    ));

    const monitorConfig = new MonitorConfig({
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
      CONFIGURED_NETWORKS: `[1, ${repaymentChainId}, ${originChainId}, ${destinationChainId}]`,
    });

    const chainIds = [1, repaymentChainId, originChainId, destinationChainId];
    bundleDataClient = new BundleDataClient(
      spyLogger,
      {
        configStoreClient,
        multiCallerClient,
        profitClient,
        hubPoolClient,
      },
      spokePoolClients,
      chainIds
    );

    const providers = Object.fromEntries(
      Object.entries(spokePoolClients).map(([chainId, client]) => [chainId, client.spokePool.provider])
    );
    tokenTransferClient = new TokenTransferClient(spyLogger, providers, [depositor.address]);

    adapterManager = new MockAdapterManager(null, null, null, null);
    crossChainTransferClient = new CrossChainTransferClient(spyLogger, chainIds, adapterManager);
    monitorInstance = new Monitor(spyLogger, monitorConfig, {
      bundleDataClient,
      configStoreClient,
      multiCallerClient,
      profitClient,
      hubPoolClient,
      spokePoolClients,
      tokenTransferClient,
      crossChainTransferClient,
    });
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
    await monitorInstance.update();

    await monitorInstance.checkUnknownRootBundleCallers();
    expect(lastSpyLogIncludes(spy, unknownProposerMessage)).to.be.true;

    await hubPool.connect(dataworker).disputeRootBundle();
    await monitorInstance.update();
    await monitorInstance.checkUnknownRootBundleCallers();

    expect(lastSpyLogIncludes(spy, unknownDisputerMessage)).to.be.true;
  });

  it("Monitor should log unknown relayers", async function () {
    await updateAllClients();
    await monitorInstance.update();
    await monitorInstance.checkUnknownRelayers();
    const unknownRelayerMessage = "Unknown relayer 🛺";
    expect(lastSpyLogIncludes(spy, unknownRelayerMessage)).to.be.false;

    // Send a deposit and a fill so that dataworker builds simple roots.
    const deposit = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_1,
      l2Token,
      l1Token,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    await buildFillForRepaymentChain(spokePool_2, depositor, deposit, 0.5, constants.destinationChainId);

    await monitorInstance.update();
    await monitorInstance.checkUnknownRelayers();
    expect(lastSpyLogIncludes(spy, unknownRelayerMessage)).to.be.true;
  });

  it("Monitor should report balances", async function () {
    await monitorInstance.update();
    const reports = monitorInstance.initializeBalanceReports(
      monitorInstance.monitorConfig.monitoredRelayers,
      monitorInstance.clients.hubPoolClient.getL1Tokens(),
      TEST_NETWORK_NAMES
    );
    await monitorInstance.updateCurrentRelayerBalances(reports);

    expect(reports[depositor.address]["L1"][ALL_CHAINS_NAME][BalanceType.CURRENT].toString()).to.be.equal(
      "60000000000000000000000"
    );
  });

  it("Monitor should get relayer refunds", async function () {
    await updateAllClients();
    await monitorInstance.update();
    // Send a deposit and a fill so that dataworker builds simple roots.
    const deposit = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_1,
      l2Token,
      l1Token,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const fill1 = await buildFillForRepaymentChain(spokePool_2, depositor, deposit, 0.5, destinationChainId);
    await monitorInstance.update();

    // Have the data worker propose a new bundle.
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    await l1Token.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTransactionQueue();

    // While the new bundle is still pending, refunds are in the "next" category
    await monitorInstance.update();
    let reports = monitorInstance.initializeBalanceReports(
      monitorInstance.monitorConfig.monitoredRelayers,
      monitorInstance.clients.hubPoolClient.getL1Tokens(),
      TEST_NETWORK_NAMES
    );
    monitorInstance.updateLatestAndFutureRelayerRefunds(reports);
    expect(reports[depositor.address]["L1"][ALL_CHAINS_NAME][BalanceType.PENDING]).to.be.equal(toBN(0));
    expect(reports[depositor.address]["L1"][ALL_CHAINS_NAME][BalanceType.NEXT]).to.be.equal(getRefundForFills([fill1]));

    // Execute pool rebalance leaves.
    const latestBlock = await hubPool.provider.getBlockNumber();
    const blockRange = constants.CHAIN_ID_TEST_LIST.map((_) => [0, latestBlock]);
    const expectedPoolRebalanceRoot = dataworkerInstance.buildPoolRebalanceRoot(blockRange, spokePoolClients);
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

    // Before relayer refund leaves are executed, the refund is now in the pending column
    await monitorInstance.update();
    reports = monitorInstance.initializeBalanceReports(
      monitorInstance.monitorConfig.monitoredRelayers,
      monitorInstance.clients.hubPoolClient.getL1Tokens(),
      TEST_NETWORK_NAMES
    );
    monitorInstance.updateLatestAndFutureRelayerRefunds(reports);
    expect(reports[depositor.address]["L1"][ALL_CHAINS_NAME][BalanceType.NEXT]).to.be.equal(toBN(0));
    expect(reports[depositor.address]["L1"][ALL_CHAINS_NAME][BalanceType.PENDING]).to.be.equal(
      getRefundForFills([fill1])
    );

    // Execute relayer refund leaves. Send funds to spoke pools to execute the leaves.
    await erc20_2.mint(spokePool_2.address, getRefundForFills([fill1]));
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
    monitorInstance.updateLatestAndFutureRelayerRefunds(reports);
    expect(reports[depositor.address]["L1"][ALL_CHAINS_NAME][BalanceType.NEXT]).to.be.equal(toBN(0));
    expect(reports[depositor.address]["L1"][ALL_CHAINS_NAME][BalanceType.PENDING]).to.be.equal(toBN(0));

    // Simulate some pending cross chain transfers.
    crossChainTransferClient.increaseOutstandingTransfer(l1Token.address, toBN(5), destinationChainId);
    monitorInstance.updateLatestAndFutureRelayerRefunds(reports);
    expect(
      reports[depositor.address]["L1"][getNetworkName(destinationChainId)][BalanceType.PENDING_TRANSFERS]
    ).to.be.equal(toBN(5));
  });

  it("Monitor should report unfilled deposits", async function () {
    await updateAllClients();
    await monitorInstance.update();
    await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_1,
      l2Token,
      l1Token,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    await monitorInstance.update();
    await monitorInstance.reportUnfilledDeposits();

    expect(lastSpyLogIncludes(spy, "Unfilled deposits ⏱")).to.be.true;
    const log = spy.lastCall;
    expect(log.lastArg.mrkdwn).to.contains("100.00");
  });

  it("Monitor should report unknown transfers", async function () {
    await l2Token.connect(depositor).transfer(dataworker.address, 1);

    await monitorInstance.update();
    const reports = monitorInstance.initializeBalanceReports(
      monitorInstance.monitorConfig.monitoredRelayers,
      monitorInstance.clients.hubPoolClient.getL1Tokens(),
      [UNKNOWN_TRANSFERS_NAME]
    );
    await monitorInstance.updateUnknownTransfers(reports);

    expect(lastSpyLogIncludes(spy, `Transfers that are not fills for relayer ${depositor.address} 🦨`)).to.be.true;
  });
});
