import { createSpyLogger, lastSpyLogIncludes } from "./utils";
import { SignerWithAddress, expect, ethers, Contract, toBNWei, toBN, BigNumber, hre } from "./utils";
import { HubPoolClient } from "../src/clients";
import { Monitor } from "../src/monitor/Monitor";
import { MonitorConfig } from "../src/monitor/MonitorConfig";
import * as constants from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";

let hubPool: Contract;
let dataworker: SignerWithAddress;
let hubPoolClient: HubPoolClient;
let monitorInstance: Monitor;

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
    ({ hubPool, dataworker } = await setupDataworker(
      ethers,
      constants.MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
      constants.MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
      constants.DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD,
      0
    ));
    hubPoolClient = new HubPoolClient(spyLogger, hubPool);
    monitorInstance = new Monitor(spyLogger, MONITOR_CONFIG, {
      hubPoolClient,
      spokePools: [],
    });
  });

  it("Monitor should log when an unknown disputer proposes or disputes a root bundle", async function () {
    await monitorInstance.update();
    await monitorInstance.checkUnknownRootBundleCallers();
    const unknownProposerMessage = "Unknown bundle caller (proposed) 🥷";
    const unknownDisputerMessage = "Unknown bundle caller (disputed) 🥷";
    expect(lastSpyLogIncludes(spy, unknownProposerMessage)).to.be.false;
    expect(lastSpyLogIncludes(spy, unknownDisputerMessage)).to.be.false;

    const bundleBlockEvalNumbers = [11];
    await hubPool
      .connect(dataworker)
      .proposeRootBundle(
        bundleBlockEvalNumbers,
        1,
        constants.mockTreeRoot,
        constants.mockTreeRoot,
        constants.mockTreeRoot
      );
    await monitorInstance.update();

    await monitorInstance.checkUnknownRootBundleCallers();
    expect(lastSpyLogIncludes(spy, unknownProposerMessage)).to.be.true;

    await hubPool.connect(dataworker).disputeRootBundle();
    await monitorInstance.update();
    await monitorInstance.checkUnknownRootBundleCallers();

    expect(lastSpyLogIncludes(spy, unknownDisputerMessage)).to.be.true;
  });
});
