import { BigNumber, utils as ethersUtils } from "ethers";
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
    args: {
      depositor: randomAddress(),
      recipient: randomAddress(),
      inputAmount: BigNumber.from(1_000),
      outputAmount: BigNumber.from(999),
      nested: { deadline: 1234, relayers: [randomAddress()] },
    },
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
    expect(metQuorum).to.be.undefined;

    // The added event should not be returned despite re-adding the same event.
    metQuorum = eventMgr.add(eventTemplate, provider1);
    expect(metQuorum).to.be.undefined;

    // Add same event from another provider; should have quorum now.
    metQuorum = eventMgr.add(eventTemplate, provider2);
    expect(metQuorum).to.deep.equal(eventTemplate);
  });

  it("Drops removed events before quorum", async function () {
    const removed = true;
    expect(quorum).to.equal(2);

    const [provider1, provider2] = providers;

    // Add the event once (not finalised).
    let metQuorum = eventMgr.add(eventTemplate, provider1);
    expect(metQuorum).to.be.undefined;

    let eventQuorum = eventMgr.getEventQuorum(eventKey);
    expect(eventQuorum).to.equal(1);

    // Remove the event after notification by the same provider.
    eventMgr.remove({ ...eventTemplate, removed }, provider1);
    eventQuorum = eventMgr.getEventQuorum(eventKey);
    expect(eventQuorum).to.equal(0);

    // Re-add the same event.
    metQuorum = eventMgr.add(eventTemplate, provider1);
    expect(metQuorum).to.be.undefined;
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
    expect(metQuorum).to.be.undefined;

    // Add the same event from a different provider. Should now meet quorum.
    metQuorum = eventMgr.add(eventTemplate, provider2);
    expect(metQuorum).to.deep.equal(eventTemplate);

    // Re-add the same event again, from two new providers. Does not re-trigger quorum.
    // Verify that the same event was not replayed.
    metQuorum = eventMgr.add(eventTemplate, provider3);
    expect(metQuorum).to.be.undefined;

    metQuorum = eventMgr.add(eventTemplate, provider4);
    expect(metQuorum).to.be.undefined;
  });

  it("Rejects providers that disagree on event arguments", async function () {
    const [provider1, provider2, provider3] = providers;
    expect(quorum).to.equal(2);

    // An event whose on-chain identity is identical, but whose args were tampered with.
    const forgedEvent = {
      ...eventTemplate,
      args: { ...eventTemplate.args, outputAmount: BigNumber.from(1) },
    };
    expect(eventMgr.getEventKey(forgedEvent)).to.equal(eventKey);

    expect(eventMgr.add(eventTemplate, provider1)).to.be.undefined;

    // The forged event matches on identity but not on args, so it must not count towards quorum.
    expect(eventMgr.add(forgedEvent, provider2)).to.be.undefined;
    expect(eventMgr.getEventQuorum(eventKey)).to.equal(1);

    // An honest provider still completes quorum, and the first-seen (untampered) event is relayed.
    expect(eventMgr.add(eventTemplate, provider3)).to.deep.equal(eventTemplate);
  });

  it("Tolerates provider disagreement on non-arg fields and representation", async function () {
    const [provider1, provider2] = providers;
    expect(quorum).to.equal(2);

    // HyperEVM: providers disagree on blockNumber/transactionIndex due to system transactions. They also may
    // present equivalent args differently (bigint vs. BigNumber, hex casing).
    const quirkyEvent = {
      ...eventTemplate,
      blockNumber: blockNumber + 1,
      transactionIndex: eventTemplate.transactionIndex + 1,
      args: {
        ...eventTemplate.args,
        depositor: eventTemplate.args.depositor.toLowerCase(),
        inputAmount: BigInt(eventTemplate.args.inputAmount.toString()),
      },
    };
    expect(eventMgr.getEventKey(quirkyEvent)).to.equal(eventKey);

    expect(eventMgr.add(eventTemplate, provider1)).to.be.undefined;

    // Quorum is met, and the first-seen event (not the last-arriving one) is relayed.
    expect(eventMgr.add(quirkyEvent, provider2)).to.deep.equal(eventTemplate);
  });
});
