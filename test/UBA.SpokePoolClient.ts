// @note: The lines marked @todo: destinationToken need a fix in the sdk-v2 MockSpokePoolClient to permit
// the HubPoolClient to be passed in. This is needed in order to resolve the correct SpokePool destinationToken.
import { relayFeeCalculator } from "@across-protocol/sdk-v2";
import { groupBy, random } from "lodash";
import {
  isUbaInflow,
  isUbaOutflow,
  outflowIsFill,
  DepositWithBlock,
  FillWithBlock,
  RefundRequest,
  RefundRequestWithBlock,
  UbaOutflow,
} from "../src/interfaces";
import { UBAClient } from "../src/clients";
import { ZERO_ADDRESS, isDefined, sortEventsAscending, spreadEventWithBlockNumber } from "../src/utils";
import {
  assert,
  createSpyLogger,
  expect,
  ethers,
  Contract,
  deployConfigStore,
  fillFromDeposit,
  refundRequestFromFill,
  hubPoolFixture,
  SignerWithAddress,
  destinationChainId,
  originChainId,
  repaymentChainId,
  randomAddress,
  deploySpokePool,
  toBN,
  toBNWei,
} from "./utils";
import { MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient } from "./mocks";

type Event = ethers.Event;
type RelayFeeCalculatorConfig = relayFeeCalculator.RelayFeeCalculatorConfig;

let hubPool: Contract, weth: Contract, dai: Contract;
let hubPoolClient: MockHubPoolClient;

let owner: SignerWithAddress, _relayer: SignerWithAddress, relayer: string;
let spokePoolClients: { [chainId: number]: MockSpokePoolClient };
let originSpokePool: SpokePoolClient;
let destSpokePool: SpokePoolClient;
let refundSpokePool: SpokePoolClient;
let ubaClient: UBAClient;
let originToken: string, refundToken: string;

const chainIds = [originChainId, destinationChainId, repaymentChainId];
const logger = createSpyLogger().spyLogger;

describe("UBA: SpokePool Events", async function () {
  beforeEach(async function () {
    [owner, _relayer] = await ethers.getSigners();
    relayer = _relayer.address;

    const { configStore } = await deployConfigStore(owner, []);
    const configStoreClient = new MockConfigStoreClient(logger, configStore);

    ({ hubPool, weth, dai } = await hubPoolFixture());
    const deploymentBlock = await hubPool.provider.getBlockNumber();
    hubPoolClient = new MockHubPoolClient(logger, hubPool, configStoreClient, deploymentBlock);
    refundToken = originToken = weth.address;

    spokePoolClients = {};
    for (const chainId of chainIds) {
      const { spokePool } = await deploySpokePool(ethers);
      const deploymentBlock = await spokePool.provider.getBlockNumber();

      await spokePool.setChainId(chainId);
      const spokePoolClient = new MockSpokePoolClient(logger, spokePool, chainId, deploymentBlock);

      for (const destinationChainId of chainIds) {
        // For each SpokePool, construct routes to each _other_ SpokePool.
        if (destinationChainId === chainId) {
          continue;
        }

        // @todo: destinationToken
        [ZERO_ADDRESS, weth.address, dai.address].forEach((originToken) => {
          let event = spokePoolClient.generateDepositRoute(originToken, destinationChainId, true);
          spokePoolClient.addEvent(event);

          event = hubPoolClient.setPoolRebalanceRoute(destinationChainId, originToken, originToken);
          hubPoolClient.addEvent(event);
        });
      }

      await spokePoolClient.update();
      spokePoolClients[chainId] = spokePoolClient;
    }

    originSpokePool = spokePoolClients[originChainId];
    destSpokePool = spokePoolClients[destinationChainId];
    refundSpokePool = spokePoolClients[repaymentChainId];

    await configStoreClient.update();
    await hubPoolClient.update();

    // @todo: The RelayFeeCalculatorConfig should be mocked.
    ubaClient = new UBAClient(chainIds, hubPoolClient, spokePoolClients, {} as RelayFeeCalculatorConfig, logger);
  });

  it.skip("Correctly orders UBA flows", async function () {
    const spokePoolClient = spokePoolClients[repaymentChainId];

    const nTxns = spokePoolClient.minBlockRange;
    expect(nTxns).to.be.above(5);

    // Inject a series of FundsDeposited, FilledRelay and RefundRequested events.
    const events: Event[] = [];
    for (let idx = 0; idx < nTxns; ++idx) {
      // blockNumbers are deliberately sequential; the ordering is reversed later.
      const blockNumber = spokePoolClient.latestBlockNumber + idx;
      let transactionIndex = 0;
      let deposit: DepositWithBlock, fill: FillWithBlock;

      for (const eventType of ["FundsDeposited", "FilledRelay", "RefundRequested"]) {
        let event: Event;
        switch (eventType) {
          case "FundsDeposited":
            event = spokePoolClient.generateDeposit({
              originToken,
              depositId: spokePoolClient.latestDepositIdQueried + idx,
              blockNumber,
              transactionIndex,
            } as DepositWithBlock);
            break;

          case "FilledRelay":
            event = spokePoolClient.generateFill({
              relayer,
              originChainId,
              blockNumber,
              transactionIndex,
            } as FillWithBlock);
            break;

          case "RefundRequested":
            // First inject a FilledRelay event into the origin chain.
            event = originSpokePool.generateDeposit({
              originToken,
              depositId: random(1, 100_000_000, false),
              destinationChainId,
              blockNumber: originSpokePool.latestBlockNumber + random(1, idx, false),
            } as DepositWithBlock);
            originSpokePool.addEvent(event);
            await originSpokePool.update();
            deposit = originSpokePool
              .getDepositsForDestinationChain(destinationChainId)
              .find((deposit) => deposit.transactionHash === event.transactionHash);

            // Then inject a FilledRelay event into the destination chain.
            fill = fillFromDeposit(deposit, relayer) as FillWithBlock;
            fill.repaymentChainId = repaymentChainId;
            fill.blockNumber = destSpokePool.latestBlockNumber + random(1, idx, false);

            event = destSpokePool.generateFill(fill as FillWithBlock);
            event.args["destinationToken"] = ZERO_ADDRESS; // @todo: destinationToken
            destSpokePool.addEvent(event);
            await destSpokePool.update();
            fill = destSpokePool
              .getFillsForRelayer(relayer)
              .find((fill) => fill.transactionHash === event.transactionHash);

            // Now we can issue a RefundRequest on the refund chain.
            event = spokePoolClient.generateRefundRequest({
              ...refundRequestFromFill(fill, relayer, refundToken),
              blockNumber,
              transactionIndex,
              logIndex: random(1, 1000, false),
              transactionHash: ethers.utils.id(`${random(1, 100_000)}`),
            });
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

    const ubaFlows = ubaClient.getFlows(spokePoolClient.chainId);
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

  it.skip("Correctly includes initial partial fills", async function () {
    const spokePoolClient = spokePoolClients[destinationChainId];

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
    const ubaFlows = ubaClient.getFlows(spokePoolClient.chainId);

    const fills = sortEventsAscending(fullFills.concat(partialFills)).map((event) => spreadEventWithBlockNumber(event));

    // Each injected event should be present, because the partial fills were still the _first_ fill.
    expect(ubaFlows.length).is.equal(fills.length);
    expect(ubaFlows).to.deep.equal(fills);
  });

  it.skip("Correctly filters subsequent partial fills", async function () {
    const spokePoolClient = spokePoolClients[destinationChainId];

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
    const ubaFlows = ubaClient.getFlows(spokePoolClient.chainId);

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

  it.skip("Correctly filters slow fills", async function () {
    const spokePoolClient = spokePoolClients[destinationChainId];

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
    const ubaFlows = ubaClient.getFlows(spokePoolClient.chainId);

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

  it.skip("Correctly filters invalid refund requests", async function () {
    const depositEvent = originSpokePool.generateDeposit({
      amount: toBNWei(random(1, 1000).toPrecision(5)),
      originChainId,
      destinationChainId,
      relayerFeePct: toBNWei(random(0.000001, 0.0001).toPrecision(5)),
      depositId: random(1, 1_000_000, false),
      quoteTimestamp: Math.floor(Date.now() / 1000),
      originToken: refundToken,
      destinationToken: refundToken,
      depositor: randomAddress(),
      recipient: randomAddress(),
      message: "",
      blockNumber: originSpokePool.firstBlockToSearch,
      transactionIndex: random(1, 1000),
      logIndex: random(1, 1000, false),
      transactionHash: ethers.utils.id(`${random(1, 100_000)}`),
    });
    originSpokePool.addEvent(depositEvent);
    await originSpokePool.update();

    const _deposit = originSpokePool
      .getDepositsForDestinationChain(destinationChainId)
      .find((deposit: DepositWithBlock) => deposit.transactionHash === depositEvent.transactionHash);

    const fill = fillFromDeposit(_deposit);
    fill.relayer = relayer;
    fill.destinationToken = weth.address; // @todo: destinationToken
    fill.repaymentChainId = repaymentChainId;
    fill.blockNumber = destSpokePool.firstBlockToSearch;
    fill.transactionIndex = random(1, 1000, false);
    fill.logIndex = random(1, 1000, false);
    fill.transactionHash = ethers.utils.id(`${random(1, 100_000)}`);

    const fillEvent = destSpokePool.generateFill(fill);
    fillEvent.args["destinationToken"] = ZERO_ADDRESS; // @todo: destinationToken
    destSpokePool.addEvent(fillEvent);
    await destSpokePool.update();
    const _fill = destSpokePool
      .getFillsForRelayer(fill.relayer)
      .find((fill: FillWithBlock) => fill.transactionHash === fillEvent.transactionHash);

    const _refundRequest: RefundRequest = refundRequestFromFill(_fill, relayer, fill.destinationToken);
    for (const key of Object.keys(_refundRequest).concat([""])) {
      let expectValid = false;

      // Construct a standard RefundRequest, but iteratively modify each k/v pair and ensure it fails.
      const modifiedRefundRequest: RefundRequestWithBlock = {
        ..._refundRequest,
        blockNumber: refundSpokePool.firstBlockToSearch,
        transactionIndex: random(0, 1000, false),
        logIndex: random(0, 1000, false),
        transactionHash: ethers.utils.id(`${random(1, 100_000)}`),
      };

      switch (key) {
        case "relayer":
        case "refundToken":
          modifiedRefundRequest[key] = randomAddress();
          break;

        case "originChainId":
        case "destinationChainId":
        case "depositId":
          modifiedRefundRequest[key] = modifiedRefundRequest[key] + 1;
          break;

        case "amount":
        case "realizedLpFeePct":
        case "fillBlock":
          modifiedRefundRequest[key] = toBN(1).add(modifiedRefundRequest[key]);
          break;

        case "previousIdenticalRequests":
        default:
          // Don't modify with; expect a valid refund request.
          expect(["previousIdenticalRequests", ""].includes(key)).to.be.true;
          expectValid = true;
          break;
      }

      const refundRequestEvent = refundSpokePool.generateRefundRequest(modifiedRefundRequest);
      refundSpokePool.addEvent(refundRequestEvent);
      await refundSpokePool.update();

      const refundRequest = refundSpokePool
        .getRefundRequests()
        .find((request) => request.transactionHash === refundRequestEvent.transactionHash);
      expect(isDefined(refundRequest)).to.be.true;

      const { valid, reason } = await ubaClient.refundRequestIsValid(repaymentChainId, refundRequest);
      expect(valid).to.be.equal(expectValid);
      expect(valid).to.be.equal(reason === undefined); // Require a reason if the RefundRequest was invalid.
    }
  });
});
