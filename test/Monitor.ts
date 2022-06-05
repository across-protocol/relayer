import { buildDeposit, buildFillForRepaymentChain, createSpyLogger, lastSpyLogIncludes } from "./utils";
import { Contract, SignerWithAddress, ethers, expect, expectLogsToContain } from "./utils";
import {
  AcrossConfigStoreClient,
  HubPoolClient,
  SpokePoolClient,
  MultiCallerClient,
  ProfitClient,
} from "../src/clients";
import { Monitor } from "../src/monitor/Monitor";
import { MonitorConfig } from "../src/monitor/MonitorConfig";
import { amountToDeposit, destinationChainId, mockTreeRoot, originChainId, repaymentChainId } from "./constants";
import * as constants from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import { Dataworker } from "../src/dataworker/Dataworker";
import { MAX_UINT_VAL } from "../src/utils";

let l1Token: Contract, l2Token: Contract;
let hubPool: Contract, spokePool_1: Contract, spokePool_2: Contract;
let dataworker: SignerWithAddress, depositor: SignerWithAddress;
let dataworkerInstance: Dataworker;
let configStoreClient: AcrossConfigStoreClient;
let hubPoolClient: HubPoolClient, multiCallerClient: MultiCallerClient, profitClient: ProfitClient;
let monitorInstance: Monitor;
let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let spokePoolClient_3: SpokePoolClient, spokePoolClient_4: SpokePoolClient;
let spokePoolClients: { [chainId: number]: SpokePoolClient };
let updateAllClients: () => Promise<void>;

const { spy, spyLogger } = createSpyLogger();

describe("Monitor", async function () {
  beforeEach(async function () {
    ({
      configStoreClient,
      hubPool,
      dataworker,
      dataworkerInstance,
      depositor,
      erc20_1: l2Token,
      l1Token_1: l1Token,
      spokePool_1,
      spokePool_2,
      spokePoolClient_1,
      spokePoolClient_2,
      spokePoolClient_3,
      spokePoolClient_4,
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
    hubPoolClient = new HubPoolClient(spyLogger, hubPool);

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
    spokePoolClients = {
      [originChainId]: spokePoolClient_1,
      [destinationChainId]: spokePoolClient_2,
      [repaymentChainId]: spokePoolClient_3,
      1: spokePoolClient_4,
    };

    monitorInstance = new Monitor(spyLogger, monitorConfig, {
      configStoreClient,
      multiCallerClient,
      profitClient,
      hubPoolClient,
      spokePoolClients,
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
    await monitorInstance.reportRelayerBalances();

    expect(lastSpyLogIncludes(spy, `Relayer (${depositor.address})'s token balances for chain 1337 🚀`)).to.be.true;
    expect(spy.lastCall.lastArg.mrkdwn).to.contains("30,000.00");
  });

  it("Monitor should report pending relayer refund", async function () {
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
    await buildFillForRepaymentChain(spokePool_2, depositor, deposit, 0.5, destinationChainId);
    await monitorInstance.update();

    // Have the data worker propose a new bundle.
    await dataworkerInstance.proposeRootBundle(spokePoolClients);
    await l1Token.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTransactionQueue();

    // While the new bundle is still pending, report.
    await monitorInstance.update();
    await monitorInstance.reportPendingRelayerRefunds();

    expectLogsToContain(spy, `Relayer (${depositor.address})'s refunds included in current pending bundle 👑`);
    expectLogsToContain(spy, `No refunds for relayer (${depositor.address}) in next bundle yet 🪄`);
  });
});
