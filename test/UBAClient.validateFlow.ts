import {
  Contract,
  createRandomBytes32,
  createSpyLogger,
  deepEqualsWithBigNumber,
  deployConfigStore,
  deploySpokePool,
  ethers,
  hubPoolFixture,
} from "./utils";
import { CHAIN_ID_TEST_LIST, expect, randomAddress, toBN, toBNWei } from "./constants";
import { SpokePoolClientsByChain, UbaFlow, UbaInflow, UbaOutflow } from "../src/interfaces";
import { MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient, MockUBAClient } from "./mocks";
import { UBA_MIN_CONFIG_STORE_VERSION } from "../src/common";
import { MockUBAConfig } from "./mocks/MockUBAConfig";
import { clients } from "@across-protocol/sdk-v2";

let hubPoolClient: MockHubPoolClient;
let hubPool: Contract;
let spokePoolClients: SpokePoolClientsByChain;
let configStoreClient: MockConfigStoreClient;
let ubaClient: MockUBAClient;

const logger = createSpyLogger().spyLogger;

const chainIds = CHAIN_ID_TEST_LIST;
const l1Tokens = [randomAddress()];
const tokenSymbols = ["T1"];
const runningBalances = [toBNWei("0")];
const incentiveBalances = [toBNWei("0")];
const originChainId = chainIds[0];
const destinationChainId = chainIds[1];
const baselineFee = toBNWei("0.05");
const realizedLpFeePct = toBNWei("0.13");

// Make these test flows partial types so we can leave some of the params undefined until we get to the individual
// tests.
let partialInflow: Omit<UbaInflow, "blockNumber">, partialOutflow: Omit<UbaOutflow, "blockNumber" | "matchedDeposit">;

describe("UBAClient: Flow validation", function () {
  beforeEach(async function () {
    const [owner] = await ethers.getSigners();
    const { configStore } = await deployConfigStore(owner, []);

    // Set up ConfigStore with a UBA activation block so that UBA block ranges are returned.
    configStoreClient = new MockConfigStoreClient(
      logger,
      configStore,
      { fromBlock: 0 },
      UBA_MIN_CONFIG_STORE_VERSION,
      chainIds
    );
    configStoreClient.setConfigStoreVersion(UBA_MIN_CONFIG_STORE_VERSION);
    configStoreClient.setUBAActivationBlock(0);
    await configStoreClient.update();

    ({ hubPool } = await hubPoolFixture());

    // Set up HubPoolClient:
    hubPoolClient = new MockHubPoolClient(logger, hubPool, configStoreClient);
    // UBAClient will request L1 token info for each flow. We don't test this logic so we can assume all L2
    // flows map to the same L1 token symbol.
    hubPoolClient.addL1Token({
      address: l1Tokens[0],
      decimals: 18,
      symbol: tokenSymbols[0],
    });
    await hubPoolClient.update();
    const latestBlockNumber = await hubPool.provider.getBlockNumber();
    hubPoolClient.setLatestBlockNumber(latestBlockNumber);

    spokePoolClients = {};
    for (const originChainId of chainIds) {
      const { spokePool } = await deploySpokePool(ethers);
      const deploymentBlock = await spokePool.provider.getBlockNumber();

      // Construct generic spoke pool clients with large event search configs.
      const spokePoolClient = new MockSpokePoolClient(logger, spokePool, originChainId, deploymentBlock);
      spokePoolClients[originChainId] = spokePoolClient;
      hubPoolClient.setCrossChainContracts(originChainId, spokePool.address, deploymentBlock);
      spokePoolClient.setLatestBlockSearched(deploymentBlock + 1000);
    }

    // We'll inject block ranges directly into the UBA client for each test
    ubaClient = new MockUBAClient(tokenSymbols, hubPoolClient, spokePoolClients);
    ubaClient.ubaBundleBlockRanges = [];

    partialInflow = {
      depositId: 0,
      depositor: randomAddress(),
      recipient: randomAddress(),
      // Need to set this to L1 token that we added as an L1Token in the MockHubPoolClient so UBAClient
      // can identify this as a known token.
      originToken: l1Tokens[0],
      amount: toBNWei("1"),
      originChainId,
      destinationChainId,
      relayerFeePct: toBNWei("0.25"),
      // Inflows are identified by the UBAClient as those that have `quoteTimestamps`
      quoteTimestamp: 100,
      // realizedLpFeePct should be undefined for UBA deposits
      realizedLpFeePct: undefined,
      destinationToken: l1Tokens[0],
      message: "0x",
      quoteBlockNumber: 200,
      blockTimestamp: 10,
      transactionIndex: 0,
      logIndex: 0,
      transactionHash: createRandomBytes32(),
    };
    partialOutflow = {
      fillAmount: partialInflow.amount,
      totalFilledAmount: partialInflow.amount,
      depositId: partialInflow.depositId,
      depositor: partialInflow.depositor,
      recipient: partialInflow.recipient,
      destinationToken: partialInflow.destinationToken,
      amount: partialInflow.amount,
      // Inflow slotted onto origin chain
      originChainId: partialInflow.originChainId,
      destinationChainId: partialInflow.destinationChainId,
      repaymentChainId: partialInflow.destinationChainId,
      relayer: randomAddress(),
      relayerFeePct: partialInflow.relayerFeePct,
      // Outflows are identified by the UBAClient as those that have `updatableRelayData`
      updatableRelayData: {
        recipient: partialInflow.message,
        isSlowRelay: false,
        message: partialInflow.message,
        payoutAdjustmentPct: toBNWei("0"),
        relayerFeePct: partialInflow.relayerFeePct,
      },
      realizedLpFeePct: realizedLpFeePct,
      message: "0x",
      // Need to set this >= inflow block timestamp
      blockTimestamp: 10,
      transactionIndex: 0,
      logIndex: 0,
      transactionHash: createRandomBytes32(),
    };
  });

  // Propose and validate `numberOfBundles` bundles, each with random size block ranges. The block range size
  // can be hardcoded by providing a `randomJumpOverride` parameter.
  async function publishValidatedBundles(
    numberOfBundles: number,
    randomJumpOverride?: number
  ): Promise<Record<number, { start: number; end: number }[]>> {
    // Create a sets of unique block ranges per chain so that we have a lower chance of false positives
    // when fetching the block ranges for a specific chain.
    const expectedBlockRanges: Record<number, { start: number; end: number }[]> = {}; // Save expected ranges here
    let nextBlockRangesForChain = Object.fromEntries(
      chainIds.map((chainId) => {
        const randomJump = randomJumpOverride ?? Math.floor(Math.random() * 3);
        const _blockRange = [chainId, { start: 0, end: randomJump }];
        return _blockRange;
      })
    );
    for (let i = 0; i < numberOfBundles; i++) {
      const bundleEvaluationBlockNumbers = chainIds.map((chainId) => {
        if (!expectedBlockRanges[chainId]) {
          expectedBlockRanges[chainId] = [];
        }
        return toBN(nextBlockRangesForChain[chainId].end);
      });

      const rootBundleProposal = hubPoolClient.proposeRootBundle(
        Date.now(), // challengePeriodEndTimestamp
        chainIds.length, // poolRebalanceLeafCount
        bundleEvaluationBlockNumbers,
        createRandomBytes32() // Random pool rebalance root we can check.
      );
      hubPoolClient.addEvent(rootBundleProposal);
      await hubPoolClient.update();
      chainIds.forEach((chainId) => {
        expectedBlockRanges[chainId].push({
          ...nextBlockRangesForChain[chainId],
        });
      });
      chainIds.forEach((chainId, leafIndex) => {
        const leafEvent = hubPoolClient.executeRootBundle(
          toBN(0),
          leafIndex,
          toBN(chainId),
          l1Tokens, // l1Tokens
          runningBalances, // bundleLpFees
          runningBalances, // netSendAmounts
          runningBalances.concat(incentiveBalances) // runningBalances
        );
        hubPoolClient.addEvent(leafEvent);
      });

      await hubPoolClient.update();

      // Make next block range span a random number of blocks:
      const nextBlockRangeSize = Math.ceil(Math.random() * 10);
      nextBlockRangesForChain = Object.fromEntries(
        chainIds.map((chainId) => [
          chainId,
          {
            start: nextBlockRangesForChain[chainId].end + 1,
            end: nextBlockRangesForChain[chainId].end + nextBlockRangeSize,
          },
        ])
      );
    }
    await Promise.all(chainIds.map((chainId) => spokePoolClients[Number(chainId)].update()));

    // Make the last bundle to cover until the last spoke client searched block, unless a spoke pool
    // client was provided for the chain. In this case we assume that chain is disabled.
    chainIds.forEach((chainId) => {
      expectedBlockRanges[chainId][expectedBlockRanges[chainId].length - 1].end =
        spokePoolClients[chainId].latestBlockSearched;
    });
    return expectedBlockRanges;
  }
  // describe("getUBAFlows", function () {});
  describe("validateFlow", function () {
    let inflow: UbaFlow, outflow: UbaOutflow, mockUbaConfig: MockUBAConfig, bundleRanges: number[][];
    // Assumption: all flows stored in the UBA client have been validated against a matched deposit.
    describe("One bundle", function () {
      let expectedBlockRanges: Record<number, { start: number; end: number }[]>;
      const bundleCount = 1;
      const expectedBalancingFee = toBNWei("0.1");
      beforeEach(async function () {
        expectedBlockRanges = await publishValidatedBundles(bundleCount);

        // Construct a UBA config that we'll use and seed directly into the UBA client and map with the
        // injected block ranges.
        mockUbaConfig = new MockUBAConfig();
        // UBA Config will be set up with 0 running balance hurdles, a non zero baseline fee that produces
        // non zero realizedLpFees for deposits, and a non zero balancing fee curve.
        // - Set a default baseline fee so the origin chain and destination chain don't need to be specified
        mockUbaConfig.setBaselineFee(0, 0, baselineFee, true);
        // Set a curve such that the balancing fee for this inflow should be ~= 10% for any deposit amount
        // between 0 and 1_000_000.
        // The curve must also have a zero fee point which is after the 1_000_000 upper limit.
        mockUbaConfig.setBalancingFeeTuple(originChainId, [
          [toBNWei("0"), expectedBalancingFee],
          [toBNWei("1000000"), expectedBalancingFee],
          [toBNWei("1000001"), toBNWei("0")],
        ]);
        // Negate the outflow's balancing fee curve so that all balancing fees are penalties instead of rewards,
        // so we don't have to deal with any of the discounting logic in getEventFee.
        mockUbaConfig.setBalancingFeeTuple(destinationChainId, [
          [toBNWei("0"), expectedBalancingFee.mul(-1)],
          [toBNWei("1000000"), expectedBalancingFee.mul(-1)],
          [toBNWei("1000001"), toBNWei("0")],
        ]);
        bundleRanges = chainIds.map((chainId) => {
          return [expectedBlockRanges[chainId][0].start, expectedBlockRanges[chainId][0].end];
        });

        // Seed UBA Client with bundle block range
        ubaClient.ubaBundleBlockRanges.push(bundleRanges);

        // Associate a config and opening balances for the block range for the origin chain and destination chain.
        ubaClient.ubaBundleStates[ubaClient.getKeyForBundle(bundleRanges, tokenSymbols[0], originChainId)] = {
          openingBalances: {
            runningBalance: runningBalances[0],
            incentiveBalance: incentiveBalances[0],
          },
          ubaConfig: mockUbaConfig,
          flows: [],
          loadedFromCache: false,
        };
        ubaClient.ubaBundleStates[ubaClient.getKeyForBundle(bundleRanges, tokenSymbols[0], destinationChainId)] = {
          openingBalances: {
            runningBalance: runningBalances[0],
            incentiveBalance: incentiveBalances[0],
          },
          ubaConfig: mockUbaConfig,
          flows: [],
          loadedFromCache: false,
        };

        // Create flows to test with:
        inflow = {
          ...partialInflow,
          // Need to set this to a number in the bundle block range.
          blockNumber: expectedBlockRanges[originChainId][0].start + 1,
        } as UbaInflow;
        outflow = {
          ...partialOutflow,
          // Need to reset the matched deposit now that we have a block for the inflow.
          matchedDeposit: inflow,
          // Need to set this to a number in the bundle block range.
          blockNumber: expectedBlockRanges[destinationChainId][0].start + 1,
        } as UbaOutflow;
      });
      describe("Inflow", function () {
        it("Always validated", async function () {
          const result = await ubaClient.validateFlow(inflow);
          expect(result).to.not.be.undefined;
          expect(result?.balancingFee).to.equal(expectedBalancingFee);

          const expectedIncentiveBalance = inflow.amount.mul(expectedBalancingFee).div(toBNWei(1));
          expect(result?.runningBalance).to.equal(inflow.amount.sub(expectedIncentiveBalance));
          expect(result?.incentiveBalance).to.equal(expectedIncentiveBalance);
          expect(result?.netRunningBalanceAdjustment).to.equal(0);

          const expectedLpFee = inflow.amount.mul(baselineFee).div(toBNWei(1));
          expect(result?.lpFee).to.equal(expectedLpFee);
          deepEqualsWithBigNumber(result?.flow, inflow);
        });
      });
      describe("Outflow", function () {
        it("Matched deposit is a pre UBA deposit and has a realizedLpFeePct", async function () {
          // Set the closing running balance after the validated inflow. Also, set a realizedLpFeePct
          // for the deposit that should match the outflow
          const validatedInflow: clients.ModifiedUBAFlow = {
            flow: {
              ...inflow,
              realizedLpFeePct: realizedLpFeePct,
            },
            balancingFee: toBNWei("0"),
            lpFee: toBNWei("0"),
            runningBalance: runningBalances[0],
            netRunningBalanceAdjustment: toBNWei("0"),
            incentiveBalance: incentiveBalances[0],
          };
          outflow.matchedDeposit = validatedInflow.flow as UbaInflow;

          // Seed UBA client state with inflow as an already validated flow
          const bundleKey = ubaClient.getKeyForBundle(
            ubaClient.ubaBundleBlockRanges[0],
            tokenSymbols[0],
            originChainId
          );
          ubaClient.ubaBundleStates[bundleKey].flows = [validatedInflow];

          const result = await ubaClient.validateFlow(outflow);
          expect(result).to.not.be.undefined;

          // Balancing fee should be 0 since we matched with a pre UBA deposit with a defined realizedLpFeePct.
          expect(result?.balancingFee).to.equal(0);

          // Running balances should not be impacted by the outflow since we matched with a pre UBA deposit.
          expect(result?.runningBalance).to.equal(validatedInflow.runningBalance);
          expect(result?.incentiveBalance).to.equal(validatedInflow.incentiveBalance);
          expect(result?.netRunningBalanceAdjustment).to.equal(validatedInflow.netRunningBalanceAdjustment);

          // LP fee is just the realizedLpFee applied to the amount
          const expectedLpFee = outflow.amount.mul(outflow.realizedLpFeePct).div(toBNWei(1));
          expect(result?.lpFee).to.equal(expectedLpFee);
          deepEqualsWithBigNumber(result?.flow, outflow);

          // Now, we change the outflow's realizedLpFeePct such that it doesn't match with the deposit, it
          // should return undefined.
          outflow.realizedLpFeePct = toBNWei("0");
          expect(await ubaClient.validateFlow(outflow)).to.be.undefined;
        });
        it("Matched deposit has a zero balancing fee curve", async function () {
          // Override origin chain balancing fee curve to be zero, but keep the outflow's balancing fee curve
          // non zero.
          const originChainUbaConfig = new MockUBAConfig();
          originChainUbaConfig.setBaselineFee(0, 0, baselineFee, true);
          originChainUbaConfig.setBalancingFeeTuple(originChainId, [[toBNWei("0"), toBNWei("0")]]);
          ubaClient.ubaBundleStates[ubaClient.getKeyForBundle(bundleRanges, tokenSymbols[0], originChainId)].ubaConfig =
            originChainUbaConfig;

          // Add the inflow to the client state. This is a UBA deposit with an undefined realizedLpFeePct. Because
          // the deposit should have a zero balancing fee, the UBA client expects that the outflow's realizedLpFee
          // is only equal to the deposit LP fee.
          const validatedInflow: clients.ModifiedUBAFlow = {
            flow: {
              ...inflow,
            },
            balancingFee: toBNWei("0"),
            lpFee: toBNWei("0"),
            runningBalance: runningBalances[0],
            netRunningBalanceAdjustment: toBNWei("0"),
            incentiveBalance: incentiveBalances[0],
          };
          outflow.matchedDeposit = validatedInflow.flow as UbaInflow;
          outflow.realizedLpFeePct = inflow.amount.mul(baselineFee).div(toBNWei(1));

          const bundleKey = ubaClient.getKeyForBundle(
            ubaClient.ubaBundleBlockRanges[0],
            tokenSymbols[0],
            originChainId
          );
          ubaClient.ubaBundleStates[bundleKey].flows = [validatedInflow];

          const result = await ubaClient.validateFlow(outflow);
          expect(result).to.not.be.undefined;

          // Outflow and Inflow are otherwise typical UBA flows so the running balances and balancing fees should be
          // as expected.
          expect(result?.balancingFee).to.equal(expectedBalancingFee);
          expect(result?.runningBalance).to.equal(
            validatedInflow.runningBalance.sub(outflow.amount).sub(expectedBalancingFee)
          );
          expect(result?.incentiveBalance).to.equal(validatedInflow.incentiveBalance.add(expectedBalancingFee));
          expect(result?.netRunningBalanceAdjustment).to.equal(validatedInflow.netRunningBalanceAdjustment);

          // LP fee is just the realizedLpFee applied to the amount, which should also be equal to the lp fee.
          const expectedLpFee = outflow.amount.mul(outflow.realizedLpFeePct).div(toBNWei(1));
          expect(result?.lpFee).to.equal(expectedLpFee);
          expect(result?.lpFee).to.equal(inflow.amount.mul(baselineFee).div(toBNWei(1)));
        });
        it("Matched deposit is in same bundle", async function () {
          // Add the inflow to the client state. This is a UBA deposit with an undefined realizedLpFeePct.
          // The outflow's realizedLpFeePct should be equal to the deposit's LP fee plus the balancing fee.
          const validatedInflow: clients.ModifiedUBAFlow = {
            flow: {
              ...inflow,
            },
            balancingFee: expectedBalancingFee,
            lpFee: toBNWei("0"),
            runningBalance: runningBalances[0],
            netRunningBalanceAdjustment: toBNWei("0"),
            incentiveBalance: incentiveBalances[0],
          };
          outflow.matchedDeposit = validatedInflow.flow as UbaInflow;
          const expectedBalancingFeePct = expectedBalancingFee.mul(toBNWei("1")).div(inflow.amount);
          outflow.realizedLpFeePct = inflow.amount.mul(baselineFee.add(expectedBalancingFeePct)).div(toBNWei(1));

          const bundleKey = ubaClient.getKeyForBundle(
            ubaClient.ubaBundleBlockRanges[0],
            tokenSymbols[0],
            originChainId
          );
          ubaClient.ubaBundleStates[bundleKey].flows = [validatedInflow];

          // This test should look identical to the zero balancing fee curve one above assuming that the outflow
          // and inflow match. The outflow's balancing fee should be the same as the above case.
          const result = await ubaClient.validateFlow(outflow);
          expect(result).to.not.be.undefined;

          expect(result?.balancingFee).to.equal(expectedBalancingFee);
          expect(result?.runningBalance).to.equal(
            validatedInflow.runningBalance.sub(outflow.amount).sub(expectedBalancingFee)
          );
          expect(result?.incentiveBalance).to.equal(validatedInflow.incentiveBalance.add(expectedBalancingFee));
          expect(result?.netRunningBalanceAdjustment).to.equal(validatedInflow.netRunningBalanceAdjustment);

          // The LP fee should
          const expectedLpFee = outflow.amount.mul(baselineFee).div(toBNWei(1));
          expect(result?.lpFee).to.equal(expectedLpFee);
        });
        //   it("Matched deposit is not found in any bundle", async function () {
        //     // Before
        //     // After
        //     // Should both result in an error, since we assume that any outflow has been matched with
        //     // an inflow, so if we can't find it then its an error.
        //   });
      });
    });
    // describe("Many bundles", function() {
    //   describe("Outflow", function() {
    //     it("Matched deposit is in previous bundle", async function() {})
    //     it("Matched deposit is in later bundle", async function() {})
    //   })
    // })
  });
});
