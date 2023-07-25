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
  beforeEach(async function () {
    originToken = randomAddress();

    config = new MockUBAConfig();
  });
  it("getUbaRewardMultiplier", async function () {
    config = new MockUBAConfig();
    // Default should be 1
    expect(config.getUbaRewardMultiplier("999")).to.equal(toBNWei("1"));
  });
  it("getIncentivePoolAdjustment", async function () {
    config = new MockUBAConfig();
    // Default should be 0
    expect(config.getIncentivePoolAdjustment("999")).to.equal(0);
  });
  describe("getTotalSpokeTargetBalanceForComputingLpFee", function () {
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

  describe("getBaselineFee", function () {
    it("No baseline fee exists. Use hardcoded zero", function () {
      expect(config.getBaselineFee(-5, -10)).to.equal(toBNWei("0"));
    });
    it("Should defer to a default if that is defined", function () {
      config.setBaselineFee(-5, -10, toBNWei("100"), true);
      expect(config.getBaselineFee(1, 10)).to.equal(toBNWei("100"));
    });
    it("Should defer to a specific fee if that is defined", function () {
      config.setBaselineFee(0, 1, toBNWei("100"), true);
      config.setBaselineFee(5, 10, toBNWei("101"));
      expect(config.getBaselineFee(5, 10)).to.equal(toBNWei("101"));
    });
  });

  describe("getBalanceTriggerThreshold", function () {
    const chainId = 1;
    const tokenSymbol = "ETH";
    it("No balance trigger threshold exists. Use default", function () {
      config.setDefaultBalanceTriggerThreshold({
        upperBound: {},
        lowerBound: {
          threshold: toBNWei("100000"),
        },
      });
      expect(config.getBalanceTriggerThreshold(chainId, tokenSymbol + "Wrong")).to.be.deep.equal({
        upperBound: {},
        lowerBound: {
          threshold: toBNWei("100000"),
        },
      });
    });
    it("Should defer to a specific fee if that is defined", function () {
      config.setBalanceTriggerThreshold(chainId, tokenSymbol, {
        upperBound: {
          target: toBNWei("100"),
        },
        lowerBound: {},
      });
      expect(config.getBalanceTriggerThreshold(chainId, tokenSymbol)).to.be.deep.equal({
        upperBound: {
          target: toBNWei("100"),
        },
        lowerBound: {},
      });
    });
  });

  describe("getLpGammaFunctionTuples", function () {
    it("No lp gamma function tuples exist. Use default", function () {
      config.setDefaultLpGammaFunctionTuples([[toBNWei("100"), toBNWei("100")]]);
      expect(config.getLpGammaFunctionTuples(2)).to.be.deep.equal([[toBNWei("100"), toBNWei("100")]]);
    });
    it("Should defer to a specific fee if that is defined", function () {
      config.setLpGammaFunctionTuples(2, [[toBNWei("100"), toBNWei("100")]]);
      expect(config.getLpGammaFunctionTuples(2)).to.be.deep.equal([[toBNWei("100"), toBNWei("100")]]);
    });
  });

  describe("getBalancingFeeTuples", function () {
    it("getZeroFeePointOnBalancingFeeCurve", async function () {
      config.setBalancingFeeTuple(originChainId, [
        [toBNWei("1"), toBNWei("0")],
        [toBNWei("2"), toBNWei("1")],
      ]);
      expect(config.getZeroFeePointOnBalancingFeeCurve(originChainId)).to.equal(toBNWei("1"));
    });
    it("isBalancingFeeCurveFlatAtZero", async function () {
      config.setBalancingFeeTuple(originChainId, [[toBNWei("1"), toBNWei("0")]]);
      expect(config.isBalancingFeeCurveFlatAtZero(originChainId)).to.be.false;
      expect(config.isBalancingFeeCurveFlatAtZero(destinationChainId)).to.be.true;
    })
    it("No balancing fee tuples exist. Use default", function () {
      config.setDefaultBalancingFeeTuple([[toBNWei("100"), toBNWei("100")]]);
      expect(config.getBalancingFeeTuples(2)).to.be.deep.equal([[toBNWei("100"), toBNWei("100")]]);
    });
    it("Should defer to a specific fee if that is defined", function () {
      config.setBalancingFeeTuple(2, [[toBNWei("100"), toBNWei("100")]]);
      expect(config.getBalancingFeeTuples(2)).to.be.deep.equal([[toBNWei("100"), toBNWei("100")]]);
    });
  });

  describe("getTargetBalance", function () {
    const chainId = 1;
    const tokenSymbol = "ETH";
    it("No target balance exists. Use default", function () {
      config.setDefaultTargetBalance(toBNWei("100"));
      expect(config.getTargetBalance(chainId, tokenSymbol)).to.be.deep.equal(toBNWei("100"));
    });
    it("Should defer to a specific fee if that is defined", function () {
      config.setTargetBalance(chainId, tokenSymbol, toBNWei("100"));
      expect(config.getTargetBalance(chainId, tokenSymbol)).to.be.deep.equal(toBNWei("100"));
    });
  });
});
