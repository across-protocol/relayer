import { _getRefundLeaves } from "../src/dataworker/DataworkerUtils";
import { bnOne, bnZero } from "../src/utils";
import { repaymentChainId } from "./constants";
import { expect, randomAddress } from "./utils";

describe("RelayerRefund utils", function () {
  it("Removes zero value refunds from relayer refund root", async function () {
    const recipient1 = randomAddress();
    const recipient2 = randomAddress();
    const repaymentToken = randomAddress();
    const maxRefundsPerLeaf = 25;
    const result = _getRefundLeaves(
      {
        [recipient1]: bnZero,
        [recipient2]: bnOne,
      },
      bnZero,
      repaymentChainId,
      repaymentToken,
      maxRefundsPerLeaf
    );
    expect(result.length).to.equal(1);
    expect(result[0].refundAddresses.length).to.equal(1);
  });
  it("No more than maxRefundsPerLeaf number of refunds in a leaf", async function () {
    // TODO
  });
  describe("getRefundsFromBundle", function () {
    // TODO
  });
});

describe("SlowFill utils", function () {
  it("Filters out 0-value empty-message slowfills", async function () {
    // TODO
  });
});
