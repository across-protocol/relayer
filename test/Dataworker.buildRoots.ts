import { interfaces, utils as sdkUtils } from "@across-protocol/sdk";
import { HubPoolClient, SpokePoolClient } from "../src/clients";
import { RelayerRefundLeaf, RunningBalances } from "../src/interfaces";
import { assert, bnZero, fixedPointAdjustment } from "../src/utils";
import { amountToDeposit, destinationChainId, mockTreeRoot, originChainId, repaymentChainId } from "./constants";
import { setupFastDataworker } from "./fixtures/Dataworker.Fixture";
import {
  Contract,
  SignerWithAddress,
  buildV3SlowRelayLeaves,
  depositV3,
  ethers,
  expect,
  fillV3Relay,
  getDefaultBlockRange,
  requestSlowFill,
  toBN,
  buildV3SlowRelayTree,
} from "./utils";

// Tested
import { Dataworker } from "../src/dataworker/Dataworker";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress;

let hubPoolClient: HubPoolClient;
let dataworkerInstance: Dataworker;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let updateAllClients: () => Promise<void>;

describe("Dataworker: Build merkle roots", async function () {
  beforeEach(async function () {
    const fastDataworkerResult = await setupFastDataworker(ethers);
    ({
      spokePool_1,
      erc20_1,
      spokePool_2,
      erc20_2,
      hubPoolClient,
      l1Token_1,
      depositor,
      relayer,
      dataworkerInstance,
      spokePoolClients,
      updateAllClients,
    } = fastDataworkerResult);
    await updateAllClients();
    const poolRebalanceRoot = await dataworkerInstance.buildPoolRebalanceRoot(
      getDefaultBlockRange(1),
      spokePoolClients
    );
    expect(poolRebalanceRoot.runningBalances).to.deep.equal({});
    expect(poolRebalanceRoot.realizedLpFees).to.deep.equal({});
    const relayerRefundRoot = await dataworkerInstance.buildRelayerRefundRoot(
      getDefaultBlockRange(1),
      spokePoolClients,
      poolRebalanceRoot.leaves,
      poolRebalanceRoot.runningBalances
    );
    expect(relayerRefundRoot.leaves).to.deep.equal([]);
  });
  it("Subtracts bundle deposits from origin chain running balances", async function () {
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    await updateAllClients();
    const merkleRoot1 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(2), spokePoolClients);

    // Deposits should not add to bundle LP fees.
    const expectedRunningBalances: RunningBalances = {
      [originChainId]: {
        [l1Token_1.address]: deposit.inputAmount.mul(-1),
      },
    };
    expect(expectedRunningBalances).to.deep.equal(merkleRoot1.runningBalances);
    expect({}).to.deep.equal(merkleRoot1.realizedLpFees);
  });
  it("Adds bundle fills to repayment chain running balances", async function () {
    // Send two deposits so we can fill with two different origin chains to test that the BundleDataClient
    // batch computes lp fees correctly for different origin chains.
    await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    await depositV3(
      spokePool_2,
      originChainId,
      depositor,
      erc20_2.address,
      amountToDeposit,
      erc20_1.address,
      amountToDeposit
    );
    await updateAllClients();
    const [deposit1] = spokePoolClients[originChainId].getDeposits();
    const [deposit2] = spokePoolClients[destinationChainId].getDeposits();

    await fillV3Relay(spokePool_2, deposit1, relayer, repaymentChainId);
    await fillV3Relay(spokePool_1, deposit2, relayer, repaymentChainId);
    await updateAllClients();
    const [fill1] = spokePoolClients[destinationChainId].getFills();
    const [fill2] = spokePoolClients[originChainId].getFills();

    const merkleRoot1 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(2), spokePoolClients);

    // Deposits should not add to bundle LP fees, but fills should. LP fees are taken out of running balances
    // and added to realized LP fees, for fills.
    const lpFeePct1 = (
      await hubPoolClient.computeRealizedLpFeePct({ ...deposit1, paymentChainId: fill1.destinationChainId })
    ).realizedLpFeePct;
    const lpFeePct2 = (
      await hubPoolClient.computeRealizedLpFeePct({ ...deposit2, paymentChainId: fill2.destinationChainId })
    ).realizedLpFeePct;
    assert(lpFeePct1.gt(0) && lpFeePct2.gt(0), "LP fee pct should be greater than 0");
    const lpFee1 = lpFeePct1.mul(fill1.inputAmount).div(fixedPointAdjustment);
    const lpFee2 = lpFeePct2.mul(fill2.inputAmount).div(fixedPointAdjustment);
    const expectedRunningBalances: RunningBalances = {
      [originChainId]: {
        [l1Token_1.address]: deposit1.inputAmount.mul(-1),
      },
      [destinationChainId]: {
        [l1Token_1.address]: deposit2.inputAmount.mul(-1),
      },
      [repaymentChainId]: {
        [l1Token_1.address]: lpFee1.mul(-1).add(fill1.inputAmount).add(lpFee2.mul(-1).add(fill2.inputAmount)),
      },
    };
    const expectedRealizedLpFees: RunningBalances = {
      [repaymentChainId]: {
        [l1Token_1.address]: lpFee1.add(lpFee2),
      },
    };
    expect(expectedRunningBalances).to.deep.equal(merkleRoot1.runningBalances);
    expect(expectedRealizedLpFees).to.deep.equal(merkleRoot1.realizedLpFees);
  });
  it("Adds bundle slow fills to destination chain running balances", async function () {
    await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    await updateAllClients();
    const [deposit] = spokePoolClients[originChainId].getDeposits();
    await requestSlowFill(spokePool_2, relayer, deposit);
    await updateAllClients();
    const slowFillRequest = spokePoolClients[destinationChainId].getSlowFillRequestsForOriginChain(originChainId)[0];
    const merkleRoot1 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(2), spokePoolClients);

    // Slow fills should not add to bundle LP fees.
    const lpFeePct = (
      await hubPoolClient.computeRealizedLpFeePct({ ...deposit, paymentChainId: deposit.destinationChainId })
    ).realizedLpFeePct;
    const lpFee = lpFeePct.mul(slowFillRequest.inputAmount).div(fixedPointAdjustment);
    const expectedRunningBalances: RunningBalances = {
      [originChainId]: {
        [l1Token_1.address]: deposit.inputAmount.mul(-1),
      },
      [destinationChainId]: {
        [l1Token_1.address]: slowFillRequest.inputAmount.sub(lpFee),
      },
    };
    expect(expectedRunningBalances).to.deep.equal(merkleRoot1.runningBalances);
    expect({}).to.deep.equal(merkleRoot1.realizedLpFees);
  });
  it("Subtracts unexecutable slow fill amounts from destination chain running balances", async function () {
    // Send slow fill in first bundle block range:
    await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    await updateAllClients();
    const [deposit] = spokePoolClients[originChainId].getDeposits();
    await requestSlowFill(spokePool_2, relayer, deposit);
    await updateAllClients();

    // Propose first bundle with a destination chain block range that includes up to the slow fiil block.
    const slowFillRequest = spokePoolClients[destinationChainId].getSlowFillRequestsForOriginChain(originChainId)[0];
    const destinationChainBlockRange = [0, slowFillRequest.blockNumber];
    const blockRange1 = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.map(
      () => destinationChainBlockRange
    );
    const merkleRoot1 = await dataworkerInstance.buildPoolRebalanceRoot(blockRange1, spokePoolClients);

    const lpFeePct = (
      await hubPoolClient.computeRealizedLpFeePct({ ...deposit, paymentChainId: deposit.destinationChainId })
    ).realizedLpFeePct;
    const lpFee = lpFeePct.mul(slowFillRequest.inputAmount).div(fixedPointAdjustment);
    const expectedRunningBalances: RunningBalances = {
      [originChainId]: {
        [l1Token_1.address]: deposit.inputAmount.mul(-1),
      },
      [destinationChainId]: {
        [l1Token_1.address]: slowFillRequest.inputAmount.sub(lpFee),
      },
    };
    expect(expectedRunningBalances).to.deep.equal(merkleRoot1.runningBalances);
    expect({}).to.deep.equal(merkleRoot1.realizedLpFees);

    // Send a fast fill in a second bundle block range.
    await fillV3Relay(spokePool_2, deposit, relayer, repaymentChainId);
    await updateAllClients();
    const [fill] = spokePoolClients[destinationChainId].getFills();

    expect(fill.relayExecutionInfo.fillType).to.equal(interfaces.FillType.ReplacedSlowFill);
    const blockRange2 = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.map((_chain, index) => [
      blockRange1[index][1] + 1,
      getDefaultBlockRange(2)[index][1],
    ]);
    const merkleRoot2 = await dataworkerInstance.buildPoolRebalanceRoot(blockRange2, spokePoolClients);

    // Add fill to repayment chain running balance and remove slow fill amount from destination chain.
    const slowFillAmount = lpFee.mul(-1).add(fill.inputAmount);
    const expectedRunningBalances2: RunningBalances = {
      // Note: There should be no origin chain entry here since there were no deposits.
      [destinationChainId]: {
        [l1Token_1.address]: slowFillAmount.mul(-1),
      },
      [repaymentChainId]: {
        [l1Token_1.address]: slowFillAmount,
      },
    };
    const expectedRealizedLpFees2: RunningBalances = {
      [repaymentChainId]: {
        [l1Token_1.address]: lpFee,
      },
    };
    expect(expectedRunningBalances2).to.deep.equal(merkleRoot2.runningBalances);
    expect(expectedRealizedLpFees2).to.deep.equal(merkleRoot2.realizedLpFees);
  });
  it("Adds expired deposits to origin chain running balances", async function () {
    const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
      [originChainId, destinationChainId],
      getDefaultBlockRange(2),
      spokePoolClients
    );
    const elapsedFillDeadline = bundleBlockTimestamps[destinationChainId][1] - 1;

    await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit,
      {
        fillDeadline: elapsedFillDeadline,
      }
    );
    await updateAllClients();
    const merkleRoot1 = await dataworkerInstance.buildPoolRebalanceRoot(getDefaultBlockRange(2), spokePoolClients);

    // Origin chain running balance is incremented by refunded deposit which cancels out the subtraction for
    // bundle deposit.
    const expectedRunningBalances: RunningBalances = {
      // Note: There should be no origin chain entry here since there were no deposits.
      [originChainId]: {
        [l1Token_1.address]: bnZero,
      },
    };
    expect(expectedRunningBalances).to.deep.equal(merkleRoot1.runningBalances);
    expect({}).to.deep.equal(merkleRoot1.realizedLpFees);
  });
  it("Adds fills to relayer refund root", async function () {
    await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    await updateAllClients();
    const [deposit] = spokePoolClients[originChainId].getDeposits();

    await fillV3Relay(spokePool_2, deposit, relayer, repaymentChainId);
    await updateAllClients();
    const { runningBalances, leaves } = await dataworkerInstance.buildPoolRebalanceRoot(
      getDefaultBlockRange(2),
      spokePoolClients
    );
    const merkleRoot1 = await dataworkerInstance.buildRelayerRefundRoot(
      getDefaultBlockRange(2),
      spokePoolClients,
      leaves,
      runningBalances
    );

    // Origin chain should have negative running balance and therefore positive amount to return.
    const lpFeePct = (
      await hubPoolClient.computeRealizedLpFeePct({ ...deposit, paymentChainId: deposit.destinationChainId })
    ).realizedLpFeePct;
    const lpFee = lpFeePct.mul(deposit.inputAmount).div(fixedPointAdjustment);
    const refundAmount = deposit.inputAmount.sub(lpFee);
    const expectedLeaves: RelayerRefundLeaf[] = [
      {
        chainId: originChainId,
        amountToReturn: runningBalances[originChainId][l1Token_1.address].mul(-1),
        l2TokenAddress: erc20_1.address,
        leafId: 0,
        refundAddresses: [],
        refundAmounts: [],
      },
      {
        chainId: repaymentChainId,
        amountToReturn: bnZero,
        l2TokenAddress: l1Token_1.address,
        leafId: 1,
        refundAddresses: [relayer.address],
        refundAmounts: [refundAmount],
      },
    ];
    expect(expectedLeaves).to.deep.equal(merkleRoot1.leaves);
  });
  it("All fills are slow fill executions", async function () {
    await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    await updateAllClients();
    const [deposit] = spokePoolClients[originChainId].getDeposits();

    const lpFeePct = (
      await hubPoolClient.computeRealizedLpFeePct({ ...deposit, paymentChainId: deposit.destinationChainId })
    ).realizedLpFeePct;
    const slowFills = buildV3SlowRelayLeaves([deposit], lpFeePct);

    // Relay slow root to destination chain
    const slowFillTree = await buildV3SlowRelayTree(slowFills);
    await spokePool_2.relayRootBundle(mockTreeRoot, slowFillTree.getHexRoot());
    await erc20_2.mint(spokePool_2.address, deposit.inputAmount);
    await spokePool_2.executeSlowRelayLeaf(slowFills[0], 0, slowFillTree.getHexProof(slowFills[0]));
    await updateAllClients();
    const poolRebalanceRoot = await dataworkerInstance.buildPoolRebalanceRoot(
      getDefaultBlockRange(2),
      spokePoolClients
    );

    // Slow fill executions should add to bundle LP fees, but not refunds. So, there should be
    // change to running balances on the destination chain, but there should be an entry for it
    // so that bundle lp fees get accumulated.
    const lpFee = lpFeePct.mul(deposit.inputAmount).div(fixedPointAdjustment);
    const expectedRunningBalances: RunningBalances = {
      [originChainId]: {
        [l1Token_1.address]: deposit.inputAmount.mul(-1),
      },
      [destinationChainId]: {
        [l1Token_1.address]: toBN(0),
      },
    };
    const expectedRealizedLpFees: RunningBalances = {
      [destinationChainId]: {
        [l1Token_1.address]: lpFee,
      },
    };
    expect(expectedRunningBalances).to.deep.equal(poolRebalanceRoot.runningBalances);
    expect(expectedRealizedLpFees).to.deep.equal(poolRebalanceRoot.realizedLpFees);

    const refundRoot = await dataworkerInstance.buildRelayerRefundRoot(
      getDefaultBlockRange(2),
      spokePoolClients,
      poolRebalanceRoot.leaves,
      poolRebalanceRoot.runningBalances
    );
    const expectedLeaves: RelayerRefundLeaf[] = [
      {
        chainId: originChainId,
        amountToReturn: poolRebalanceRoot.runningBalances[originChainId][l1Token_1.address].mul(-1),
        l2TokenAddress: erc20_1.address,
        leafId: 0,
        refundAddresses: [],
        refundAmounts: [],
      },
      // No leaf for destination chain.
    ];
    expect(expectedLeaves).to.deep.equal(refundRoot.leaves);
  });
  it("Adds expired deposit refunds to relayer refund root", async function () {
    const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
      [originChainId, destinationChainId],
      getDefaultBlockRange(2),
      spokePoolClients
    );
    const elapsedFillDeadline = bundleBlockTimestamps[destinationChainId][1] - 1;

    await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit,
      {
        fillDeadline: elapsedFillDeadline,
      }
    );
    await updateAllClients();
    const [deposit] = spokePoolClients[originChainId].getDeposits();

    const { runningBalances, leaves } = await dataworkerInstance.buildPoolRebalanceRoot(
      getDefaultBlockRange(2),
      spokePoolClients
    );
    const merkleRoot1 = await dataworkerInstance.buildRelayerRefundRoot(
      getDefaultBlockRange(2),
      spokePoolClients,
      leaves,
      runningBalances
    );

    // Origin chain running balance starts negative because of the deposit
    // but is cancelled out by the refund such that the running balance is 0
    // and there is no amount to return.
    const expectedLeaves: RelayerRefundLeaf[] = [
      {
        chainId: originChainId,
        amountToReturn: bnZero,
        l2TokenAddress: erc20_1.address,
        leafId: 0,
        refundAddresses: [deposit.depositor],
        refundAmounts: [deposit.inputAmount],
      },
    ];
    expect(expectedLeaves).to.deep.equal(merkleRoot1.leaves);
  });
  it("Adds bundle slow fills to slow fill root", async function () {
    await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    await updateAllClients();
    const [deposit] = spokePoolClients[originChainId].getDeposits();

    await requestSlowFill(spokePool_2, relayer, deposit);
    await updateAllClients();
    const merkleRoot1 = await dataworkerInstance.buildSlowRelayRoot(getDefaultBlockRange(2), spokePoolClients);

    const lpFeePct = (
      await hubPoolClient.computeRealizedLpFeePct({ ...deposit, paymentChainId: deposit.destinationChainId })
    ).realizedLpFeePct;
    const expectedSlowFillLeaves = buildV3SlowRelayLeaves([deposit], lpFeePct);
    expect(merkleRoot1.leaves).to.deep.equal(
      expectedSlowFillLeaves.map((leaf) => {
        leaf.relayData.inputToken = sdkUtils.toAddress(leaf.relayData.inputToken);
        leaf.relayData.outputToken = sdkUtils.toAddress(leaf.relayData.outputToken);
        leaf.relayData.depositor = sdkUtils.toAddress(leaf.relayData.depositor);
        leaf.relayData.recipient = sdkUtils.toAddress(leaf.relayData.recipient);
        leaf.relayData.exclusiveRelayer = sdkUtils.toAddress(leaf.relayData.exclusiveRelayer);
        return leaf;
      })
    );
  });
});
