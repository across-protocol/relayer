import { expect } from "./utils";

// Tested
import { getPaginatedBlockRanges } from "../src/utils/EventUtils";

describe("EventUtils", async function () {
  it("getPaginatedBlockRanges", async function () {
    expect(getPaginatedBlockRanges({ fromBlock: 0, toBlock: 4, maxBlockLookBack: undefined })).to.deep.equal([[0, 4]]);

    expect(getPaginatedBlockRanges({ fromBlock: 0, toBlock: 4, maxBlockLookBack: 1 })).to.deep.equal([
      [0, 1],
      [2, 3],
      [4, 4],
    ]);

    expect(getPaginatedBlockRanges({ fromBlock: 0, toBlock: 4, maxBlockLookBack: 4 })).to.deep.equal([[0, 4]]);

    expect(getPaginatedBlockRanges({ fromBlock: 0, toBlock: 100, maxBlockLookBack: 50 })).to.deep.equal([
      [0, 50],
      [51, 100],
    ]);
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
