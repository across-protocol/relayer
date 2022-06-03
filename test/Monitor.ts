import { buildDeposit, buildFillForRepaymentChain, createSpyLogger, lastSpyLogIncludes } from "./utils";
import { Contract, SignerWithAddress, ethers, expect } from "./utils";
import { AcrossConfigStoreClient, HubPoolClient, SpokePoolClient } from "../src/clients";
import { Monitor } from "../src/monitor/Monitor";
import { MonitorConfig } from "../src/monitor/MonitorConfig";
import { amountToDeposit, destinationChainId, mockTreeRoot } from "./constants";
import * as constants from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";

let l1Token: Contract, l2Token: Contract;
let hubPool: Contract, spokePool_1: Contract, spokePool_2: Contract;
let dataworker: SignerWithAddress, depositor: SignerWithAddress;
let configStoreClient: AcrossConfigStoreClient;
let hubPoolClient: HubPoolClient;
let monitorInstance: Monitor;
let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let updateAllClients: () => Promise<void>;

const { spy, spyLogger } = createSpyLogger();
const MONITOR_CONFIG = new MonitorConfig({
  STARTING_BLOCK_NUMBER: "0",
  ENDING_BLOCK_NUMBER: "100",
  UTILIZATION_ENABLED: "true",
  UNKNOWN_ROOT_BUNDLE_CALLERS_ENABLED: "true",
  UNKNOWN_RELAYER_CALLERS_ENABLED: "true",
  UTILIZATION_THRESHOLD: "0",
  WHITELISTED_DATA_WORKERS: "",
  WHITELISTED_RELAYERS: "",
});

describe("Monitor", async function () {
  beforeEach(async function () {
    ({
      configStoreClient,
      hubPool,
      dataworker,
      depositor,
      erc20_1: l2Token,
      l1Token_1: l1Token,
      spokePool_1,
      spokePool_2,
      spokePoolClient_1,
      spokePoolClient_2,
      updateAllClients,
    } = await setupDataworker(
      ethers,
      constants.MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
      constants.MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
      constants.DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD,
      0
    ));
    hubPoolClient = new HubPoolClient(spyLogger, hubPool);
    monitorInstance = new Monitor(spyLogger, MONITOR_CONFIG, {
      hubPoolClient,
      spokePoolClients: [spokePoolClient_1, spokePoolClient_2],
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
    await updateAllClients();
    await buildFillForRepaymentChain(spokePool_2, depositor, deposit, 0.5, constants.destinationChainId);
    await updateAllClients();

    await monitorInstance.update();
    await monitorInstance.checkUnknownRelayers();
    expect(lastSpyLogIncludes(spy, unknownRelayerMessage)).to.be.true;
  });
});
