import { groupBy } from "lodash";
import { MockSpokePoolClient } from "./mocks";
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
let _relayer: SignerWithAddress, relayer: string;
let deploymentBlock: number;
let spokePoolClient: MockSpokePoolClient;

describe("SpokePoolClient: Refund Requests", async function () {
  beforeEach(async function () {
    [_relayer] = await ethers.getSigners();
    relayer = _relayer.address;

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
      const refundRequest = { relayer, originChainId } as RefundRequestWithBlock;
      const testEvent = spokePoolClient.generateRefundRequest(refundRequest);
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
    const { chainId: repaymentChainId, latestBlockNumber } = spokePoolClient;
    const nEvents = 5;
    const minExpectedBlockNumber = latestBlockNumber + nEvents;

    let refundRequestEvents: RefundRequestWithBlock[] = [];
    for (let txn = 0; txn < nEvents; ++txn) {
      // Barebones Event - only absolutely necessary fields are populated.
      const blockNumber = latestBlockNumber + 1 + txn;
      const refundRequest = { relayer, originChainId, blockNumber } as RefundRequestWithBlock;
      const testEvent = spokePoolClient.generateRefundRequest(refundRequest);
      spokePoolClient.addEvent(testEvent);
      refundRequestEvents.push({
        ...spreadEventWithBlockNumber(testEvent),
        repaymentChainId,
        blockTimestamp: (await testEvent.getBlock()).timestamp,
      } as RefundRequestWithBlock);
    }
    await spokePoolClient.update();
    refundRequestEvents = refundRequestEvents.map((e) => {
      const block = spokePoolClient.blocks[e.blockNumber];
      return {
        ...e,
        blockTimestamp: block.timestamp,
      };
    }) as RefundRequestWithBlock[];
    expect(spokePoolClient.latestBlockNumber - latestBlockNumber).to.be.at.least(nEvents);

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
