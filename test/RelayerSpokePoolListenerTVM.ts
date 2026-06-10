import { utils as ethersUtils } from "ethers";
import { Log } from "../src/interfaces";
import { reconcileWindow } from "../src/libexec/RelayerSpokePoolListenerTVM";
import { expect, randomAddress } from "./utils";

const randomNumber = (ceil = 1_000_000) => Math.floor(Math.random() * ceil);
const makeHash = () => ethersUtils.id(randomNumber().toString());

function makeEvent(blockNumber: number, blockHash = makeHash()): Log {
  return {
    blockNumber,
    transactionIndex: randomNumber(100),
    logIndex: randomNumber(100),
    transactionHash: makeHash(),
    removed: false,
    address: randomAddress(),
    data: "0x",
    topics: [],
    args: {},
    blockHash,
    event: "FundsDeposited",
  };
}

describe("RelayerSpokePoolListenerTVM: reconcileWindow", function () {
  let posted: Map<string, Log>;

  beforeEach(function () {
    posted = new Map();
  });

  it("Posts newly-seen events and is idempotent on re-scan", function () {
    const event = makeEvent(100);

    let { additions, removals } = reconcileWindow([event], posted, 90);
    expect(additions).to.deep.equal([event]);
    expect(removals).to.be.empty;
    expect(posted.size).to.equal(1);

    // Re-scanning the same window yields no churn.
    ({ additions, removals } = reconcileWindow([event], posted, 90));
    expect(additions).to.be.empty;
    expect(removals).to.be.empty;
  });

  it("Removes events that vanish from the window (re-org)", function () {
    const event = makeEvent(100);
    reconcileWindow([event], posted, 90);

    const { additions, removals } = reconcileWindow([], posted, 90);
    expect(additions).to.be.empty;
    expect(removals).to.deep.equal([event]);
    expect(posted.size).to.equal(0);
  });

  it("Replaces a re-orged event: removes the orphaned hash, adds the canonical one", function () {
    const orphaned = makeEvent(100, "0xold");
    reconcileWindow([orphaned], posted, 90);

    const canonical = makeEvent(100, "0xnew");
    const { additions, removals } = reconcileWindow([canonical], posted, 90);
    expect(removals).to.deep.equal([orphaned]);
    expect(additions).to.deep.equal([canonical]);
    expect(posted.size).to.equal(1);
  });

  it("Prunes events below the window without reporting them as removed", function () {
    const event = makeEvent(50);
    reconcileWindow([event], posted, 40);
    expect(posted.size).to.equal(1);

    // Window advances past the event: it is final (aged out), not a re-org removal.
    const { additions, removals } = reconcileWindow([], posted, 100);
    expect(additions).to.be.empty;
    expect(removals).to.be.empty;
    expect(posted.size).to.equal(0);
  });
});
