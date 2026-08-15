import { utils as ethersUtils } from "ethers";
import sinon from "sinon";
import winston from "winston";
import { CHAIN_IDs } from "@across-protocol/constants";
import { Log } from "../src/interfaces";
import { EventManager, MAX_EVENT_RETENTION_BLOCKS, MAX_PROVIDER_LAG_BLOCKS } from "../src/utils";
import { createSpyLogger, expect, lastSpyLogIncludes, randomAddress } from "./utils";

describe("EventManager: Event Handling ", function () {
  const chainId = CHAIN_IDs.MAINNET;
  const providers = ["infura", "alchemy", "llamanodes", "quicknode"];

  const randomNumber = (ceil = 1_000_000) => Math.floor(Math.random() * ceil);
  const makeHash = () => ethersUtils.id(randomNumber().toString());
  const makeTopic = () => ethersUtils.id(randomNumber().toString()).slice(0, 40);

  const blockNumber = 100;
  const eventTemplate: Log = {
    blockNumber,
    transactionIndex: randomNumber(100),
    logIndex: randomNumber(100),
    transactionHash: makeHash(),
    removed: false,
    address: randomAddress(),
    data: ethersUtils.id(`EventManager-random-txndata-${randomNumber()}`),
    topics: [makeTopic()],
    args: {},
    blockHash: makeHash(),
    event: "randomEvent",
  };
  let eventKey: string;

  // Retention is only exercised above the combined retention + lag window, so anchor test blocks well clear of it.
  const baseBlockNumber = 10 * (MAX_EVENT_RETENTION_BLOCKS + MAX_PROVIDER_LAG_BLOCKS);
  const makeEvent = (blockNumber: number): Log => ({
    ...eventTemplate,
    blockNumber,
    blockHash: makeHash(),
    transactionHash: makeHash(),
  });

  let logger: winston.Logger;
  let spy: sinon.SinonSpy;
  let eventMgr: EventManager;
  let quorum: number;

  beforeEach(async function () {
    ({ spy, spyLogger: logger } = createSpyLogger());
    quorum = 2;
    eventMgr = new EventManager(logger, chainId, quorum);
    eventKey = eventMgr.getEventKey(eventTemplate);
  });

  it("Correctly applies quorum on added events", async function () {
    providers.forEach((provider, idx) => {
      // Verify initial quorum.
      let eventQuorum = eventMgr.getEventQuorum(eventKey);
      expect(eventQuorum).to.equal(idx);

      // Add the event from the current provider and verify that quorum updates.
      eventMgr.add(eventTemplate, provider);
      eventQuorum = eventMgr.getEventQuorum(eventKey);
      expect(eventQuorum).to.equal(idx + 1);

      // Try re-adding the same event from the same provider => shouldn't affect quorum.
      eventMgr.add(eventTemplate, provider);
      eventQuorum = eventMgr.getEventQuorum(eventKey);
      expect(eventQuorum).to.equal(idx + 1);
    });
  });

  it("Waits for quorum before relaying events", async function () {
    const [provider1, provider2] = providers;
    expect(quorum).to.equal(2);

    let metQuorum = eventMgr.add(eventTemplate, provider1);
    expect(metQuorum).to.be.false;

    // The added event should not be returned despite re-adding the same event.
    metQuorum = eventMgr.add(eventTemplate, provider1);
    expect(metQuorum).to.be.false;

    // Add same event from another provider; should have quorum now.
    metQuorum = eventMgr.add(eventTemplate, provider2);
    expect(metQuorum).to.be.true;
  });

  it("Drops removed events before quorum", async function () {
    const removed = true;
    expect(quorum).to.equal(2);

    const [provider1, provider2] = providers;

    // Add the event once (not finalised).
    let metQuorum = eventMgr.add(eventTemplate, provider1);
    expect(metQuorum).to.be.false;

    let eventQuorum = eventMgr.getEventQuorum(eventKey);
    expect(eventQuorum).to.equal(1);

    // Remove the event after notification by the same provider.
    eventMgr.remove({ ...eventTemplate, removed }, provider1);
    eventQuorum = eventMgr.getEventQuorum(eventKey);
    expect(eventQuorum).to.equal(0);

    // Re-add the same event.
    metQuorum = eventMgr.add(eventTemplate, provider1);
    expect(metQuorum).to.be.false;
    eventQuorum = eventMgr.getEventQuorum(eventKey);
    expect(eventQuorum).to.equal(1);

    // Remove the event after notification by a different provider.
    eventMgr.remove({ ...eventTemplate, removed }, "randomProvider");
    eventQuorum = eventMgr.getEventQuorum(eventKey);
    expect(eventQuorum).to.equal(0);

    // Add the same event from provider2. There should be no quorum.
    metQuorum = eventMgr.add(eventTemplate, provider2);
    expect(eventQuorum).to.equal(0);
  });

  it("Evicts events that have fallen outside the retention window", async function () {
    const [provider1, provider2] = providers;
    const event = makeEvent(baseBlockNumber);
    const key = eventMgr.getEventKey(event);

    expect(eventMgr.add(event, provider1)).to.be.false;
    expect(eventMgr.add(event, provider2)).to.be.true;

    // Both providers advance past the retention window, so the event can no longer be reorged out.
    const head = makeEvent(baseBlockNumber + MAX_EVENT_RETENTION_BLOCKS + 1);
    [provider1, provider2].forEach((provider) => eventMgr.add(head, provider));

    expect(eventMgr.getEventQuorum(key)).to.equal(0);
    expect(eventMgr.events[key]).to.be.undefined;
    expect(eventMgr.blockHashes[event.blockHash]).to.be.undefined;

    // The event at the head is retained.
    expect(eventMgr.getEventQuorum(eventMgr.getEventKey(head))).to.equal(quorum);
  });

  it("Retains events for lagging providers, so late votes still reach quorum", async function () {
    const [provider1, provider2] = providers;
    const event = makeEvent(baseBlockNumber);
    const key = eventMgr.getEventKey(event);

    // Both providers are keeping up; provider2 then stalls just short of the maximum permitted lag.
    const priorEvent = makeEvent(baseBlockNumber - 1);
    [provider1, provider2].forEach((provider) => eventMgr.add(priorEvent, provider));
    expect(eventMgr.add(event, provider1)).to.be.false;

    // provider1 races ahead beyond the retention window, but provider2 is still eligible to vote.
    const head = makeEvent(baseBlockNumber + MAX_EVENT_RETENTION_BLOCKS + MAX_PROVIDER_LAG_BLOCKS - 1);
    eventMgr.add(head, provider1);
    expect(eventMgr.getEventQuorum(key)).to.equal(1);

    // provider2's stream resumes and supplies the event late; it must still reach quorum.
    expect(eventMgr.add(event, provider2)).to.be.true;
  });

  it("Bounds retention when a provider stalls indefinitely", async function () {
    const [provider1, provider2] = providers;
    const event = makeEvent(baseBlockNumber);
    const key = eventMgr.getEventKey(event);

    const priorEvent = makeEvent(baseBlockNumber - 1);
    [provider1, provider2].forEach((provider) => eventMgr.add(priorEvent, provider));
    expect(eventMgr.add(event, provider1)).to.be.false;

    // provider2 never advances again; retention must not be held open indefinitely on its behalf.
    const head = makeEvent(baseBlockNumber + MAX_EVENT_RETENTION_BLOCKS + MAX_PROVIDER_LAG_BLOCKS + 1);
    eventMgr.add(head, provider1);

    expect(eventMgr.events[key]).to.be.undefined;
    expect(eventMgr.blockHashes[event.blockHash]).to.be.undefined;
    expect(lastSpyLogIncludes(spy, "Ignoring stalled")).to.be.true;
  });

  it("Keys events correctly: uniqueness", async function () {
    const log1 = eventTemplate;
    const key1 = eventMgr.getEventKey(log1);
    expect(key1).to.exist;

    const log2 = { ...log1, logIndex: log1.logIndex + 1 };
    const key2 = eventMgr.getEventKey(log2);
    expect(key2).to.not.equal(key1);

    const log3 = { ...log2, logIndex: log2.logIndex - 1 };
    const key3 = eventMgr.getEventKey(log3);
    expect(key3).to.equal(key1);
  });

  it("Does not submit duplicate events", async function () {
    expect(quorum).to.equal(2);

    const [provider1, provider2, provider3, provider4] = providers;

    // Add the event once (not finalised).
    let metQuorum = eventMgr.add(eventTemplate, provider1);
    expect(metQuorum).to.be.false;

    // Add the same event from a different provider. Should now meet quorum.
    metQuorum = eventMgr.add(eventTemplate, provider2);
    expect(metQuorum).to.be.true;

    // Re-add the same event again, from two new providers. Does not re-trigger quorum.
    // Verify that the same event was not replayed.
    metQuorum = eventMgr.add(eventTemplate, provider3);
    expect(metQuorum).to.be.false;

    metQuorum = eventMgr.add(eventTemplate, provider4);
    expect(metQuorum).to.be.false;
  });
});
