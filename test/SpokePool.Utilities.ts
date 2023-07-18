import { random } from "lodash";
import { clients, utils as sdkUtils } from "@across-protocol/sdk-v2";
import { DepositWithBlock, FillWithBlock, RefundRequestWithBlock } from "../src/interfaces";
import { ZERO_ADDRESS } from "../src/utils";
import { DEFAULT_CONFIG_STORE_VERSION, MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient } from "./mocks";
import {
  createSpyLogger,
  deployConfigStore,
  deploySpokePool,
  expect,
  ethers,
  fillFromDeposit,
  refundRequestFromFill,
  hubPoolFixture,
  SignerWithAddress,
  randomAddress,
} from "./utils";

type EventSearchConfig = sdkUtils.EventSearchConfig;

const { getFills, getRefundRequests } = clients;

let owner: SignerWithAddress;
let chainIds: number[];
let originChainId: number, destinationChainId: number, repaymentChainId: number;
let hubPoolClient: MockHubPoolClient;
let spokePoolClients: { [chainId: number]: MockSpokePoolClient };
let originSpokePoolClient: MockSpokePoolClient;
let destinationSpokePoolClient: MockSpokePoolClient;
let repaymentSpokePoolClient: MockSpokePoolClient;

const logger = createSpyLogger().spyLogger;

const generateValidRefundRequest = async (
  origin: MockSpokePoolClient,
  destination: MockSpokePoolClient,
  repayment: MockSpokePoolClient = destination
): Promise<{ deposit: DepositWithBlock; fill: FillWithBlock; refundRequest?: RefundRequestWithBlock }> => {
  let event = origin.generateDeposit({
    originChainId: origin.chainId,
    destinationChainId: destination.chainId,
    destinationToken: ZERO_ADDRESS,
  } as DepositWithBlock);
  origin.addEvent(event);
  await origin.update();

  // Pull the DepositWithBlock event out of the origin SpokePoolClient to use as a Fill template.
  const _deposit = origin.getDeposits().find(({ transactionHash }) => transactionHash === event.transactionHash);
  expect(_deposit).to.not.be.undefined;
  const deposit = _deposit as DepositWithBlock;

  const fillTemplate = fillFromDeposit(deposit, randomAddress());
  fillTemplate.repaymentChainId = (repayment ?? destination).chainId;
  event = destination.generateFill(fillTemplate as FillWithBlock);
  destination.addEvent(event);
  await destination.update();

  // Pull the FillWithBlock event out of the destination SpokePoolClient.
  const _fill = destination.getFills().find(({ transactionHash }) => transactionHash === event.transactionHash);
  expect(_fill).to.not.be.undefined;
  const fill = _fill as FillWithBlock;

  // If a repayment SpokePoolClient was supplied, generate the RefundRequest event from the previous fill.
  let refundRequest: RefundRequestWithBlock | undefined = undefined;
  if (repayment !== destination) {
    const refundRequestTemplate = refundRequestFromFill(fill, fill.destinationToken);
    event = repayment.generateRefundRequest(refundRequestTemplate as RefundRequestWithBlock);
    repayment.addEvent(event);
    await repayment.update();

    // Pull the DepositWithBlock event out of the origin SpokePoolClient to use as a Fill template.
    refundRequest = repayment
      .getRefundRequests()
      .find(({ transactionHash }) => transactionHash === event.transactionHash);
    expect(refundRequest).to.not.be.undefined;
  }

  return { deposit: deposit as DepositWithBlock, fill: fill as FillWithBlock, refundRequest: refundRequest };
};

describe("SpokePoolClient: Event Filtering", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    destinationChainId = (await owner.provider.getNetwork()).chainId as number;

    originChainId = random(100_000, 1_000_000, false);
    repaymentChainId = random(1_000_001, 2_000_000, false);
    chainIds = [originChainId, destinationChainId, repaymentChainId];

    spokePoolClients = {};

    const mockUpdate = true;
    const { configStore } = await deployConfigStore(owner, []);
    const configStoreClient = new MockConfigStoreClient(
      logger,
      configStore,
      {} as EventSearchConfig,
      DEFAULT_CONFIG_STORE_VERSION,
      chainIds,
      mockUpdate
    );
    await configStoreClient.update();

    const { hubPool } = await hubPoolFixture();
    const deploymentBlock = await hubPool.provider.getBlockNumber();
    hubPoolClient = new MockHubPoolClient(logger, hubPool, configStoreClient, deploymentBlock, originChainId);

    for (const chainId of chainIds) {
      // @dev the underlying chainId will be the same for all three SpokePools.
      const { spokePool } = await deploySpokePool(ethers);
      const receipt = await spokePool.deployTransaction.wait();
      await spokePool.setChainId(chainId);
      const spokePoolClient = new MockSpokePoolClient(logger, spokePool, chainId, receipt.blockNumber);
      spokePoolClients[chainId] = spokePoolClient;

      for (const destinationChainId of chainIds) {
        // For each SpokePool, construct routes to each _other_ SpokePool.
        if (destinationChainId === chainId) {
          continue;
        }

        // @todo: destinationToken
        [ZERO_ADDRESS].forEach((originToken) => {
          let event = spokePoolClient.generateDepositRoute(originToken, destinationChainId, true);
          spokePoolClient.addEvent(event);
          event = hubPoolClient.setPoolRebalanceRoute(destinationChainId, originToken, originToken);
          hubPoolClient.addEvent(event);
        });
      }
    }
    await hubPoolClient.update();

    originSpokePoolClient = spokePoolClients[originChainId];
    destinationSpokePoolClient = spokePoolClients[destinationChainId];
    repaymentSpokePoolClient = spokePoolClients[repaymentChainId];
  });

  it("Correctly filters SpokePool FilledRelay events", async function () {
    // Inject a series of paired DepositWithBlock and FillWithBlock events. Query the
    // fills with various filters applied and ensure the expected results are returned.
    const fillEvents: FillWithBlock[] = [];

    for (let idx = 0; idx < 10; ++idx) {
      const { fill } = await generateValidRefundRequest(
        idx === 0 ? repaymentSpokePoolClient : originSpokePoolClient, // Add one random originChainId for filtering.
        destinationSpokePoolClient
      );
      fillEvents.push(fill);
    }

    // Should receive _all_ fills submitted on destinationChainId.
    let fills = await getFills(destinationChainId, spokePoolClients);
    expect(fills.length).to.equal(fillEvents.length);

    // Take the field from the last event and filter on it.
    // Should only get one event in response.
    for (const field of ["originChainId", "relayer", "fromBlock"]) {
      let sampleEvent = fillEvents.slice(-1)[0];
      let filter = { [field]: sampleEvent[field] };

      if (field === "originChainId") {
        // originChainId is the first event in the array.
        sampleEvent = fillEvents.find(({ originChainId }) => originChainId === repaymentChainId) as FillWithBlock;
        filter = { [field]: repaymentChainId };
      } else if (field === "fromBlock") {
        filter = { [field]: sampleEvent.blockNumber };
      }

      fills = await getFills(destinationChainId, spokePoolClients, filter);
      expect(fills.length).to.equal(1);

      if (field === "fromBlock") {
        expect(fills[0].blockNumber).to.equal(sampleEvent.blockNumber);
      } else {
        expect(fills[0][field]).to.equal(sampleEvent[field]);
      }
    }
  });

  it("Correctly filters SpokePool RefundRequested events", async function () {
    // Inject a series of paired RefundRequested, FillWithBlock and FundsDeposited events. Query the
    // refund requests with various filters applied and ensure the expected results are returned.
    // @dev Lots of boilerplate required for calling getRefundRequests().

    const refundRequestEvents: RefundRequestWithBlock[] = [];
    for (let idx = 0; idx < 10; ++idx) {
      const { refundRequest } = await generateValidRefundRequest(
        idx === 0 ? repaymentSpokePoolClient : originSpokePoolClient, // Add one random originChainId for filtering.
        destinationSpokePoolClient,
        repaymentSpokePoolClient
      );
      refundRequestEvents.push(refundRequest as RefundRequestWithBlock);
    }

    // Swap origin and destination SpokePoolClients for additional filtering.
    const { refundRequest } = await generateValidRefundRequest(
      destinationSpokePoolClient,
      originSpokePoolClient,
      repaymentSpokePoolClient
    );
    refundRequestEvents.push(refundRequest as RefundRequestWithBlock);

    // Should receive _all_ fills submitted on destinationChainId.
    let refundRequests = await getRefundRequests(repaymentChainId, hubPoolClient, spokePoolClients);
    expect(refundRequests.length).to.equal(refundRequestEvents.length);

    // Take the field from the last event and filter on it.
    // Should only get one event in response.
    for (const field of ["originChainId", "destinationChainId", "relayer", "fromBlock"]) {
      let sampleEvent = refundRequestEvents.slice(-1)[0];
      let filter = { [field]: sampleEvent[field] };

      if (field === "originChainId") {
        sampleEvent = refundRequestEvents.find(
          ({ originChainId }) => originChainId === repaymentChainId
        ) as RefundRequestWithBlock;
        filter = { [field]: repaymentChainId };
      } else if (field === "destinationChainId") {
        sampleEvent = refundRequestEvents.find(
          ({ destinationChainId }) => destinationChainId === originChainId
        ) as RefundRequestWithBlock;
        filter = { [field]: originChainId };
      } else if (field === "fromBlock") {
        filter = { [field]: sampleEvent.blockNumber };
      }

      refundRequests = await getRefundRequests(repaymentChainId, hubPoolClient, spokePoolClients, filter);
      expect(refundRequests.length).to.equal(1);

      if (field === "fromBlock") {
        expect(refundRequests[0].blockNumber).to.equal(sampleEvent.blockNumber);
      } else {
        expect(refundRequests[0][field]).to.equal(sampleEvent[field]);
      }
    }
  });
});
