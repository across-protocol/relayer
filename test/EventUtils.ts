import { expect } from "./utils";

// Tested
import { getPaginatedBlockRanges, getUniqueLogIndex } from "../src/utils/EventUtils";

describe("EventUtils", async function () {
  it("getPaginatedBlockRanges", async function () {
    // Undefined lookback returns full range
    expect(getPaginatedBlockRanges({ from: 0, to: 4, maxLookBack: undefined })).to.deep.equal([[0, 4]]);

    // zero lookback throws error
    expect(() => getPaginatedBlockRanges({ from: 0, to: 4, maxLookBack: 0 })).to.throw();

    // to > from returns an empty array.
    expect(getPaginatedBlockRanges({ from: 5, to: 4, maxLookBack: 2 })).to.deep.equal([]);

    // Lookback larger than range returns full range
    expect(getPaginatedBlockRanges({ from: 0, to: 4, maxLookBack: 6 })).to.deep.equal([[0, 4]]);

    // Range of 0 returns a range that covers both the from and to as expected.
    expect(getPaginatedBlockRanges({ from: 1, to: 1, maxLookBack: 3 })).to.deep.equal([[0, 1]]);

    // Range of 0 returns a range that covers both the from and to as expected.
    expect(getPaginatedBlockRanges({ from: 3, to: 3, maxLookBack: 3 })).to.deep.equal([[3, 3]]);

    // Lookback of 1
    expect(getPaginatedBlockRanges({ from: 0, to: 4, maxLookBack: 2 })).to.deep.equal([
      [0, 1],
      [2, 3],
      [4, 4],
    ]);

    // Lookback equal to range returns full range
    expect(getPaginatedBlockRanges({ from: 0, to: 4, maxLookBack: 5 })).to.deep.equal([[0, 4]]);

    // Range evenly divided by max block lookback:
    expect(getPaginatedBlockRanges({ from: 0, to: 100, maxLookBack: 50 })).to.deep.equal([
      [0, 49],
      [50, 99],
      [100, 100],
    ]);

    // Range divided by max block lookback with remainder:
    expect(getPaginatedBlockRanges({ from: 0, to: 100, maxLookBack: 30 })).to.deep.equal([
      [0, 29],
      [30, 59],
      [60, 89],
      [90, 100],
    ]);

    // Range divided by max block lookback with remainder:
    expect(getPaginatedBlockRanges({ from: 172, to: 200, maxLookBack: 12 })).to.deep.equal([
      [168, 179],
      [180, 191],
      [192, 200],
    ]);

    // Consistent range (for caching purposes) for many sub-ranges
    for (let i = 0; i < 1000; i++) {
      const start = Math.floor(Math.random() * 100 + 100);
      expect(getPaginatedBlockRanges({ from: start, to: 199, maxLookBack: 100 })).to.deep.equal([[100, 199]]);
    }
  });
  it("getUniqueLogIndex", async function () {
    const events = [
      {
        txnRef: "0x1",
      },
      {
        txnRef: "0x1",
      },
      {
        txnRef: "0x2",
      },
      {
        txnRef: "0x3",
      },
    ];
    expect(getUniqueLogIndex(events)).to.deep.equal([0, 1, 0, 0]);
  });
});
