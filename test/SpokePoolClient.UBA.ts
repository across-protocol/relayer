import { groupBy } from "lodash";
import { isUbaInflow, isUbaOutflow, DepositWithBlock, FillWithBlock, RefundRequestWithBlock } from "../src/interfaces";
import { getUBAFlows, spreadEventWithBlockNumber } from "../src/utils";
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
import { MockSpokePoolClient } from "./mocks/MockSpokePoolClient";

type Event = ethers.Event;

let spokePool: Contract;
let relayer: SignerWithAddress;
let deploymentBlock: number;
let spokePoolClient: MockSpokePoolClient;

const logger = createSpyLogger().spyLogger;

describe("SpokePoolClient: Refund Requests", async function () {
  beforeEach(async function () {
    [relayer] = await ethers.getSigners();
    ({ spokePool, deploymentBlock } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    await spokePool.setChainId(repaymentChainId); // Refunds requests are submitted on the repayment chain.

    spokePoolClient = new MockSpokePoolClient(logger, spokePool, repaymentChainId, deploymentBlock);
    await spokePoolClient.update();
  });

  it("Correctly orders UBA flows", async function () {
    const nTxns = spokePoolClient.minBlockRange;
    expect(nTxns).to.be.above(5);

    const _relayer = relayer.address;

    // Inject a series of FundsDeposited, FilledRelay and RefundRequested events.
    const events: Event[] = [];
    for (let idx = 0; idx < nTxns; ++idx) {
      const blockNumber = spokePoolClient.latestBlockNumber + idx;
      let transactionIndex = 0;
      for (const eventType of ["FundsDeposited", "FilledRelay", "RefundRequested"]) {
        let event: Event;
        switch (eventType) {
          case "FundsDeposited":
            event = spokePoolClient.generateDeposit({
              depositId: spokePoolClient.latestDepositIdQueried + idx,
              blockNumber,
              transactionIndex,
            } as DepositWithBlock);
            break;

          case "FilledRelay":
            event = spokePoolClient.generateFill({ relayer: _relayer, blockNumber, transactionIndex } as FillWithBlock);
            break;

          case "RefundRequested":
            event = spokePoolClient.generateRefundRequest({
              relayer: _relayer,
              blockNumber,
              transactionIndex,
            } as RefundRequestWithBlock);
            break;
        }

        events.push(event);
        ++transactionIndex;
      }
    }

    // Sanity check: events must be sequenced correctly.
    events.slice(1).forEach((event, idx) => {
      const sequenced =
        event.blockNumber > events[idx].blockNumber ||
        event.transactionIndex > events[idx].transactionIndex ||
        event.logIndex > events[idx].logIndex;
      expect(sequenced).to.be.true;
    });

    // Reverse the Event ordering load them into the SpokePoolClient.
    // @todo: Use events.toReversed() when it's available.
    Array.from(events)
      .reverse()
      .forEach((event) => spokePoolClient.addEvent(event));
    await spokePoolClient.update();

    const ubaFlows = getUBAFlows(spokePoolClient);
    expect(ubaFlows.length).is.eq(events.length);

    // Sort the generated events by inflow and outflow.
    const {
      inflows = [],
      outflows = [],
      unknown = [],
    } = groupBy(ubaFlows, (flow) => {
      let result = "unknown";
      if (isUbaInflow(flow)) {
        result = "inflows";
      } else if (isUbaOutflow(flow)) {
        result = "outflows";
      }
      return result;
    });
    expect(unknown.length).is.eq(0);
    expect(inflows.length).is.below(ubaFlows.length);
    expect(inflows.length).eq(nTxns);
    expect(inflows.length + outflows.length).eq(ubaFlows.length);
    expect(outflows.length).eq(2 * nTxns);

    // Note: The SpokePoolClient may append some data as part of transformation into
    // a ...WithBlock event, so ensure that event is a subset of ...WithBlock.
    events.forEach((_event, idx) => {
      const event = spreadEventWithBlockNumber(_event);
      expect(ubaFlows[idx]).to.deep.include(event);
    });
  });
});
