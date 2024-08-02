import { Event, providers, utils as ethersUtils } from "ethers";
import winston from "winston";
import { Result } from "@ethersproject/abi";
import { CHAIN_IDs } from "@across-protocol/constants";
import { EventManager } from "../src/utils";
import { createSpyLogger, expect, randomAddress } from "./utils";

type Block = providers.Block;
type TransactionReceipt = providers.TransactionReceipt;
type TransactionResponse = providers.TransactionResponse;

describe("EventManager: Event Handling ", async function () {
  const chainId = CHAIN_IDs.MAINNET;
  const providers = ["infura", "alchemy", "llamanodes"];

  const randomNumber = (ceil = 1_000_000) => Math.floor(Math.random() * ceil);
  const makeHash = () => ethersUtils.id(randomNumber().toString());
  const makeTopic = () => ethersUtils.id(randomNumber().toString()).slice(0, 40);

  // Stub getters to be used in the events. These are not used in practice.
  const decodeError = new Error("Event decoding error");
  const getBlock = (): Promise<Block> => Promise.resolve({} as Block);
  const getTransaction = (): Promise<TransactionResponse> => Promise.resolve({} as TransactionResponse);
  const getTransactionReceipt = (): Promise<TransactionReceipt> => Promise.resolve({} as TransactionReceipt);
  const removeListener = (): void => {
    return;
  };

  const blockNumber = 100;
  const eventTemplate: Event = {
    blockNumber,
    transactionIndex: randomNumber(100),
    logIndex: randomNumber(100),
    transactionHash: makeHash(),
    removed: false,
    address: randomAddress(),
    data: ethersUtils.id(`EventManager-random-txndata-${randomNumber()}`),
    topics: [makeTopic()],
    args: [] as Result,
    blockHash: makeHash(),
    event: "randomEvent",
    eventSignature: "",
    decodeError,
    getBlock,
    getTransaction,
    getTransactionReceipt,
    removeListener,
  };

  let logger: winston.Logger;
  let eventMgr: EventManager;
  let quorum: number;

  beforeEach(async function () {
    ({ spyLogger: logger } = createSpyLogger());
    quorum = 2;
    eventMgr = new EventManager(logger, chainId, quorum);
  });

  it("Correctly applies quorum on added events", async function () {
    providers.forEach((provider, idx) => {
      // Verify initial quorum.
      let eventQuorum = eventMgr.getEventQuorum(eventTemplate);
      expect(eventQuorum).to.equal(idx);

      // Add the event from the current provider and verify that quorum updates.
      eventMgr.add(eventTemplate, provider);
      eventQuorum = eventMgr.getEventQuorum(eventTemplate);
      expect(eventQuorum).to.equal(idx + 1);

      // Try re-adding the same event from the same provider => shouldn't affect quorum.
      eventMgr.add(eventTemplate, providers[0]);
      eventQuorum = eventMgr.getEventQuorum(eventTemplate);
      expect(eventQuorum).to.equal(idx + 1);
    });
  });

  it("Waits for quorum before relaying events", async function () {
    const [provider1, provider2] = providers;
    expect(quorum).to.equal(2);

    eventMgr.add(eventTemplate, provider1);

    // The added event should not be returned despite the blockNumber increasing.
    let blockNumber: number;
    for (blockNumber = 0; blockNumber < 10; ++blockNumber) {
      const events = eventMgr.tick(blockNumber);
      expect(events.length).to.equal(0);
    }

    // At `finalisedBlock` the event should be returned.
    eventMgr.add(eventTemplate, provider2);
    let events = eventMgr.tick(blockNumber);
    expect(events.length).to.equal(1);
    expect(events[0]).to.deep.equal(eventTemplate);

    // No further events are available.
    events = eventMgr.tick(++blockNumber);
    expect(events.length).to.equal(0);
  });

  it("Drops removed events before quorum", async function () {
    const removed = true;
    expect(quorum).to.equal(2);

    const [provider1, provider2] = providers;

    // Add the event once (not finalised).
    eventMgr.add(eventTemplate, provider1);
    let events = eventMgr.tick(eventTemplate.blockNumber + 1);
    expect(events.length).to.equal(0);
    let eventQuorum = eventMgr.getEventQuorum(eventTemplate);
    expect(eventQuorum).to.equal(1);

    // Remove the event after notification by the same provider.
    eventMgr.remove({ ...eventTemplate, removed }, provider1);
    eventQuorum = eventMgr.getEventQuorum(eventTemplate);
    expect(eventQuorum).to.equal(0);

    // Re-add the same event.
    eventMgr.add(eventTemplate, provider1);
    events = eventMgr.tick(eventTemplate.blockNumber + 1);
    expect(events.length).to.equal(0);
    eventQuorum = eventMgr.getEventQuorum(eventTemplate);
    expect(eventQuorum).to.equal(1);

    // Remove the event after notification by a different provider.
    eventMgr.remove({ ...eventTemplate, removed }, "randomProvider");
    eventQuorum = eventMgr.getEventQuorum(eventTemplate);
    expect(eventQuorum).to.equal(0);

    // Add the same event from provider2. There should be no quorum.
    eventMgr.add(eventTemplate, provider2);
    events = eventMgr.tick(eventTemplate.blockNumber + 1);
    expect(events.length).to.equal(0);
  });
});
