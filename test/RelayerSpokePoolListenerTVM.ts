import { utils as ethersUtils } from "ethers";
import { Block } from "viem";
import { CHAIN_IDs } from "@across-protocol/constants";
import { Log } from "../src/interfaces";
import { EventManager } from "../src/utils";
import { processBlock } from "../src/libexec/RelayerSpokePoolListenerTVM";
import { createSpyLogger, expect, randomAddress } from "./utils";

const randomNumber = (ceil = 1_000_000) => Math.floor(Math.random() * ceil);
const makeHash = () => ethersUtils.id(randomNumber().toString());

function makeBlock(number: number, hash: string, parentHash: string): Block {
  return { number: BigInt(number), hash, parentHash, timestamp: 1_000_000n } as Block;
}

function makeEvent(blockNumber: number, blockHash: string): Log {
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
    event: "TestEvent",
  };
}

describe("RelayerSpokePoolListenerTVM: processBlock re-org detection", function () {
  const chainId = CHAIN_IDs.MAINNET;
  const chain = "mainnet";
  const provider = "mock";

  let blocks: Map<bigint, string>;
  let eventMgr: EventManager;
  let logger: ReturnType<typeof createSpyLogger>["spyLogger"];

  beforeEach(function () {
    ({ spyLogger: logger } = createSpyLogger());
    blocks = new Map();
    eventMgr = new EventManager(logger, chainId, 1);
  });

  it("Tracks a canonical chain without ejecting events", function () {
    const h0 = makeHash();
    const h1 = makeHash();

    const r0 = processBlock(makeBlock(100, h0, makeHash()), blocks, eventMgr, chain, provider, logger);
    const r1 = processBlock(makeBlock(101, h1, h0), blocks, eventMgr, chain, provider, logger);
    const r2 = processBlock(makeBlock(102, makeHash(), h1), blocks, eventMgr, chain, provider, logger);

    expect(r0.accepted && r1.accepted && r2.accepted).to.be.true;
    expect([r0, r1, r2].flatMap((r) => r.orphans)).to.be.empty;
    expect(blocks.size).to.equal(3);
  });

  it("Ignores empty or null-hash blocks", function () {
    const { accepted, orphans } = processBlock(
      makeBlock(100, null as unknown as string, makeHash()),
      blocks,
      eventMgr,
      chain,
      provider,
      logger
    );
    expect(accepted).to.be.false;
    expect(orphans).to.be.empty;
    expect(blocks.size).to.equal(0);
  });

  it("Gap between blocks does not trigger a re-org", function () {
    const h100 = makeHash();
    processBlock(makeBlock(100, h100, makeHash()), blocks, eventMgr, chain, provider, logger);

    const event100 = makeEvent(100, h100);
    eventMgr.add(event100, provider);

    const { orphans } = processBlock(makeBlock(102, makeHash(), makeHash()), blocks, eventMgr, chain, provider, logger);

    expect(orphans).to.be.empty;
    expect(eventMgr.findEvent(eventMgr.hashEvent(event100))).to.exist;
  });

  it("Parent-hash mismatch ejects orphaned events", function () {
    const h100 = makeHash();
    const h101 = makeHash();

    processBlock(makeBlock(100, h100, makeHash()), blocks, eventMgr, chain, provider, logger);
    processBlock(makeBlock(101, h101, h100), blocks, eventMgr, chain, provider, logger);

    const event101 = makeEvent(101, h101);
    eventMgr.add(event101, provider);

    // Block 102 claims hash100 as its parent → fork point at 100, block 101 orphaned.
    const { orphans } = processBlock(makeBlock(102, makeHash(), h100), blocks, eventMgr, chain, provider, logger);

    expect(orphans).to.have.lengthOf(1);
    expect(orphans[0].blockNumber).to.equal(101);
    expect(eventMgr.findEvent(eventMgr.hashEvent(event101))).to.not.exist;
    expect(blocks.has(101n)).to.be.false;
    expect(blocks.has(102n)).to.be.true;
  });

  it("Deep re-org (fork point outside window) purges the whole tracked window", function () {
    const h100 = makeHash();
    const h101 = makeHash();
    const h102 = makeHash();

    processBlock(makeBlock(100, h100, makeHash()), blocks, eventMgr, chain, provider, logger);
    processBlock(makeBlock(101, h101, h100), blocks, eventMgr, chain, provider, logger);
    processBlock(makeBlock(102, h102, h101), blocks, eventMgr, chain, provider, logger);

    const events = [makeEvent(100, h100), makeEvent(101, h101), makeEvent(102, h102)];
    events.forEach((e) => eventMgr.add(e, provider));

    // Block 103's parentHash is completely unknown → deep re-org, purge all.
    const { orphans } = processBlock(makeBlock(103, makeHash(), makeHash()), blocks, eventMgr, chain, provider, logger);

    expect(orphans.map((e) => e.blockNumber).sort()).to.deep.equal([100, 101, 102]);
    expect(blocks.size).to.equal(1);
    expect(blocks.has(103n)).to.be.true;
  });

  it("Prunes the block tracker beyond the re-org window", function () {
    let prev = makeHash();
    for (let i = 0; i < 135; i++) {
      const hash = makeHash();
      processBlock(makeBlock(i, hash, prev), blocks, eventMgr, chain, provider, logger);
      prev = hash;
    }

    expect(blocks.has(0n)).to.be.false;
    expect(blocks.has(134n)).to.be.true;
    expect(blocks.size).to.be.at.most(129);
  });
});
