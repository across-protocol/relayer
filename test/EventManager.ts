import { utils as ethersUtils } from "ethers";
import winston from "winston";
import { CHAIN_IDs } from "@across-protocol/constants";
import { Log } from "../src/interfaces";
import { EventManager } from "../src/utils";
import { createSpyLogger, expect, randomAddress } from "./utils";

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

  let logger: winston.Logger;
  let eventMgr: EventManager;
  let quorum: number;

  beforeEach(async function () {
    ({ spyLogger: logger } = createSpyLogger());
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

  it("reorg retracts only the re-orging provider's vote, orphaning only below quorum", function () {
    const [provider1, provider2, provider3] = providers;
    eventMgr.add(eventTemplate, provider1);
    eventMgr.add(eventTemplate, provider2); // quorum reached (relayed).
    eventMgr.add(eventTemplate, provider3);
    expect(eventMgr.getEventQuorum(eventKey)).to.equal(3);

    // One provider re-orgs above the event: its vote drops but quorum still holds → no orphan.
    expect(eventMgr.reorg(provider1, blockNumber - 1)).to.be.empty;
    expect(eventMgr.getEventQuorum(eventKey)).to.equal(2);
    expect(eventMgr.findEvent(eventKey)).to.exist;

    // A second provider re-orgs → falls below quorum → orphaned for removal.
    expect(eventMgr.reorg(provider2, blockNumber - 1)).to.have.lengthOf(1);
  });

  it("reorg ignores events at or below the fork point", function () {
    const [provider1, provider2] = providers;
    eventMgr.add(eventTemplate, provider1);
    eventMgr.add(eventTemplate, provider2);

    // Fork point at the event's own block: it is canonical, so the vote is untouched.
    expect(eventMgr.reorg(provider1, blockNumber)).to.be.empty;
    expect(eventMgr.getEventQuorum(eventKey)).to.equal(2);
  });
});
