import { Contract, utils as ethersUtils } from "ethers";
import winston from "winston";
import { Result } from "@ethersproject/abi";
import { CHAIN_IDs } from "@across-protocol/constants";
import { constants, utils as sdkUtils } from "@across-protocol/sdk";
import { SpokeListener, EVMSpokePoolClient } from "../src/clients";
import { Log } from "../src/interfaces";
import { EventSearchConfig, sortEventsAscending, sortEventsAscendingInPlace } from "../src/utils";
import { ListenerMessage } from "../src/libexec/types";
import { assertPromiseError, createSpyLogger, deploySpokePoolWithToken, expect, randomAddress } from "./utils";

type Constructor<T = EVMSpokePoolClient> = new (...args: any[]) => T;

// Minimum common-ish interface supplied by the SpokePoolClient.
type MinSpokeListener = {
  _indexerUpdate: (message: unknown) => void;
};

function _MockSpokeListener<T extends Constructor<MinSpokeListener>>(SpokeListener: T) {
  return class extends SpokeListener {
    // Permit parent _indexerUpdate method to be called externally.
    indexerUpdate(rawMessage: unknown): void {
      super._indexerUpdate(rawMessage);
    }

    // Suppress spawning of workers.
    protected _startWorker(): void {
      return;
    }
  };
}

describe("IndexedSpokePoolClient: Update", async function () {
  const MockSpokeListener = _MockSpokeListener(SpokeListener(EVMSpokePoolClient));
  const chainId = CHAIN_IDs.MAINNET;

  const randomNumber = (ceil = 1_000_000) => Math.floor(Math.random() * ceil);
  const makeHash = (seed?: number) => ethersUtils.id((seed ?? randomNumber()).toString());
  const makeTopic = (signature?: string) => ethersUtils.id(signature ?? randomNumber().toString()).slice(0, 40);

  let blockNumber = 100;

  const generateEvent = (event: string, blockNumber: number, transactionHash?: string): Log => {
    transactionHash ??= makeHash();
    return {
      blockNumber,
      transactionIndex: randomNumber(100),
      logIndex: randomNumber(100),
      transactionHash,
      removed: false,
      address: randomAddress(),
      data: ethersUtils.id(`EventManager-random-txndata-${randomNumber()}`),
      topics: [makeTopic()],
      args: [] as Result,
      blockHash: makeHash(blockNumber),
      event,
    };
  };

  let depositId: BigNumber;
  const getDepositEvent = (blockNumber: number, transactionHash?: string): Log => {
    const event = generateEvent("FundsDeposited", blockNumber, transactionHash);
    depositId = depositId.add(bnOne);
    const args = {
      depositor: randomAddress(),
      recipient: randomAddress(),
      depositId,
      inputToken: randomAddress(),
      destinationChainId: Math.ceil(Math.random() * 1e3),
      inputAmount: sdkUtils.bnOne,
      outputToken: randomAddress(),
      outputAmount: sdkUtils.bnOne,
      quoteTimestamp: currentTime,
      message: constants.EMPTY_MESSAGE,
      fillDeadline: 0,
      exclusiveRelayer: constants.ZERO_ADDRESS,
      exclusivityDeadline: 0,
    } as unknown as Result; // Ethers Result type is just weird :(
    return { ...event, args };
  };

  const getDepositRouteEvent = (blockNumber: number): Log => {
    const event = generateEvent("EnabledDepositRoute", blockNumber);
    const args = {
      originToken: randomAddress(),
      destinationChainId: Math.round(Math.random() * 100_000),
      enabled: Math.random() > 0.5,
    } as unknown as Result; // Ethers Result type is just weird :(
    return { ...event, args };
  };

  let logger: winston.Logger;
  let spokePool: Contract;
  let spokePoolClient: any; // nasty @todo
  let currentTime: number;

  /**
   * postEvents() and removeEvent() emulate the indexer's corresponding functions. The indexer uses
   * process.send() to submit a message to the SpokePoolClient. In this test, the SpokePoolClient
   * instance is immediately accessible and the message handler callback is called directly.
   */
  const postEvents = (events: Log[]): void => {
    const message: ListenerMessage = {
      nEvents: events.length,
      data: JSON.stringify(sortEventsAscending(events), sdkUtils.jsonReplacerWithBigNumbers),
    };

    spokePoolClient.indexerUpdate(JSON.stringify(message));
  };

  const postBlock = (blockNumber: number, currentTime: number): void => {
    const message: ListenerMessage = {
      blockNumber,
      currentTime,
    };

    spokePoolClient.indexerUpdate(JSON.stringify(message));
  };

  const removeEvent = (event: Log): void => {
    event.removed = true;
    const message = {
      event: JSON.stringify(event, sdkUtils.jsonReplacerWithBigNumbers),
    };
    spokePoolClient.indexerUpdate(JSON.stringify(message));
  };

  beforeEach(async function () {
    let deploymentBlock: number;
    ({ spyLogger: logger } = createSpyLogger());
    ({ spokePool, deploymentBlock } = await deploySpokePoolWithToken(chainId));
    const searchConfig: EventSearchConfig | undefined = undefined;
    spokePoolClient = new MockSpokeListener(logger, spokePool, null, chainId, deploymentBlock, searchConfig);
    spokePoolClient.init({});
    depositId = bnOne;
    currentTime = Math.round(Date.now() / 1000);
  });

  it("Correctly receives and unpacks SpokePoolEventsAdded messages from indexer", async function () {
    const events: Log[] = [];
    for (let i = 0; i < 25; ++i) {
      events.push(getDepositEvent(blockNumber));
    }
    sortEventsAscendingInPlace(events);

    postBlock(blockNumber, getCurrentTime());
    postEvents(events);

    await spokePoolClient.update();

    expect(spokePoolClient.latestHeightSearched).to.equal(blockNumber);

    const deposits = spokePoolClient.getDeposits();
    expect(deposits.length).to.equal(events.length);
    deposits.forEach((deposit, idx) => {
      const log = events[idx];
      expect(deposit.txnIndex).to.equal(log.transactionIndex);
      expect(deposit.txnRef).to.equal(log.transactionHash);
      expect(deposit.logIndex).to.equal(log.logIndex);
      expect(deposit.depositId).to.equal(log.args!.depositId);
      expect(deposit.inputToken.toEvmAddress()).to.equal(log.args!.inputToken);
      expect(deposit.inputAmount).to.equal(log.args!.inputAmount);
      expect(deposit.outputToken.toEvmAddress()).to.equal(log.args!.outputToken);
      expect(deposit.outputAmount).to.equal(log.args!.outputAmount);
      expect(deposit.message).to.equal(log.args!.message);
      expect(deposit.quoteTimestamp).to.equal(log.args!.quoteTimestamp);
      expect(deposit.fillDeadline).to.equal(log.args!.fillDeadline);
      expect(deposit.exclusivityDeadline).to.equal(log.args!.exclusivityDeadline);
      expect(deposit.exclusiveRelayer.toEvmAddress()).to.equal(log.args!.exclusiveRelayer);
    });
  });

  it("Correctly removes pending events that are dropped before update", async function () {
    const events: Log[] = [];
    for (let i = 0; i < 25; ++i) {
      events.push(getDepositEvent(blockNumber++));
    }
    sortEventsAscendingInPlace(events);

    postBlock(blockNumber, currentTime);
    postEvents(events);
    const [droppedEvent] = events.splice(-2, 1); // Drop the 2nd-last event.
    removeEvent(droppedEvent);

    await spokePoolClient.update();

    // Verify that the dropped event is _not_ present in deposits.
    const deposits = spokePoolClient.getDeposits();
    expect(deposits.length).to.equal(events.length);
    const droppedDeposit = deposits.find(({ txnRef }) => txnRef === droppedEvent.transactionHash);
    expect(droppedDeposit).to.not.exist;
  });

  it("Correctly removes all pending events for a given blockHash", async function () {
    const events: Log[] = [];
    for (let i = 0; i < 25; ++i) {
      events.push(getDepositEvent(blockNumber));
    }

    postBlock(blockNumber, currentTime);
    postEvents(events);

    const [droppedEvent] = events;
    removeEvent(droppedEvent);

    await spokePoolClient.update();

    // All events should have been dropped before SpokePoolClient update.
    const deposits = spokePoolClient.getDeposits();
    expect(deposits.length).to.equal(0);
  });

  it("Correctly removes pending events that are dropped after update", async function () {
    const events: Log[] = [];
    for (let i = 0; i < 25; ++i) {
      events.push(getDepositEvent(blockNumber++));
    }
    sortEventsAscendingInPlace(events);

    postBlock(blockNumber, currentTime);
    postEvents(events);
    await spokePoolClient.update();

    let deposits = spokePoolClient.getDeposits();
    expect(deposits.length).to.equal(events.length);

    const [droppedEvent] = events.splice(-2, 1); // Drop the 2nd-last event.
    removeEvent(droppedEvent);

    await spokePoolClient.update();
    deposits = spokePoolClient.getDeposits();
    expect(deposits.length).to.equal(events.length);
    const droppedDeposit = deposits.find((deposit) => deposit.txnRef === droppedEvent.transactionHash);
    expect(droppedDeposit).to.not.exist;
  });

  it("Correctly removes multiple deposits within the same transactionHash after update", async function () {
    const events: Log[] = [];
    const deposit = getDepositEvent(blockNumber);
    const { transactionHash } = deposit;
    for (let i = 0; i < 25; ++i) {
      events.push(getDepositEvent(blockNumber, transactionHash));
    }
    sortEventsAscendingInPlace(events);

    postBlock(blockNumber, currentTime);
    postEvents(events);
    await spokePoolClient.update();

    let deposits = spokePoolClient.getDeposits();
    expect(deposits.length).to.equal(events.length);

    // Drop a single event and verify that all related events w/ same transactionHash are also dropped.
    removeEvent(deposit);

    await spokePoolClient.update();
    deposits = spokePoolClient.getDeposits();
    expect(deposits.length).to.equal(0);
  });

  it("Throws on post-ingested dropped EnabledDepositRoute events", async function () {
    const events: Log[] = [];
    for (let i = 0; i < 25; ++i) {
      events.push(getDepositRouteEvent(blockNumber++));
    }
    sortEventsAscendingInPlace(events);

    postBlock(blockNumber, currentTime);
    postEvents(events);
    await spokePoolClient.update();

    const depositRoutes = spokePoolClient.getDepositRoutes();
    expect(Object.keys(depositRoutes).length).to.equal(events.length);

    const [droppedEvent] = events.splice(-2, 1); // Drop the 2nd-last event.
    removeEvent(droppedEvent);

    await assertPromiseError(spokePoolClient.update(), "Detected re-org affecting deposit route events");
  });
});
