import { groupBy } from "lodash";
import { EthersEventTemplate, MockSpokePoolClient } from "./mocks/MockSpokePoolClient";
import { RefundRequestWithBlock } from "../src/interfaces";
import { spreadEventWithBlockNumber } from "../src/utils";
import {
  createSpyLogger,
  expect,
  ethers,
  Contract,
  SignerWithAddress,
  destinationChainId,
  originChainId,
  repaymentChainId,
  deploySpokePoolWithToken,
} from "./utils";

let spokePool: Contract;
let relayer: SignerWithAddress;
let deploymentBlock: number;
let spokePoolClient: MockSpokePoolClient;

const event = "RefundRequested";

describe("SpokePoolClient: Refund Requests", async function () {
  beforeEach(async function () {
    [relayer] = await ethers.getSigners();
    ({ spokePool, deploymentBlock } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    await spokePool.setChainId(repaymentChainId); // Refunds requests are submitted on the repayment chain.

    spokePoolClient = new MockSpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool,
      repaymentChainId,
      deploymentBlock
    );
    await spokePoolClient.update();
  });

  it("Correctly fetches refund requests", async function () {
    const refundRequestEvents: RefundRequestWithBlock[] = [];
    for (let _idx = 0; _idx < 5; ++_idx) {
      const requestArgs: EthersEventTemplate = {
        address: relayer.address,
        event,
        topics: [relayer.address, originChainId.toString(), ""],
        args: {},
      };
      const testEvent = spokePoolClient.generateEvent(requestArgs);
      spokePoolClient.addEvent(testEvent);
      refundRequestEvents.push(spreadEventWithBlockNumber(testEvent) as RefundRequestWithBlock);
    }
    await spokePoolClient.update();

    const refundRequests = spokePoolClient.getRefundRequests();
    expect(refundRequests.length).to.equal(refundRequestEvents.length);

    refundRequests.forEach((refundRequest, idx) => {
      const _refundRequests = spokePoolClient.getRefundRequests();
      expect(_refundRequests[idx]).to.deep.equals(refundRequest);
    });
  });

  it("Correctly filters out refund requests based on blockNumber", async function () {
    // New events must come _after_ the current latestBlockNumber.
    const latestBlockNumber = spokePoolClient.latestBlockNumber;
    const minExpectedBlockNumber = latestBlockNumber + 1 + spokePoolClient.minBlockRange;

    const refundRequestEvents: RefundRequestWithBlock[] = [];
    for (let blockNumber = latestBlockNumber + 1; blockNumber <= minExpectedBlockNumber; ++blockNumber) {
      // Barebones Event - only absolutely necessary fields are populated.
      const requestArgs: EthersEventTemplate = {
        address: relayer.address,
        event,
        topics: [relayer.address, originChainId.toString(), ""],
        args: {},
        blockNumber,
      };
      const testEvent = spokePoolClient.generateEvent(requestArgs);
      spokePoolClient.addEvent(testEvent);
      refundRequestEvents.push(spreadEventWithBlockNumber(testEvent) as RefundRequestWithBlock);
    }
    await spokePoolClient.update();
    expect(spokePoolClient.latestBlockNumber - latestBlockNumber).to.be.at.least(4);

    // Filter out the RefundRequests at the fringes.
    const fromBlock = latestBlockNumber + 2;
    const toBlock = minExpectedBlockNumber - 2;
    const { filteredRequests = [], excludedRequests = [] } = groupBy(refundRequestEvents, (refundRequest) => {
      return refundRequest.blockNumber >= fromBlock && refundRequest.blockNumber <= toBlock
        ? "filteredRequests"
        : "excludedRequests";
    });

    // Both filteredRequests and excludedRequests must be populated.
    expect(excludedRequests.length).to.be.above(0);
    expect(filteredRequests.length).to.be.above(0);
    expect(spokePoolClient.getRefundRequests()).to.have.deep.members(refundRequestEvents);
    expect(spokePoolClient.getRefundRequests(fromBlock, toBlock)).to.have.deep.members(filteredRequests);
    expect(spokePoolClient.getRefundRequests(fromBlock, toBlock)).to.not.have.deep.members(excludedRequests);
  });
});
