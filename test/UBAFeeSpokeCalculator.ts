import { toBNWei } from "./utils";
import { randomAddress, createRandomBytes32, expect, toBN, BigNumber } from "./constants";
import { DepositWithBlock, FillWithBlock, UbaFlow, UbaInflow, UbaOutflow } from "../src/interfaces";
import { ubaFeeCalculator } from "@across-protocol/sdk-v2";
import { MockUBAConfig } from "./mocks/MockUBAConfig";

let originToken: string, destinationToken: string;
let depositor: string, recipient: string;
let deposit: DepositWithBlock, fill: FillWithBlock;
let config: MockUBAConfig;

const originChainId = 10;
const destinationChainId = 42161;
const tokenSymbol = "L1";
const lastValidatedRunningBalance = toBNWei("100");
const lastValidatedIncentiveRunningBalance = toBNWei("10");
const startingNetRunningBalanceAdjustment = toBNWei("0");

describe("UBAFeeSpokeCalculator", function () {
  describe("Analog", function () {
    beforeEach(function () {
      depositor = randomAddress();
      recipient = randomAddress();
      originToken = randomAddress();
      destinationToken = randomAddress();

      deposit = {
        depositId: 0,
        depositor,
        recipient,
        originToken,
        amount: toBNWei("1"),
        originChainId,
        destinationChainId,
        relayerFeePct: toBNWei("0.1"),
        quoteTimestamp: 100,
        realizedLpFeePct: toBNWei("0.1"),
        destinationToken,
        message: "0x",
        quoteBlockNumber: 200,
        blockNumber: 200,
        blockTimestamp: 10,
        transactionIndex: 0,
        logIndex: 0,
        transactionHash: createRandomBytes32(),
      };
      fill = {
        amount: toBNWei("2"),
        totalFilledAmount: toBNWei("2"),
        fillAmount: toBNWei("2"),
        repaymentChainId: destinationChainId,
        originChainId,
        destinationChainId,
        relayerFeePct: toBNWei("0.1"),
        realizedLpFeePct: toBNWei("0.1"),
        depositId: 0,
        destinationToken,
        relayer: depositor,
        depositor,
        recipient,
        message: "0x",
        updatableRelayData: {
          recipient,
          message: "0x",
          relayerFeePct: toBNWei("0.1"),
          isSlowRelay: false,
          payoutAdjustmentPct: toBNWei("0"),
        },
        blockNumber: 200,
        blockTimestamp: 10,
        transactionIndex: 0,
        logIndex: 0,
        transactionHash: createRandomBytes32(),
      };

      config = new MockUBAConfig();
      // Set a curve such that the balancing fee for this inflow should be ~= 10%
      config.setBalancingFeeTuple(originChainId, [[toBNWei("0"), toBNWei("0.1")]]);
    });
    it("No flows", function () {
      const result = ubaFeeCalculator.analog.calculateHistoricalRunningBalance(
        [],
        lastValidatedRunningBalance,
        lastValidatedIncentiveRunningBalance,
        startingNetRunningBalanceAdjustment,
        10,
        tokenSymbol,
        new MockUBAConfig()
      );

      expect(result.runningBalance).to.equal(lastValidatedRunningBalance);
      expect(result.incentiveBalance).to.equal(lastValidatedIncentiveRunningBalance);
      expect(result.netRunningBalanceAdjustment).to.equal(0);
    });
    it("running balances are accumulated correctly", function () {
      // This is a simple test with simple flows and no thresholds. Check that a deposit adds to a running balance
      // and fills and refunds subtract from the running balance. Check that the balancing fee is added only to
      // the incentive balance.

      // Replicate the balancing fee computation used in getEventFee
      const expectedBalancingFeeForDeposit = ubaFeeCalculator.UBAFeeUtility.computePiecewiseLinearFunction(
        config.getBalancingFeeTuples(originChainId),
        lastValidatedRunningBalance,
        deposit.amount.add(lastValidatedRunningBalance)
      );
      const expectedBalancingFeeForFill = ubaFeeCalculator.UBAFeeUtility.computePiecewiseLinearFunction(
        config.getBalancingFeeTuples(originChainId),
        lastValidatedRunningBalance.add(deposit.amount),
        lastValidatedRunningBalance.add(deposit.amount).sub(fill.amount)
      );
      const expectedBalancingFeeTotal = expectedBalancingFeeForDeposit.add(expectedBalancingFeeForFill);

      const flows: (UbaFlow & { incentiveFee: BigNumber })[] = [
        {
          ...(deposit as UbaInflow),
          incentiveFee: expectedBalancingFeeForDeposit,
        },
        {
          ...(fill as UbaOutflow),
          incentiveFee: expectedBalancingFeeForFill,
        },
      ];
      const result = ubaFeeCalculator.analog.calculateHistoricalRunningBalance(
        flows,
        lastValidatedRunningBalance,
        lastValidatedIncentiveRunningBalance,
        startingNetRunningBalanceAdjustment,
        10,
        tokenSymbol,
        config
      );

      expect(result.runningBalance).to.equal(
        lastValidatedRunningBalance.add(deposit.amount).sub(fill.amount).sub(expectedBalancingFeeTotal)
      );
      expect(result.incentiveBalance).to.equal(lastValidatedIncentiveRunningBalance.add(expectedBalancingFeeTotal));
      expect(result.netRunningBalanceAdjustment).to.equal(0);
    });
    it("Upper bound threshold triggered by deposit", function () {
      // Set hurdle such that next deposit triggers it.
      const upperBoundThreshold = { threshold: toBNWei("100"), target: toBNWei("0") };
      config.setBalanceTriggerThreshold(originChainId, tokenSymbol, {
        lowerBound: { target: toBN(0), threshold: toBN(0) },
        upperBound: upperBoundThreshold,
      });

      // Replicate the balancing fee computation used in getEventFee for the deposit and fill.
      // 1. Deposit adds to starting running Balance --> upper bound threshold is triggered, reset to target
      // 2. Fill subtracts from the upper bound target
      const expectedBalancingFeeForDeposit = ubaFeeCalculator.UBAFeeUtility.computePiecewiseLinearFunction(
        config.getBalancingFeeTuples(originChainId),
        lastValidatedRunningBalance,
        deposit.amount.add(lastValidatedRunningBalance)
      );
      const expectedBalancingFeeForFill = ubaFeeCalculator.UBAFeeUtility.computePiecewiseLinearFunction(
        config.getBalancingFeeTuples(originChainId),
        upperBoundThreshold.target,
        upperBoundThreshold.target.sub(fill.amount)
      );
      const flows: (UbaFlow & { incentiveFee: BigNumber })[] = [
        {
          ...(deposit as UbaInflow),
          incentiveFee: expectedBalancingFeeForDeposit,
        },
        {
          ...(fill as UbaOutflow),
          incentiveFee: expectedBalancingFeeForFill,
        },
      ];
      const expectedBalancingFeeTotal = expectedBalancingFeeForDeposit.add(expectedBalancingFeeForFill);

      const result = ubaFeeCalculator.analog.calculateHistoricalRunningBalance(
        flows,
        lastValidatedRunningBalance,
        lastValidatedIncentiveRunningBalance,
        startingNetRunningBalanceAdjustment,
        10,
        tokenSymbol,
        config
      );

      // The deposit flow should cause a net running adjustment to bring the running balance to the upper bound target.
      // The subsequent fill flow should work off of the upper bound target.
      const expectedNetRunningAdjustment = lastValidatedRunningBalance
        .add(deposit.amount)
        .sub(expectedBalancingFeeForDeposit)
        .sub(upperBoundThreshold.target)
        .mul(-1);
      expect(result.runningBalance).to.equal(
        upperBoundThreshold.target.sub(fill.amount).sub(expectedBalancingFeeForFill)
      );
      expect(result.incentiveBalance).to.equal(lastValidatedIncentiveRunningBalance.add(expectedBalancingFeeTotal));
      expect(result.netRunningBalanceAdjustment).to.equal(expectedNetRunningAdjustment);
    });
    it("Upper bound threshold triggered by next flow", function () {
      // If the threshold is reset at a certain time, the current running balance can be so high over the threshold
      // that the next flow, even if its an outflow, can trigger the upper bound.

      // Replicate the balancing fee computation used in getEventFee
      const expectedBalancingFeeForFill = ubaFeeCalculator.UBAFeeUtility.computePiecewiseLinearFunction(
        config.getBalancingFeeTuples(originChainId),
        lastValidatedRunningBalance,
        lastValidatedRunningBalance.sub(fill.amount)
      );
      const flows: (UbaFlow & { incentiveFee: BigNumber })[] = [
        {
          ...(fill as UbaOutflow),
          incentiveFee: expectedBalancingFeeForFill,
        },
      ];

      // The hurdle is set really low, so even a fill leaves the running balance over the threshold.
      const upperBoundThreshold = { threshold: toBNWei("10"), target: toBNWei("10") };
      config.setBalanceTriggerThreshold(originChainId, tokenSymbol, {
        lowerBound: { target: toBN(0), threshold: toBN(0) },
        upperBound: upperBoundThreshold,
      });
      const result = ubaFeeCalculator.analog.calculateHistoricalRunningBalance(
        flows,
        lastValidatedRunningBalance,
        lastValidatedIncentiveRunningBalance,
        startingNetRunningBalanceAdjustment,
        10,
        tokenSymbol,
        config
      );

      // The deposit flow should cause a net running adjustment to bring the running balance to the upper bound target.
      // The subsequent fill flow should work off of the upper bound target.
      const expectedNetRunningAdjustment = lastValidatedRunningBalance
        .sub(fill.amount)
        .sub(expectedBalancingFeeForFill)
        .sub(upperBoundThreshold.target)
        .mul(-1);
      expect(result.runningBalance).to.equal(upperBoundThreshold.target);
      expect(result.incentiveBalance).to.equal(lastValidatedIncentiveRunningBalance.add(expectedBalancingFeeForFill));
      expect(result.netRunningBalanceAdjustment).to.equal(expectedNetRunningAdjustment);
    });
    it("Lower bound threshold triggered by refund", function () {
      // Replicate the balancing fee computation used in getEventFee
      const expectedBalancingFeeForFill = ubaFeeCalculator.UBAFeeUtility.computePiecewiseLinearFunction(
        config.getBalancingFeeTuples(originChainId),
        lastValidatedRunningBalance,
        lastValidatedRunningBalance.sub(fill.amount)
      );
      const expectedBalancingFeeForDeposit = ubaFeeCalculator.UBAFeeUtility.computePiecewiseLinearFunction(
        config.getBalancingFeeTuples(originChainId),
        lastValidatedRunningBalance.sub(fill.amount),
        lastValidatedRunningBalance.sub(fill.amount).add(deposit.amount)
      );
      const flows: (UbaFlow & { incentiveFee: BigNumber })[] = [
        {
          ...(fill as UbaOutflow),
          incentiveFee: expectedBalancingFeeForFill,
        },
        {
          ...(deposit as UbaInflow),
          incentiveFee: expectedBalancingFeeForDeposit,
        },
      ];
      const expectedBalancingFeeTotal = expectedBalancingFeeForDeposit.add(expectedBalancingFeeForFill);

      // Set hurdle such that next refund triggers it.
      const lowerBoundThreshold = { threshold: toBNWei("100"), target: toBNWei("150") };
      config.setBalanceTriggerThreshold(originChainId, tokenSymbol, {
        upperBound: { target: toBNWei("0"), threshold: toBNWei("0") },
        lowerBound: lowerBoundThreshold,
      });

      const result = ubaFeeCalculator.analog.calculateHistoricalRunningBalance(
        flows,
        lastValidatedRunningBalance,
        lastValidatedIncentiveRunningBalance,
        startingNetRunningBalanceAdjustment,
        10,
        tokenSymbol,
        config
      );

      // The refund flow should cause a net running adjustment to pull the running balance to the lower bound target.
      // The subsequent deposit flow should work off of the lower bound target.
      const expectedNetRunningAdjustment = lowerBoundThreshold.target.sub(
        lastValidatedRunningBalance.sub(fill.amount).sub(expectedBalancingFeeForFill)
      );
      expect(result.runningBalance).to.equal(
        lowerBoundThreshold.target.add(deposit.amount).sub(expectedBalancingFeeForDeposit)
      );
      expect(result.incentiveBalance).to.equal(lastValidatedIncentiveRunningBalance.add(expectedBalancingFeeTotal));
      expect(result.netRunningBalanceAdjustment).to.equal(expectedNetRunningAdjustment);
    });
    it("Lower bound threshold triggered by next flow", function () {
      // If the threshold is reset at a certain time, the current running balance can be so low under the threshold
      // that the next flow, even if its an inflow, can trigger the lower bound.

      // Replicate the balancing fee computation used in getEventFee
      const expectedBalancingFeeForDeposit = ubaFeeCalculator.UBAFeeUtility.computePiecewiseLinearFunction(
        config.getBalancingFeeTuples(originChainId),
        lastValidatedRunningBalance,
        lastValidatedRunningBalance.add(deposit.amount)
      );
      const flows: (UbaFlow & { incentiveFee: BigNumber })[] = [
        {
          ...(deposit as UbaInflow),
          incentiveFee: expectedBalancingFeeForDeposit,
        },
      ];

      // The hurdle is set really high, so even a deposit leaves the running balance under the threshold.
      const lowerBoundThreshold = { threshold: toBNWei("200"), target: toBNWei("150") };
      config.setBalanceTriggerThreshold(originChainId, tokenSymbol, {
        upperBound: { target: toBN(0), threshold: toBN(0) },
        lowerBound: lowerBoundThreshold,
      });
      const result = ubaFeeCalculator.analog.calculateHistoricalRunningBalance(
        flows,
        lastValidatedRunningBalance,
        lastValidatedIncentiveRunningBalance,
        startingNetRunningBalanceAdjustment,
        10,
        tokenSymbol,
        config
      );
      const expectedNetRunningAdjustment = lowerBoundThreshold.target.sub(
        lastValidatedRunningBalance.add(deposit.amount).sub(expectedBalancingFeeForDeposit)
      );
      expect(result.runningBalance).to.equal(lowerBoundThreshold.target);
      expect(result.incentiveBalance).to.equal(
        lastValidatedIncentiveRunningBalance.add(expectedBalancingFeeForDeposit)
      );
      expect(result.netRunningBalanceAdjustment).to.equal(expectedNetRunningAdjustment);
    });
    it("Multiple net running adjustments are applied in a flow sequence", function () {
      // Set hurdle such that first the deposit triggers the upper bound, and then the reset to the target
      // minus the fill triggers the lower bound.
      const upperBoundThreshold = { threshold: toBNWei("100"), target: toBNWei("50") };
      const lowerBoundThreshold = { threshold: toBNWei("50"), target: toBNWei("75") };
      config.setBalanceTriggerThreshold(originChainId, tokenSymbol, {
        lowerBound: lowerBoundThreshold,
        upperBound: upperBoundThreshold,
      });

      // Replicate the balancing fee computation used in getEventFee for the deposit and fill.
      // 1. Deposit adds to starting running Balance --> upper bound threshold is triggered, reset to target
      // 2. Fill subtracts from the upper bound target
      const expectedBalancingFeeForDeposit = ubaFeeCalculator.UBAFeeUtility.computePiecewiseLinearFunction(
        config.getBalancingFeeTuples(originChainId),
        lastValidatedRunningBalance,
        deposit.amount.add(lastValidatedRunningBalance)
      );
      const expectedBalancingFeeForFill = ubaFeeCalculator.UBAFeeUtility.computePiecewiseLinearFunction(
        config.getBalancingFeeTuples(originChainId),
        upperBoundThreshold.target,
        upperBoundThreshold.target.sub(fill.amount)
      );
      const flows: (UbaFlow & { incentiveFee: BigNumber })[] = [
        {
          ...(deposit as UbaInflow),
          incentiveFee: expectedBalancingFeeForDeposit,
        },
        {
          ...(fill as UbaOutflow),
          incentiveFee: expectedBalancingFeeForFill,
        },
      ];
      const expectedBalancingFeeTotal = expectedBalancingFeeForDeposit.add(expectedBalancingFeeForFill);

      const result = ubaFeeCalculator.analog.calculateHistoricalRunningBalance(
        flows,
        lastValidatedRunningBalance,
        lastValidatedIncentiveRunningBalance,
        startingNetRunningBalanceAdjustment,
        10,
        tokenSymbol,
        config
      );

      // Deposit triggers upper threshold.
      const expectedNetRunningAdjustmentFromDeposit = lastValidatedRunningBalance
        .add(deposit.amount)
        .sub(expectedBalancingFeeForDeposit)
        .sub(upperBoundThreshold.target)
        .mul(-1);
      // Fill triggers lower threshold
      const expectedNetRunningAdjustmentFromFill = lowerBoundThreshold.target.sub(
        upperBoundThreshold.target.sub(fill.amount).sub(expectedBalancingFeeForFill)
      );

      expect(result.runningBalance).to.equal(lowerBoundThreshold.target);
      expect(result.incentiveBalance).to.equal(lastValidatedIncentiveRunningBalance.add(expectedBalancingFeeTotal));
      expect(result.netRunningBalanceAdjustment).to.equal(
        expectedNetRunningAdjustmentFromDeposit.add(expectedNetRunningAdjustmentFromFill)
      );
    });
    it("Throws if incentive fee for any flow is greater than incentive balance", function () {
      const flows: (UbaFlow & { incentiveFee: BigNumber })[] = [
        {
          ...(deposit as UbaInflow),
          // Incentive reward is larger than incentive pot
          incentiveFee: toBNWei("-5"),
        },
      ];
      expect(() =>
        ubaFeeCalculator.analog.calculateHistoricalRunningBalance(
          flows,
          lastValidatedRunningBalance,
          // Incentive pot smaller than incentive reward
          toBNWei("4.5"),
          startingNetRunningBalanceAdjustment,
          10,
          tokenSymbol,
          config
        )
      ).to.throw(/Incentive balance will go negative/);
    });
  });
});
