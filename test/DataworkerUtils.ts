import { _buildSlowRelayRoot, _getRefundLeaves } from "../src/dataworker/DataworkerUtils";
import { BundleSlowFills, DepositWithBlock } from "../src/interfaces";
import { BigNumber, bnOne, bnZero, toBNWei, ZERO_ADDRESS } from "../src/utils";
import { repaymentChainId } from "./constants";
import { assert, expect, randomAddress } from "./utils";

describe("RelayerRefund utils", function () {
  it("Removes zero value refunds from relayer refund root", async function () {
    const recipient1 = randomAddress();
    const recipient2 = randomAddress();
    const repaymentToken = randomAddress();
    const maxRefundsPerLeaf = 2;
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
    const recipient1 = randomAddress();
    const recipient2 = randomAddress();
    const repaymentToken = randomAddress();
    const amountToReturn = bnOne;
    const maxRefundsPerLeaf = 1;
    const result = _getRefundLeaves(
      {
        [recipient1]: bnOne,
        [recipient2]: bnOne,
      },
      amountToReturn,
      repaymentChainId,
      repaymentToken,
      maxRefundsPerLeaf
    );
    expect(result.length).to.equal(2);
    // Only the first leaf should have an amount to return.
    expect(result[0].groupIndex).to.equal(0);
    expect(result[0].amountToReturn).to.equal(amountToReturn);
    expect(result[1].groupIndex).to.equal(1);
    expect(result[1].amountToReturn).to.equal(0);
  });
  it("Sorts refunds by amount in descending order", async function () {
    const recipient1 = randomAddress();
    const recipient2 = randomAddress();
    const repaymentToken = randomAddress();
    const maxRefundsPerLeaf = 2;
    const result = _getRefundLeaves(
      {
        [recipient1]: bnOne,
        [recipient2]: bnOne.mul(2),
      },
      bnZero,
      repaymentChainId,
      repaymentToken,
      maxRefundsPerLeaf
    );
    expect(result.length).to.equal(1);
    expect(result[0].refundAddresses[0]).to.equal(recipient2);
    expect(result[0].refundAddresses[1]).to.equal(recipient1);
  });
});

describe("SlowFill utils", function () {
  /**
   * @notice Returns dummy slow fill leaf that you can insert into a BundleSlowFills object.
   * @dev The leaf returned will not actually be executable so its good for testing functions
   * that produce but do not execute merkle leaves.
   * @param depositId This is used to sort slow fill leaves so allow caller to set.
   * @param amountToFill This will be set to the deposit's inputAmount because the slow fill pays out
   * inputAmount * (1 - lpFeePct).
   * @param lpFeePct Amount to charge on the amountToFill.
   * @param message 0-value, empty-message slow fills should be ignored by dataworker so allow caller
   * to set this to non-empty to test logic.
   * @param originChainId This is used to sort slow fill leaves so allow caller to set.
   */

  function createSlowFillLeaf(
    depositId: number,
    originChainId: number,
    amountToFill: BigNumber,
    message: string,
    _lpFeePct: BigNumber
  ): DepositWithBlock & { lpFeePct: BigNumber } {
    assert(message.slice(0, 2) === "0x", "Need to specify message beginning with 0x");
    const destinationChainId = originChainId + 1;
    const deposit: DepositWithBlock = {
      inputAmount: amountToFill,
      inputToken: randomAddress(),
      outputAmount: bnOne,
      outputToken: randomAddress(),
      depositor: randomAddress(),
      depositId: BigNumber.from(depositId),
      originChainId: 1,
      recipient: randomAddress(),
      exclusiveRelayer: ZERO_ADDRESS,
      exclusivityDeadline: 0,
      message,
      destinationChainId,
      fillDeadline: 0,
      quoteBlockNumber: 0,
      blockNumber: 0,
      transactionHash: "",
      logIndex: 0,
      transactionIndex: 0,
      quoteTimestamp: 0,
      fromLiteChain: false,
      toLiteChain: false,
    };
    return {
      ...deposit,
      lpFeePct: _lpFeePct,
    };
  }
  it("Filters out 0-value empty-message slowfills", async function () {
    const zeroValueSlowFillLeaf = createSlowFillLeaf(0, 1, bnZero, "0x", bnZero);
    const oneWeiSlowFillLeaf = createSlowFillLeaf(1, 1, bnOne, "0x", bnZero);
    const zeroValueNonEmptyMessageSlowFillLeaf = createSlowFillLeaf(2, 1, bnZero, "0x12", bnZero);
    const bundleSlowFills: BundleSlowFills = {
      [zeroValueSlowFillLeaf.destinationChainId]: {
        [zeroValueSlowFillLeaf.outputToken]: [
          zeroValueSlowFillLeaf,
          oneWeiSlowFillLeaf,
          zeroValueNonEmptyMessageSlowFillLeaf,
        ],
      },
    };

    // Should return two out of three leaves, sorted by deposit ID.
    const { leaves } = _buildSlowRelayRoot(bundleSlowFills);
    expect(leaves.length).to.equal(2);
    expect(leaves[0].relayData.depositId).to.equal(1);
    expect(leaves[1].relayData.depositId).to.equal(2);
  });
  it("Applies LP fee to input amount", async function () {
    const slowFillLeaf = createSlowFillLeaf(0, 1, toBNWei("4"), "0x", toBNWei("0.25"));
    const bundleSlowFills: BundleSlowFills = {
      [slowFillLeaf.destinationChainId]: {
        [slowFillLeaf.outputToken]: [slowFillLeaf],
      },
    };

    // Should return two out of three leaves, sorted by deposit ID.
    const { leaves } = _buildSlowRelayRoot(bundleSlowFills);
    expect(leaves.length).to.equal(1);
    // updatedOutputAmount should be equal to inputAmount * (1 - lpFee) so 4 * (1 - 0.25) = 3
    expect(leaves[0].updatedOutputAmount).to.equal(toBNWei("3"));
  });
});
