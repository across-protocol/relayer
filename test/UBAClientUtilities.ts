import {
  Contract,
  assertPromiseError,
  createSpyLogger,
  deepEqualsWithBigNumber,
  deployConfigStore,
  deploySpokePool,
  ethers,
  hubPoolFixture,
} from "./utils";
import { CHAIN_ID_TEST_LIST, createRandomBytes32, expect, randomAddress, toBNWei } from "./constants";
import { DepositWithBlock, FillWithBlock, RefundRequestWithBlock, SpokePoolClientsByChain } from "../src/interfaces";
import { clients, interfaces } from "@across-protocol/sdk-v2";
import { MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient } from "./mocks";
import { UBA_MIN_CONFIG_STORE_VERSION } from "../src/common";
const { getMostRecentBundleBlockRanges, getUbaActivationBundleStartBlocks, getOpeningRunningBalanceForEvent } = clients;
import { publishValidatedBundles } from "./utils/HubPoolUtils";
import { toBN } from "../src/utils";

let hubPoolClient: MockHubPoolClient;
let hubPool: Contract;
let spokePoolClients: SpokePoolClientsByChain;
let configStoreClient: MockConfigStoreClient;

const logger = createSpyLogger().spyLogger;

const chainIds = CHAIN_ID_TEST_LIST;
const l1Tokens = [randomAddress(), randomAddress()];
const runningBalances = [toBNWei("10"), toBNWei("20")];
const incentiveBalances = [toBNWei("1"), toBNWei("2")];
const tokenSymbol = "T1";

// Use the same L2 and L1 token for this test so the HubPoolClient has no trouble
// finding the L2 token for the L1 token.
const l1Token = l1Tokens[0];
const l2Token = l1Token;

describe("UBAClientUtilities", function () {
  beforeEach(async function () {
    const [owner] = await ethers.getSigners();
    const { configStore } = await deployConfigStore(owner, []);
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
    hubPoolClient = new MockHubPoolClient(logger, hubPool, configStoreClient);
    hubPoolClient.addL1Token({
      address: l1Token,
      decimals: 18,
      symbol: tokenSymbol,
    });
    // Make all deposits return the same L1 token.
    hubPoolClient.setReturnedL1TokenForDeposit(l1Token);

    await hubPoolClient.update();
    const latestBlockNumber = await hubPool.provider.getBlockNumber();
    hubPoolClient.setLatestBlockNumber(latestBlockNumber);

    spokePoolClients = {};
    for (const originChainId of chainIds) {
      const { spokePool } = await deploySpokePool(ethers);
      const deploymentBlock = await spokePool.provider.getBlockNumber();

      // Construct generic spoke pool clients with large event search configs. This should never trigger
      // `blockRangesAreInvalidForSpokeClients` to be true.
      const spokePoolClient = new MockSpokePoolClient(logger, spokePool, originChainId, deploymentBlock);
      spokePoolClients[originChainId] = spokePoolClient;
      hubPoolClient.setCrossChainContracts(originChainId, spokePool.address, deploymentBlock);
      spokePoolClient.setLatestBlockSearched(deploymentBlock + 1000);
      spokePoolClient.setDestinationTokenForChain(originChainId, l2Token);
      // Link each chain's "L2 token" to the same L1 token.
      hubPoolClient.setL1TokensToDestinationTokens({
        [l1Token]: {
          ...hubPoolClient.l1TokensToDestinationTokensMock[l1Token],
          [originChainId]: l2Token,
        },
      });
    }
  });

  const _publishValidatedBundles = async (bundleCount) => {
    return await publishValidatedBundles(
      chainIds,
      l1Tokens,
      hubPoolClient,
      spokePoolClients,
      bundleCount,
      runningBalances,
      incentiveBalances
    );
  };
  describe("getUbaActivationBundleStartBlocks", function () {
    it("If uba activation block is not set", async function () {
      configStoreClient.setUBAActivationBlock(undefined);
      expect(() => getUbaActivationBundleStartBlocks(hubPoolClient)).to.throw(/UBA was not activated yet/);
    });
    it("Returns next validated bundle start blocks after UBA activation block", async function () {
      const expectedBlockRanges = await _publishValidatedBundles(3);

      // Set UBA activation block to block right after first bundle was proposed.
      const proposalBlocks = hubPoolClient.getProposedRootBundles().map((bundle) => bundle.blockNumber);
      configStoreClient.setUBAActivationBlock(proposalBlocks[0] + 1);

      // Start blocks should be second bundle start blocks
      const result = getUbaActivationBundleStartBlocks(hubPoolClient);
      deepEqualsWithBigNumber(
        result,
        chainIds.map((chainId) => expectedBlockRanges[chainId][1].start)
      );

      // If UBA activation block was same block as a proposal block number, uses that proposed bundle start blocks
      configStoreClient.setUBAActivationBlock(proposalBlocks[0]);
      deepEqualsWithBigNumber(
        getUbaActivationBundleStartBlocks(hubPoolClient),
        chainIds.map((chainId) => expectedBlockRanges[chainId][0].start)
      );
    });
    it("If no validated proposals after UBA activation block, returns next bundle start blocks", async function () {
      const result = getUbaActivationBundleStartBlocks(hubPoolClient);
      deepEqualsWithBigNumber(
        result,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        Array(chainIds.length).fill(0)
      );
    });
  });
  describe("getMostRecentBundleBlockRanges", function () {
    it("Request maxBundleState 0", async function () {
      // Should return by default single bundle range.
      const result = getMostRecentBundleBlockRanges(chainIds[0], 0, hubPoolClient, spokePoolClients);
      deepEqualsWithBigNumber(result, [
        {
          start: getUbaActivationBundleStartBlocks(hubPoolClient)[0],
          end: spokePoolClients[chainIds[0]].latestBlockSearched,
        },
      ]);
    });
    it("No bundles", async function () {
      // If no bundles in memory, returns a single bundle range spanning from the spoke pool activation block
      // until the last block searched.

      const defaultResult = getMostRecentBundleBlockRanges(chainIds[0], 10, hubPoolClient, spokePoolClients);
      deepEqualsWithBigNumber(defaultResult, [
        {
          start: getUbaActivationBundleStartBlocks(hubPoolClient)[0],
          end: spokePoolClients[chainIds[0]].latestBlockSearched,
        },
      ]);
    });
    it("Correctly returns n most recent validated bundles", async function () {
      // Generate 3 valid bundles.
      const expectedBlockRanges = await _publishValidatedBundles(3);
      for (const chainId of chainIds) {
        // Get 2 most recent bundles.
        const result = getMostRecentBundleBlockRanges(chainId, 2, hubPoolClient, spokePoolClients);
        // Should only return 2 most recent bundles.
        expect(result.length).to.equal(2);
        deepEqualsWithBigNumber(result, expectedBlockRanges[chainId].slice(1));
      }
    });
  });
  describe("getOpeningRunningBalances", function () {
    it("No valid bundles", async function () {
      const result = getOpeningRunningBalanceForEvent(
        hubPoolClient,
        0,
        chainIds[0],
        l1Tokens[0],
        Number.MAX_SAFE_INTEGER
      );
      expect(result.runningBalance).to.equal(0);
      expect(result.incentiveBalance).to.equal(0);
    });
    it("Selects running balance from bundle before event block", async function () {
      const expectedBlockRanges = await _publishValidatedBundles(3);

      // Test 1: UBA is active for all bundles tested, should return running balance and incentive balance as
      // published on chain.
      configStoreClient.setUBAActivationBlock(0);
      for (const chain of chainIds) {
        for (let i = 0; i < l1Tokens.length; i++) {
          const result1 = getOpeningRunningBalanceForEvent(
            hubPoolClient,
            // Start block of bundle should select running balance from previous bundle
            expectedBlockRanges[chain][1].start,
            chain,
            l1Tokens[i],
            Number.MAX_SAFE_INTEGER
          );
          expect(result1.runningBalance).to.equal(runningBalances[i]);
          expect(result1.incentiveBalance).to.equal(incentiveBalances[i]);

          const result2 = getOpeningRunningBalanceForEvent(
            hubPoolClient,
            // Block before all bundle should return 0
            0,
            chain,
            l1Tokens[i],
            Number.MAX_SAFE_INTEGER
          );
          expect(result2.runningBalance).to.equal(0);
          expect(result2.incentiveBalance).to.equal(0);
        }
      }

      // Test 2: UBA is not activated at time of input block, running balances should be negated and incentive
      // balance should be 0
      configStoreClient.setUBAActivationBlock(Number.MAX_SAFE_INTEGER);
      for (const chain of chainIds) {
        for (let i = 0; i < l1Tokens.length; i++) {
          const result1 = getOpeningRunningBalanceForEvent(
            hubPoolClient,
            // Start block of bundle should select running balance from previous bundle
            expectedBlockRanges[chain][1].start,
            chain,
            l1Tokens[i],
            Number.MAX_SAFE_INTEGER
          );
          expect(result1.runningBalance).to.equal(runningBalances[i].mul(-1));
          expect(result1.incentiveBalance).to.equal(0);
        }
      }
    });
  });
  describe("getUBAFlows", function () {
    let deposit: DepositWithBlock, fill: FillWithBlock, refund: RefundRequestWithBlock;
    let chainId: number, destinationChainId: number, repaymentChainId: number;
    let spokePoolClient: MockSpokePoolClient,
      destinationSpokePoolClient: MockSpokePoolClient,
      repaymentSpokePoolClient: MockSpokePoolClient;
    let fromBlock: number, toBlock: number;
    let destinationFromBlock: number, destinationToBlock: number;
    let repaymentFromBlock: number, repaymentToBlock: number;

    beforeEach(async function () {
      // Deposit spoke pool client:
      chainId = chainIds[0];
      spokePoolClient = spokePoolClients[chainId] as MockSpokePoolClient;
      fromBlock = spokePoolClient.deploymentBlock;
      toBlock = fromBlock + 100;
      // We should be overriding the realizedLpFeePct to undefined for UBA deposits in order for
      // getUBAFlows to identify them as UBA deposits.
      spokePoolClient.setDefaultRealizedLpFeePct(undefined);

      // Fill spoke pool client:
      destinationChainId = chainIds[1];
      destinationSpokePoolClient = spokePoolClients[destinationChainId] as MockSpokePoolClient;
      destinationFromBlock = destinationSpokePoolClient.deploymentBlock;
      destinationToBlock = destinationFromBlock + 100;

      // Refund spoke pool client:
      repaymentChainId = chainIds[2];
      repaymentSpokePoolClient = spokePoolClients[repaymentChainId] as MockSpokePoolClient;
      repaymentFromBlock = repaymentSpokePoolClient.deploymentBlock;
      repaymentToBlock = repaymentFromBlock + 100;

      deposit = {
        depositId: 0,
        depositor: randomAddress(),
        recipient: randomAddress(),
        // Need to set this to a token in l1Tokens that we added as an L1Token in the MockHubPoolClient so UBAClient
        // can identify this as a known token.
        originToken: l2Token,
        amount: toBNWei("1"),
        originChainId: chainId,
        destinationChainId,
        relayerFeePct: toBNWei("0.25"),
        // Inflows are identified by the UBAClient as those that have `quoteTimestamps`
        quoteTimestamp: 100,
        // realizedLpFeePct should be undefined for UBA deposits
        realizedLpFeePct: undefined,
        destinationToken: l2Token,
        message: "0x",
        quoteBlockNumber: 200,
        blockNumber: fromBlock + 1,
        blockTimestamp: 10,
        transactionIndex: 0,
        logIndex: 0,
        transactionHash: createRandomBytes32(),
      };
      // We need to match this fill with the deposit
      fill = {
        fillAmount: deposit.amount,
        totalFilledAmount: deposit.amount,
        depositId: deposit.depositId,
        depositor: deposit.depositor,
        recipient: deposit.recipient,
        destinationToken: deposit.destinationToken,
        amount: deposit.amount,
        originChainId: deposit.originChainId,
        destinationChainId: deposit.destinationChainId,
        // Needs to be set equal to destination chain to be a fill.
        repaymentChainId: deposit.destinationChainId,
        relayer: randomAddress(),
        relayerFeePct: deposit.relayerFeePct,
        // Outflows are identified by the UBAClient as those that have `updatableRelayData`
        updatableRelayData: {
          recipient: deposit.message,
          isSlowRelay: false,
          message: deposit.message,
          payoutAdjustmentPct: toBNWei("0"),
          relayerFeePct: deposit.relayerFeePct,
        },
        realizedLpFeePct: toBNWei("0.01"),
        message: "0x",
        blockNumber: destinationFromBlock + 1,
        blockTimestamp: 10,
        transactionIndex: 0,
        logIndex: 0,
        transactionHash: createRandomBytes32(),
      };

      // We need to match this with the refund.
      refund = {
        relayer: fill.relayer,
        refundToken: l2Token,
        amount: fill.amount,
        originChainId: fill.originChainId,
        destinationChainId: fill.destinationChainId,
        // This will be different from fill's, as we'll mutate the fill's
        // repayment chain when testing the refund.
        repaymentChainId,
        realizedLpFeePct: fill.realizedLpFeePct,
        depositId: fill.depositId,
        fillBlock: toBN(fill.blockNumber),
        previousIdenticalRequests: toBN(0),
      };
    });
    // Generate mock events, very simple tests to start
    it("Returns UBA deposits", async function () {
      const event = spokePoolClient.generateDeposit(deposit);
      spokePoolClient.addEvent(event);
      await spokePoolClient.update();

      const flows = await clients.getUBAFlows(
        tokenSymbol,
        chainId,
        spokePoolClients,
        hubPoolClient,
        fromBlock,
        toBlock
      );
      expect(flows.length).to.equal(1);
      expect(interfaces.isUbaInflow(flows[0])).to.be.true;
    });
    it("Throws if there are any pre UBA deposits", async function () {
      // We expect the getUBAFlows() call to throw because realizedLpFeePct will be set for these deposits
      spokePoolClient.setDefaultRealizedLpFeePct(toBNWei("0.1"));

      const event = spokePoolClient.generateDeposit(deposit);
      spokePoolClient.addEvent(event);
      await spokePoolClient.update();

      assertPromiseError(
        clients.getUBAFlows(tokenSymbol, chainId, spokePoolClients, hubPoolClient, fromBlock, toBlock),
        "Found a UBA deposit with a defined realizedLpFeePct"
      );
    });
    it("Returns fills matched with deposits", async function () {
      const depositEvent = spokePoolClient.generateDeposit(deposit);
      spokePoolClient.addEvent(depositEvent);
      await spokePoolClient.update();

      const event = destinationSpokePoolClient.generateFill(fill);
      destinationSpokePoolClient.addEvent(event);

      // Add an invalid fill:
      const invalidFillEvent = destinationSpokePoolClient.generateFill({
        ...fill,
        depositId: deposit.depositId + 1,
      });
      destinationSpokePoolClient.addEvent(invalidFillEvent);
      await destinationSpokePoolClient.update();

      // Look up flows on destination chain
      const flows = await clients.getUBAFlows(
        tokenSymbol,
        destinationChainId,
        spokePoolClients,
        hubPoolClient,
        destinationFromBlock,
        destinationToBlock
      );
      expect(flows.length).to.equal(1);
      expect(destinationSpokePoolClient.getFills().length).to.equal(2);
      expect(interfaces.isUbaOutflow(flows[0])).to.be.true;
    });
    it("Returns refunds matched with fills matched with deposits", async function () {
      const depositEvent = spokePoolClient.generateDeposit(deposit);
      spokePoolClient.addEvent(depositEvent);
      await spokePoolClient.update();

      // Generate fill with repaymentChain != destinationChain
      const fillEvent = destinationSpokePoolClient.generateFill({
        ...fill,
        repaymentChainId,
      });
      destinationSpokePoolClient.addEvent(fillEvent);
      await destinationSpokePoolClient.update();

      const event = repaymentSpokePoolClient.generateRefundRequest(refund);
      repaymentSpokePoolClient.addEvent(event);
      await repaymentSpokePoolClient.update();

      // Add an invalid refund:
      const invalidRefundEvent = repaymentSpokePoolClient.generateRefundRequest({
        ...refund,
        previousIdenticalRequests: toBN(2),
      });
      repaymentSpokePoolClient.addEvent(invalidRefundEvent);
      await repaymentSpokePoolClient.update();

      // Look up flows on destination chain
      const flows = await clients.getUBAFlows(
        tokenSymbol,
        repaymentChainId,
        spokePoolClients,
        hubPoolClient,
        repaymentFromBlock,
        repaymentToBlock
      );
      expect(flows.length).to.equal(1);
      expect(repaymentSpokePoolClient.getRefundRequests().length).to.equal(2);
      expect(interfaces.isUbaOutflow(flows[0])).to.be.true;
    });
  });
});
