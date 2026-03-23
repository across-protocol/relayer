import { BundleDataClient, ConfigStoreClient, HubPoolClient, MultiCallerClient, SpokePoolClient } from "../src/clients";
import { CrossChainTransferClient } from "../src/clients/bridges";
import { Dataworker } from "../src/dataworker/Dataworker";
import { Monitor, REBALANCE_FINALIZE_GRACE_PERIOD } from "../src/monitor/Monitor";
import { MonitorConfig } from "../src/monitor/MonitorConfig";
import { TokenInfo } from "../src/interfaces";
import { MAX_UINT_VAL, toBN, toAddressType, EvmAddress, Address, getTokenInfo } from "../src/utils";

// Mock Monitor that falls back to hubPoolClient.getTokenInfoForAddress for test tokens
// not found in TOKEN_SYMBOLS_MAP.
class MockMonitor extends Monitor {
  protected getTokenInfo(token: Address, chainId: number): TokenInfo {
    try {
      return getTokenInfo(token, chainId);
    } catch {
      return this.clients.hubPoolClient.getTokenInfoForAddress(token, chainId);
    }
  }
}
import * as constants from "./constants";
import { amountToDeposit, destinationChainId, mockTreeRoot, originChainId, repaymentChainId } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import { MockAdapterManager, SimpleMockHubPoolClient } from "./mocks";
import {
  Contract,
  SignerWithAddress,
  createSpyLogger,
  depositV3,
  fillV3Relay,
  ethers,
  expect,
  lastSpyLogIncludes,
  deployMulticall3,
} from "./utils";

describe("Monitor", async function () {
  let l1Token: Contract, l2Token: Contract, erc20_2: Contract;
  let hubPool: Contract, spokePool_1: Contract, spokePool_2: Contract;
  let dataworker: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
  let dataworkerInstance: Dataworker;
  let bundleDataClient: BundleDataClient;
  let configStoreClient: ConfigStoreClient;
  let hubPoolClient: HubPoolClient, multiCallerClient: MultiCallerClient;
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
        leaf.l1Tokens.map((l1Token) => l1Token.toEvmAddress()),
        expectedPoolRebalanceRoot.tree.getHexProof(leaf)
      );
    }
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
      relayer,
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

    // Deploy Multicall3 to the hardhat test networks.
    for (const deployer of [depositor, relayer]) {
      await deployMulticall3(deployer);
    }

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
      (hubPoolClient as SimpleMockHubPoolClient).mapTokenInfo(EvmAddress.from(token), "L1Token1")
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
      MONITORED_RELAYERS: `["${relayer.address}"]`,
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

    adapterManager = new MockAdapterManager(null, null, null, null);
    adapterManager.setSupportedChains(chainIds);
    crossChainTransferClient = new CrossChainTransferClient(spyLogger, chainIds, adapterManager);
    monitorInstance = new MockMonitor(spyLogger, monitorConfig, {
      bundleDataClient,
      configStoreClient,
      multiCallerClient,
      hubPoolClient,
      spokePoolClients,
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
    await fillV3Relay(spokePool_2, deposit, relayer);
    await monitorInstance.update();

    // Have the data worker propose a new bundle.
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    await l1Token.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTxnQueues();

    // Execute pool rebalance leaves.
    await executeBundle(hubPool);

    // Fast-forward by 2 hours to pass the grace period.
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + REBALANCE_FINALIZE_GRACE_PERIOD + 1);

    // Simulate some pending cross chain transfers to SpokePools.
    adapterManager.setMockedOutstandingCrossChainTransfers(
      originChainId,
      toAddressType(spokePool_1.address, originChainId),
      toAddressType(l1Token.address, hubPoolClient.chainId),
      toBN(5),
      toAddressType(l2Token.address, originChainId)
    );
    await updateAllClients();
    await monitorInstance.update();
    await monitorInstance.checkStuckRebalances();

    // console.log(spy.getCalls());
    const stuckTransfer = spy.getCalls().find((call) => call.lastArg.message.includes("rebalances stuck"));
    const stuckRootRelay = spy.getCalls().find((call) => call.lastArg.message.includes("root bundle relay stuck"));
    expect(stuckTransfer).to.not.be.undefined;
    expect(stuckRootRelay).to.not.be.undefined;
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
});
