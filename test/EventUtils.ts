import { expect } from "./utils";

// Tested
import { getPaginatedBlockRanges } from "../src/utils/EventUtils";

describe("EventUtils", async function () {
  it("getPaginatedBlockRanges", async function () {
    // Undefined lookback returns full range
    expect(getPaginatedBlockRanges({ fromBlock: 0, toBlock: 4, maxBlockLookBack: undefined })).to.deep.equal([[0, 4]]);

    // zero lookback throws error
    expect(() => getPaginatedBlockRanges({ fromBlock: 0, toBlock: 4, maxBlockLookBack: 0 })).to.throw();

    // Lookback larger than range returns full range
    expect(getPaginatedBlockRanges({ fromBlock: 0, toBlock: 4, maxBlockLookBack: 5 })).to.deep.equal([[0, 4]]);

    // Range of 0 returns block with fromBlock == toBlock
    expect(getPaginatedBlockRanges({ fromBlock: 1, toBlock: 1, maxBlockLookBack: 2 })).to.deep.equal([[1, 1]]);

    // Lookback of 1
    expect(getPaginatedBlockRanges({ fromBlock: 0, toBlock: 4, maxBlockLookBack: 1 })).to.deep.equal([
      [0, 1],
      [2, 3],
      [4, 4],
    ]);

    // Lookback equal to range returns full range
    expect(getPaginatedBlockRanges({ fromBlock: 0, toBlock: 4, maxBlockLookBack: 4 })).to.deep.equal([[0, 4]]);

    // Range evenly divided by max block lookback:
    expect(getPaginatedBlockRanges({ fromBlock: 0, toBlock: 100, maxBlockLookBack: 50 })).to.deep.equal([
      [0, 50],
      [51, 100],
    ]);

    // Range divided by max block lookback with remainder:
    expect(getPaginatedBlockRanges({ fromBlock: 0, toBlock: 100, maxBlockLookBack: 30 })).to.deep.equal([
      [0, 30],
      [31, 61],
      [62, 92],
      [93, 100],
    ]);
  });
});
