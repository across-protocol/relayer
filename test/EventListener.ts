import { utils as ethersUtils } from "ethers";
import { Block } from "viem";
import { CHAIN_IDs } from "@across-protocol/constants";
import { Log } from "../src/interfaces";
import { EventListener } from "../src/clients/EventListener";
import { EventManager } from "../src/utils";
import { createSpyLogger, expect, sinon } from "./utils";

type OnBlockCallback = (block: Block) => void;

// Minimal mock provider with a watchBlocks that captures the onBlock callback.
function createMockProvider(): { watchBlocks: sinon.SinonStub; name: string; capturedOnBlock: () => OnBlockCallback } {
  let _onBlock: OnBlockCallback | undefined;
  const watchBlocks = sinon.stub().callsFake(({ onBlock }: { onBlock: OnBlockCallback }) => {
    _onBlock = onBlock;
    return () => {}; // unwatch fn
  });

  return {
    watchBlocks,
    name: "mock",
    capturedOnBlock: () => {
      if (!_onBlock) {
        throw new Error("onBlock not yet captured — call listener.onBlock() first");
      }
      return _onBlock;
    },
  };
}

// Expose protected fields for test assertions without (as any) casts.
class TestableEventListener extends EventListener {
  get testBlocks(): Map<bigint, string> {
    return this.blocks;
  }
  get testEventMgr(): EventManager {
    return this.eventMgr;
  }
  get testTvmBlocks(): { [provider: string]: bigint } {
    return this.tvmBlocks;
  }
}

// `providers` is private on EventListener; this narrow cast is the one isolation point.
function injectProviders(listener: EventListener, providers: ReturnType<typeof createMockProvider>[]): void {
  (listener as unknown as { providers: unknown }).providers = providers;
}

function makeBlock(number: number, hash: string, parentHash: string, timestamp = 1_000_000): Block {
  return { number: BigInt(number), hash, parentHash, timestamp: BigInt(timestamp) } as Block;
}

const randomNumber = (ceil = 1_000_000) => Math.floor(Math.random() * ceil);
const makeHash = () => ethersUtils.id(randomNumber().toString());

function makeEvent(blockNumber: number, blockHash: string): Log {
  return {
    blockNumber,
    transactionIndex: randomNumber(100),
    logIndex: randomNumber(100),
    transactionHash: makeHash(),
    removed: false,
    address: "0x" + "ab".repeat(20),
    data: "0x",
    topics: [],
    args: {},
    blockHash,
    event: "TestEvent",
  };
}

describe("EventListener: Re-org Detection", function () {
  const chainId = CHAIN_IDs.MAINNET;

  // Env vars required by resolveProviders (overridden to avoid real network access).
  const envOverrides: Record<string, string> = {
    [`RPC_PROVIDERS_TRANSPORT_${chainId}`]: "https",
    [`RPC_PROVIDERS_${chainId}`]: "mock",
    [`RPC_PROVIDER_mock_${chainId}`]: "http://localhost:1",
  };

  let savedEnv: Record<string, string | undefined>;
  let listener: TestableEventListener;
  let mockProvider: ReturnType<typeof createMockProvider>;
  let feedBlock: OnBlockCallback;

  beforeEach(function () {
    // Save and set env vars.
    savedEnv = {};
    for (const [key, value] of Object.entries(envOverrides)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }

    const { spyLogger } = createSpyLogger();
    listener = new TestableEventListener(chainId, spyLogger, 1);

    // Replace providers with a mock.
    mockProvider = createMockProvider();
    injectProviders(listener, [mockProvider]);

    // Trigger watchBlocks and capture the onBlock callback.
    listener.onBlock(() => {});
    feedBlock = mockProvider.capturedOnBlock();
  });

  afterEach(function () {
    // Restore env vars.
    for (const [key, original] of Object.entries(savedEnv)) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    sinon.restore();
    listener.removeAllListeners();
  });

  it("Normal sequence emits blocks", function () {
    const emitted: number[] = [];
    listener.on("block", (n: number) => emitted.push(n));

    const hash100 = makeHash();
    const hash101 = makeHash();
    const hash102 = makeHash();

    feedBlock(makeBlock(100, hash100, makeHash()));
    feedBlock(makeBlock(101, hash101, hash100));
    feedBlock(makeBlock(102, hash102, hash101));

    expect(emitted).to.deep.equal([100, 101, 102]);
  });

  it("First block accepted without re-org", function () {
    const reorgs: unknown[] = [];
    listener.on("TestEvent", (e: Log) => {
      if (e.removed) {
        reorgs.push(e);
      }
    });

    feedBlock(makeBlock(100, makeHash(), makeHash()));

    expect(reorgs).to.be.empty;
  });

  it("Parent hash mismatch triggers re-org", function () {
    const hash100 = makeHash();
    const hash101 = makeHash();

    feedBlock(makeBlock(100, hash100, makeHash()));
    feedBlock(makeBlock(101, hash101, hash100));

    // Block 102 claims a parentHash that doesn't match hash101.
    const emitted: number[] = [];
    listener.on("block", (n: number) => emitted.push(n));

    feedBlock(makeBlock(102, makeHash(), makeHash()));

    // Block 102 should still be emitted (re-org handling doesn't suppress the new block).
    expect(emitted).to.include(102);
    // Block 102 is the new tip (re-added after re-org handling).
    expect(listener.testBlocks.has(102n)).to.be.true;
  });

  it("Gap does not trigger re-org", function () {
    const hash100 = makeHash();
    feedBlock(makeBlock(100, hash100, makeHash()));

    // Add event at block 100 to verify it's not ejected by a false re-org.
    const event100 = makeEvent(100, hash100);
    listener.testEventMgr.add(event100, "mock");

    // Skip block 101 entirely; feed block 102. Gap alone should not trigger re-org.
    feedBlock(makeBlock(102, makeHash(), makeHash()));

    // Event at block 100 should still exist (no re-org triggered).
    expect(listener.testEventMgr.findEvent(listener.testEventMgr.hashEvent(event100))).to.exist;
    // Block 102 should be tracked.
    expect(listener.testBlocks.has(102n)).to.be.true;
  });

  it("Re-org ejects events and re-emits with removed:true", function () {
    const hash100 = makeHash();
    const hash101 = makeHash();

    feedBlock(makeBlock(100, hash100, makeHash()));
    feedBlock(makeBlock(101, hash101, hash100));

    // Inject events at block 101 directly into EventManager.
    const event101 = makeEvent(101, hash101);
    listener.testEventMgr.add(event101, "mock");

    // Collect re-emitted events.
    const removedEvents: Log[] = [];
    listener.on("TestEvent", (e: Log) => {
      if (e.removed) {
        removedEvents.push(e);
      }
    });

    // Feed block 102 whose parentHash points at hash100 (skipping 101) → fork point at 100.
    feedBlock(makeBlock(102, makeHash(), hash100));

    // The event at block 101 should have been ejected and re-emitted with removed:true.
    expect(removedEvents).to.have.lengthOf(1);
    expect(removedEvents[0].blockNumber).to.equal(101);
    expect(removedEvents[0].removed).to.be.true;
  });

  it("Re-org resets TVM poller high-water marks", function () {
    const hash100 = makeHash();
    const hash101 = makeHash();

    feedBlock(makeBlock(100, hash100, makeHash()));
    feedBlock(makeBlock(101, hash101, hash100));

    // Set up TVM poller state above the fork point.
    listener.testTvmBlocks["mock"] = 101n;

    // Feed block 102 whose parentHash points at hash100 → fork point at 100.
    feedBlock(makeBlock(102, makeHash(), hash100));

    // tvmBlocks entry should be reset to the fork point (100).
    expect(Number(listener.testTvmBlocks["mock"])).to.equal(100);
  });

  it("Re-org at block 0 fork point", function () {
    const hash0 = makeHash();
    const hash1 = makeHash();

    feedBlock(makeBlock(0, hash0, makeHash()));
    feedBlock(makeBlock(1, hash1, hash0));

    // Add event at block 1.
    const event1 = makeEvent(1, hash1);
    listener.testEventMgr.add(event1, "mock");

    const removedEvents: Log[] = [];
    listener.on("TestEvent", (e: Log) => {
      if (e.removed) {
        removedEvents.push(e);
      }
    });

    // Feed block 2 whose parentHash points at hash0 → fork point at 0.
    feedBlock(makeBlock(2, makeHash(), hash0));

    // Event at block 1 should be ejected (1 > fork point 0).
    expect(removedEvents).to.have.lengthOf(1);
    expect(removedEvents[0].blockNumber).to.equal(1);
  });

  describe("Deep re-org (fork point outside tracking window)", function () {
    it("Uses highest observed block as fork point", function () {
      // Build a chain up to block 102.
      const hash100 = makeHash();
      const hash101 = makeHash();
      const hash102 = makeHash();

      feedBlock(makeBlock(100, hash100, makeHash()));
      feedBlock(makeBlock(101, hash101, hash100));
      feedBlock(makeBlock(102, hash102, hash101));

      // Inject an event at block 103 directly into EventManager (simulates an event
      // that arrived via watchEvent but whose block was never tracked in the blocks map).
      const event103 = makeEvent(103, makeHash());
      listener.testEventMgr.add(event103, "mock");

      // Feed block 103 with a parentHash that doesn't match hash102 and isn't in our window.
      // This triggers handleReorg (parent hash mismatch at block 102), but the parentHash
      // search inside handleReorg fails → falls back to highest observed block (102).
      const removedEvents: Log[] = [];
      listener.on("TestEvent", (e: Log) => {
        if (e.removed) {
          removedEvents.push(e);
        }
      });

      feedBlock(makeBlock(103, makeHash(), makeHash()));

      // Event at 103 must have been ejected (103 > fork point 102).
      expect(removedEvents).to.have.lengthOf(1);
      expect(removedEvents[0].blockNumber).to.equal(103);
    });

    it("Preserves events at and below highest observed block", function () {
      const hash100 = makeHash();
      const hash101 = makeHash();
      const hash102 = makeHash();

      feedBlock(makeBlock(100, hash100, makeHash()));
      feedBlock(makeBlock(101, hash101, hash100));
      feedBlock(makeBlock(102, hash102, hash101));

      // Add events at blocks 101 and 102.
      const event101 = makeEvent(101, hash101);
      const event102 = makeEvent(102, hash102);
      listener.testEventMgr.add(event101, "mock");
      listener.testEventMgr.add(event102, "mock");

      // Deep re-org: block 103 with parentHash not matching hash102.
      feedBlock(makeBlock(103, makeHash(), makeHash()));

      // Fork point is 102 (highest observed). removeAbove(102) keeps events at <= 102.
      const hash101Event = listener.testEventMgr.hashEvent(event101);
      const hash102Event = listener.testEventMgr.hashEvent(event102);
      expect(listener.testEventMgr.findEvent(hash101Event)).to.exist;
      expect(listener.testEventMgr.findEvent(hash102Event)).to.exist;
    });

    it("Resets TVM marks above highest observed block", function () {
      const hash100 = makeHash();
      const hash101 = makeHash();

      feedBlock(makeBlock(100, hash100, makeHash()));
      feedBlock(makeBlock(101, hash101, hash100));

      // One provider's mark is above the highest observed (101); another is at-or-below.
      listener.testTvmBlocks["provider-above"] = 105n;
      listener.testTvmBlocks["provider-at-or-below"] = 100n;

      // Block 102 with parentHash not matching hash101 → deep re-org, fork at 101.
      feedBlock(makeBlock(102, makeHash(), makeHash()));

      // Mark above fork point (101) should be reset to 101.
      expect(Number(listener.testTvmBlocks["provider-above"])).to.equal(101);
      // Mark at or below fork point should be untouched.
      expect(Number(listener.testTvmBlocks["provider-at-or-below"])).to.equal(100);
    });

    it("Prunes tracked blocks above highest observed", function () {
      const hash100 = makeHash();
      const hash101 = makeHash();
      const hash102 = makeHash();

      feedBlock(makeBlock(100, hash100, makeHash()));
      feedBlock(makeBlock(101, hash101, hash100));
      feedBlock(makeBlock(102, hash102, hash101));

      // Block 103 with parentHash not matching hash102 → deep re-org, fork at 102.
      feedBlock(makeBlock(103, makeHash(), makeHash()));

      // Blocks 100-102 should be retained (at or below fork point 102).
      expect(listener.testBlocks.has(100n)).to.be.true;
      expect(listener.testBlocks.has(101n)).to.be.true;
      expect(listener.testBlocks.has(102n)).to.be.true;
      // Block 103 is set after handleReorg returns, so it should be present.
      expect(listener.testBlocks.has(103n)).to.be.true;
      expect(listener.testBlocks.size).to.equal(4);
    });
  });

  it("Block chain pruning at 128 blocks", function () {
    // Feed 130+ blocks with correct parent chain.
    let prevHash = makeHash();
    for (let i = 0; i < 135; i++) {
      const hash = makeHash();
      feedBlock(makeBlock(i, hash, prevHash));
      prevHash = hash;
    }

    // Early blocks should have been pruned. Block 0 should not be present.
    expect(listener.testBlocks.has(0n)).to.be.false;
    // Recent blocks should still be present.
    expect(listener.testBlocks.has(134n)).to.be.true;
    // Should not exceed 129 entries (current block + 128 preceding).
    expect(listener.testBlocks.size).to.be.at.most(129);
  });

  it("Empty/null block hash is ignored", function () {
    const emitted: number[] = [];
    listener.on("block", (n: number) => emitted.push(n));

    feedBlock(makeBlock(100, null as unknown as string, makeHash()));

    // Should not emit a "block" event when hash is null.
    expect(emitted).to.be.empty;
  });
});
