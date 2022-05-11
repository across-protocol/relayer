import { buildFillForRepaymentChain, lastSpyLogIncludes } from "./utils";
import { SignerWithAddress, expect, ethers, Contract, buildDeposit } from "./utils";
import { HubPoolClient, AcrossConfigStoreClient, SpokePoolClient, MultiCallerClient } from "../src/clients";
import { amountToDeposit, destinationChainId, originChainId } from "./constants";
import { MAX_REFUNDS_PER_RELAYER_REFUND_LEAF, MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF } from "./constants";
import { CHAIN_ID_TEST_LIST, DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import { MAX_UINT_VAL, EMPTY_MERKLE_ROOT } from "../src/utils";

// Tested
import { Dataworker } from "../src/dataworker/Dataworker";

let spy: sinon.SinonSpy;
let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, hubPool: Contract;
let depositor: SignerWithAddress;

let hubPoolClient: HubPoolClient, configStoreClient: AcrossConfigStoreClient;
let dataworkerInstance: Dataworker, multiCallerClient: MultiCallerClient;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let updateAllClients: () => Promise<void>;

describe("Dataworker: Validate pending root bundle", async function () {
  beforeEach(async function () {
    ({
      hubPool,
      spokePool_1,
      erc20_1,
      spokePool_2,
      erc20_2,
      configStoreClient,
      hubPoolClient,
      l1Token_1,
      depositor,
      dataworkerInstance,
      spokePoolClients,
      multiCallerClient,
      updateAllClients,
      spy,
    } = await setupDataworker(
      ethers,
      MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
      MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
      DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD
    ));
  });
  it("Simple lifecycle", async function () {
    await updateAllClients();

    const getMostRecentLog = (_spy: sinon.SinonSpy, message: string) => {
      return spy
        .getCalls()
        .sort((logA: any, logB: any) => logB.callId - logA.callId) // Sort by callId in descending order
        .find((log: any) => log.lastArg.message.includes(message)).lastArg;
    };

    // Send a deposit and a fill so that dataworker builds simple roots.
    const deposit = await buildDeposit(
      configStoreClient,
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
    const latestBlock2 = await hubPool.provider.getBlockNumber();
    const blockRange2 = CHAIN_ID_TEST_LIST.map((_) => [0, latestBlock2]);

    // Construct expected roots before we propose new root so that last log contains logs about submitted txn.
    const expectedPoolRebalanceRoot2 = dataworkerInstance.buildPoolRebalanceRoot(blockRange2, spokePoolClients);
    const expectedRelayerRefundRoot2 = dataworkerInstance.buildRelayerRefundRoot(blockRange2, spokePoolClients);
    const expectedSlowRelayRefundRoot2 = dataworkerInstance.buildSlowRelayRoot(blockRange2, spokePoolClients);
    await dataworkerInstance.proposeRootBundle();
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
    await multiCallerClient.executeTransactionQueue();

    // - Exit early if no pending bundle
    await dataworkerInstance.validateRootBundle();
    expect(lastSpyLogIncludes(spy, "No pending proposal, nothing to validate")).to.be.true;

    // - Exit early if pending bundle but challenge period has passed
    await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
    await updateAllClients();
    await dataworkerInstance.validateRootBundle();
    expect(lastSpyLogIncludes(spy, "Challenge period passed, cannot dispute")).to.be.true;

    // - Constructs same roots as proposed root bundle
    // - Execute or cancel previous bundle. Submit invalid one. Disputes invalid root bundle
  });
});
