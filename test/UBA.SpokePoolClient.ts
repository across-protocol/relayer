import { groupBy, random } from "lodash";
import {
  isUbaInflow,
  isUbaOutflow,
  outflowIsFill,
  DepositWithBlock,
  FillWithBlock,
  RefundRequestWithBlock,
  UbaOutflow,
} from "../src/interfaces";
import { getUBAFlows, sortEventsAscending, spreadEventWithBlockNumber } from "../src/utils";
import {
  assert,
  createSpyLogger,
  expect,
  ethers,
  Contract,
  SignerWithAddress,
  destinationChainId,
  originChainId,
  repaymentChainId,
  deploySpokePoolWithToken,
  toBN,
  toBNWei,
} from "./utils";
import { MockSpokePoolClient } from "./mocks";

type Event = ethers.Event;

let spokePool: Contract;
let _relayer: SignerWithAddress, relayer: string;
let deploymentBlock: number;
let spokePoolClient: MockSpokePoolClient;

const logger = createSpyLogger().spyLogger;

describe("UBA: SpokePool Events", async function () {
  beforeEach(async function () {
    [_relayer] = await ethers.getSigners();
    relayer = _relayer.address;

    ({ spokePool, deploymentBlock } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    await spokePool.setChainId(repaymentChainId); // Refunds requests are submitted on the repayment chain.

    spokePoolClient = new MockSpokePoolClient(logger, spokePool, repaymentChainId, deploymentBlock);
    await spokePoolClient.update();
  });

  it("Correctly orders UBA flows", async function () {
    const nTxns = spokePoolClient.minBlockRange;
    expect(nTxns).to.be.above(5);

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
            event = spokePoolClient.generateFill({ relayer, blockNumber, transactionIndex } as FillWithBlock);
            break;

          case "RefundRequested":
            event = spokePoolClient.generateRefundRequest({
              relayer,
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

  it("Correctly includes initial partial fills", async function () {
    const nTxns = spokePoolClient.minBlockRange;
    expect(nTxns).to.be.above(5);

    const fullFills: Event[] = [];
    const partialFills: Event[] = [];

    // Generate and inject a mix of complete and partial fill events.
    const blockNumber = spokePoolClient.latestBlockNumber + 1;
    const amount = toBNWei(1);
    let transactionIndex = 0;
    while (fullFills.length < 5 || partialFills.length < 5) {
      // Randomly determine full or partial fill.
      const fillAmount = random(1, false) === 1 ? amount : toBNWei(random(0.01, 0.99));
      const fill = spokePoolClient.generateFill({
        relayer,
        amount,
        fillAmount,
        totalFilledAmount: fillAmount,
        blockNumber,
        transactionIndex,
      } as FillWithBlock);
      ++transactionIndex;

      // Sort the events on the input side, for comparison later.
      (fillAmount.eq(amount) ? fullFills : partialFills).push(fill);
      spokePoolClient.addEvent(fill);
    }

    await spokePoolClient.update();
    const ubaFlows = getUBAFlows(spokePoolClient);

    const fills = sortEventsAscending(fullFills.concat(partialFills)).map((event) => spreadEventWithBlockNumber(event));

    // Each injected event should be present, because the partial fills were still the _first_ fill.
    expect(ubaFlows.length).is.equal(fills.length);
    expect(ubaFlows).to.deep.equal(fills);
  });

  it("Correctly filters subsequent partial fills", async function () {
    const nDeposits = 5;

    const fullFills: Event[] = [];
    const partialFills: Event[] = [];

    // Generate and inject a mix of complete and partial fill events.
    const blockNumber = spokePoolClient.latestBlockNumber + 1;
    const amount = toBNWei(1);
    for (let depositId = 0; depositId < nDeposits; ++depositId) {
      let totalFilledAmount = toBN(0);
      let transactionIndex = 0;

      while (!totalFilledAmount.eq(amount)) {
        const _fillAmount = amount.div(1 + depositId);
        const fillAmount = _fillAmount.add(totalFilledAmount).lte(amount) ? _fillAmount : amount.sub(totalFilledAmount);

        totalFilledAmount = totalFilledAmount.add(fillAmount);

        const fill = spokePoolClient.generateFill({
          relayer,
          depositId,
          amount,
          fillAmount,
          totalFilledAmount,
          blockNumber,
          transactionIndex,
        } as FillWithBlock);
        ++transactionIndex;

        // Inject the fill event.
        (fillAmount.eq(amount) ? fullFills : partialFills).push(fill);
        spokePoolClient.addEvent(fill);
      }
    }

    await spokePoolClient.update();
    const ubaFlows = getUBAFlows(spokePoolClient);

    // Each deposit should be _completely_ filled, but there should only be one outflow for each deposit.
    expect(ubaFlows.length).is.equal(nDeposits);
    ubaFlows.forEach((ubaFlow) => {
      if (isUbaOutflow(ubaFlow) && outflowIsFill(ubaFlow)) {
        expect(ubaFlow.totalFilledAmount.eq(ubaFlow.fillAmount)).to.be.true;
      } else {
        assert.fail("ubaFlow is not a fill");
      }
    });
  });

  it("Correctly filters slow fills", async function () {
    // Inject slow and instant fill events.
    const events: Event[] = [];
    for (let idx = 0; idx < spokePoolClient.minBlockRange; ++idx) {
      const blockNumber = spokePoolClient.latestBlockNumber + idx;
      const transactionIndex = 0;
      [true, false].forEach((isSlowRelay) => {
        const fill = spokePoolClient.generateFill({
          relayer,
          blockNumber,
          transactionIndex,
          updatableRelayData: {
            isSlowRelay,
          },
        } as FillWithBlock);

        spokePoolClient.addEvent(fill);
        events.push(fill);
      });
    }

    await spokePoolClient.update();
    const ubaFlows = getUBAFlows(spokePoolClient);

    expect(ubaFlows.length).is.eq(events.length / 2);
    ubaFlows.forEach((ubaFlow) => {
      if (!isUbaOutflow(ubaFlow)) {
        assert.fail("ubaFlow is not an outflow");
      }

      if (!outflowIsFill(ubaFlow as UbaOutflow)) {
        assert.fail("UBA outflow is not a fill");
      }

      expect((ubaFlow as FillWithBlock).updatableRelayData.isSlowRelay).to.be.false;
    });
  });
});
