import { toBNWei } from "./utils";
import { randomAddress, expect } from "./constants";
import { constants } from "@across-protocol/sdk-v2";
import { MockUBAConfig } from "./mocks/MockUBAConfig";

let originToken: string;
let config: MockUBAConfig;

const originChainId = 10;
const destinationChainId = 137;
const hubPoolChainId = constants.HUBPOOL_CHAIN_ID;

describe("UBAFeeConfig", async function () {
  describe("getTotalSpokeTargetBalanceForComputingLpFee", function () {
    beforeEach(async function () {
      originToken = randomAddress();

      config = new MockUBAConfig();
    });
    it("No lower bound", async function () {
      config.setBalanceTriggerThreshold(originChainId, originToken, {
        upperBound: {
          threshold: toBNWei("5000"),
          target: toBNWei("10"),
        },
        lowerBound: {},
      });
      config.setBalanceTriggerThreshold(destinationChainId, originToken, {
        upperBound: {
          threshold: toBNWei("5000"),
          target: toBNWei("10"),
        },
        lowerBound: {},
      });
      config.setBalanceTriggerThreshold(hubPoolChainId, originToken, {
        upperBound: {
          threshold: toBNWei("5000"),
          target: toBNWei("10"),
        },
        lowerBound: {},
      });
      expect(config.getTotalSpokeTargetBalanceForComputingLpFee(originToken)).to.equal(toBNWei("30"));
    });
    it("No upper bound", async function () {
      config.setBalanceTriggerThreshold(originChainId, originToken, {
        upperBound: {},
        lowerBound: {},
      });
      expect(config.getTotalSpokeTargetBalanceForComputingLpFee(originToken)).to.equal(toBNWei("0"));
    });
  });
});
