import { BundleDataClient, ConfigStoreClient, HubPoolClient, SpokePoolClient } from "../src/clients";
import { amountToDeposit, destinationChainId, originChainId, repaymentChainId } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import {
  Contract,
  FakeContract,
  SignerWithAddress,
  V3FillFromDeposit,
  depositV3,
  ethers,
  expect,
  fillV3,
  getDefaultBlockRange,
  randomAddress,
  smock,
} from "./utils";

import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { getCurrentTime, Event, toBNWei, ZERO_ADDRESS } from "../src/utils";
import { MockHubPoolClient, MockSpokePoolClient } from "./mocks";
import { interfaces, utils as sdkUtils } from "@across-protocol/sdk";

let erc20_1: Contract, erc20_2: Contract;
let l1Token_1: Contract;
let relayer: SignerWithAddress, depositor: SignerWithAddress;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let hubPoolClient: HubPoolClient, configStoreClient: ConfigStoreClient;
let dataworkerInstance: Dataworker;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let updateAllClients: () => Promise<void>;

describe("BundleDataClient: Pre-fill logic", async function () {
  beforeEach(async function () {
    ({
      erc20_1,
      erc20_2,
      hubPoolClient,
      configStoreClient,
      l1Token_1,
      relayer,
      depositor,
      dataworkerInstance,
      spokePoolClient_1,
      spokePoolClient_2,
      spokePoolClients,
      updateAllClients,
    } = await setupDataworker(ethers, 25, 25, 0));
    await updateAllClients();
  });

  describe("Tests with real events", function () {
    describe("Pre-fills", function () {
      it("Fetches and refunds fill if fill status is Filled", async function () {
        // In this test, there is no fill in the SpokePoolClient's memory so the BundleDataClient
        // should query its fill status on-chain and then fetch it to create a refund.
        const deposit = await depositV3(
          spokePoolClient_1.spokePool,
          destinationChainId,
          depositor,
          erc20_1.address,
          amountToDeposit,
          erc20_2.address,
          amountToDeposit
        );
        await spokePoolClient_1.update(["V3FundsDeposited"]);

        // Mine fill, update spoke pool client to advance its latest block searched far enough such that the
        // fillStatuses() call and findFillEvent() queries work but ignore the fill event to force the Bundle Client
        // to query fresh for the fill status.
        await fillV3(spokePoolClient_2.spokePool, relayer, deposit);
        await spokePoolClient_2.update([]);
        expect(spokePoolClient_2.getFills().length).to.equal(0);

        // The bundle data client should create a refund for the pre fill
        const bundleBlockRanges = getDefaultBlockRange(5);
        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
        expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills[0].depositId).to.equal(deposit.depositId);
      });
    });
  });

  describe("Tests with mocked events", function () {
    let mockOriginSpokePoolClient: MockSpokePoolClient, mockDestinationSpokePoolClient: MockSpokePoolClient;
    let mockHubPoolClient: MockHubPoolClient;
    let mockDestinationSpokePool: FakeContract;
    const lpFeePct = toBNWei("0.01");

    beforeEach(async function () {
      mockHubPoolClient = new MockHubPoolClient(
        hubPoolClient.logger,
        hubPoolClient.hubPool,
        configStoreClient,
        hubPoolClient.deploymentBlock,
        hubPoolClient.chainId
      );
      // Mock a realized lp fee pct for each deposit so we can check refund amounts and bundle lp fees.
      mockHubPoolClient.setDefaultRealizedLpFeePct(lpFeePct);
      mockOriginSpokePoolClient = new MockSpokePoolClient(
        spokePoolClient_1.logger,
        spokePoolClient_1.spokePool,
        spokePoolClient_1.chainId,
        spokePoolClient_1.deploymentBlock
      );
      mockDestinationSpokePool = await smock.fake(spokePoolClient_2.spokePool.interface);
      mockDestinationSpokePoolClient = new MockSpokePoolClient(
        spokePoolClient_2.logger,
        mockDestinationSpokePool as Contract,
        spokePoolClient_2.chainId,
        spokePoolClient_2.deploymentBlock
      );
      spokePoolClients = {
        ...spokePoolClients,
        [originChainId]: mockOriginSpokePoolClient,
        [destinationChainId]: mockDestinationSpokePoolClient,
      };
      await mockHubPoolClient.update();
      await mockOriginSpokePoolClient.update();
      await mockDestinationSpokePoolClient.update();
      mockHubPoolClient.setTokenMapping(l1Token_1.address, originChainId, erc20_1.address);
      mockHubPoolClient.setTokenMapping(l1Token_1.address, destinationChainId, erc20_2.address);
      mockHubPoolClient.setTokenMapping(l1Token_1.address, repaymentChainId, l1Token_1.address);
      const bundleDataClient = new BundleDataClient(
        dataworkerInstance.logger,
        {
          ...dataworkerInstance.clients.bundleDataClient.clients,
          hubPoolClient: mockHubPoolClient as unknown as HubPoolClient,
        },
        dataworkerInstance.clients.bundleDataClient.spokePoolClients,
        dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers
      );
      dataworkerInstance = new Dataworker(
        dataworkerInstance.logger,
        { ...dataworkerInstance.clients, bundleDataClient },
        dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers,
        dataworkerInstance.maxRefundCountOverride,
        dataworkerInstance.maxL1TokenCountOverride,
        dataworkerInstance.blockRangeEndBlockBuffer
      );
    });

    function generateV3Deposit(eventOverride?: Partial<interfaces.DepositWithBlock>): Event {
      return mockOriginSpokePoolClient.depositV3({
        inputToken: erc20_1.address,
        outputToken: eventOverride?.outputToken ?? erc20_2.address,
        message: "0x",
        quoteTimestamp: eventOverride?.quoteTimestamp ?? getCurrentTime() - 10,
        fillDeadline: eventOverride?.fillDeadline ?? getCurrentTime() + 14400,
        destinationChainId,
        blockNumber: eventOverride?.blockNumber ?? spokePoolClient_1.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.DepositWithBlock);
    }

    function generateV3FillFromDeposit(
      deposit: interfaces.DepositWithBlock,
      fillEventOverride?: Partial<interfaces.FillWithBlock>,
      _relayer = relayer.address,
      _repaymentChainId = repaymentChainId,
      fillType = interfaces.FillType.FastFill
    ): Event {
      const fillObject = V3FillFromDeposit(deposit, _relayer, _repaymentChainId);
      return mockDestinationSpokePoolClient.fillV3Relay({
        ...fillObject,
        relayExecutionInfo: {
          updatedRecipient: fillObject.updatedRecipient,
          updatedMessage: fillObject.updatedMessage,
          updatedOutputAmount: fillObject.updatedOutputAmount,
          fillType,
        },
        blockNumber: fillEventOverride?.blockNumber ?? spokePoolClient_2.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.FillWithBlock);
    }

    function generateSlowFillRequestFromDeposit(
      deposit: interfaces.DepositWithBlock,
      fillEventOverride?: Partial<interfaces.FillWithBlock>
    ): Event {
      const fillObject = V3FillFromDeposit(deposit, ZERO_ADDRESS);
      const { relayer, repaymentChainId, relayExecutionInfo, ...relayData } = fillObject;
      return mockDestinationSpokePoolClient.requestV3SlowFill({
        ...relayData,
        blockNumber: fillEventOverride?.blockNumber ?? spokePoolClient_2.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.SlowFillRequest);
    }

    describe("Pre-fills", function () {
      it("Refunds fill if fill is in-memory and in older bundle", async function () {
        generateV3Deposit({ outputToken: randomAddress() });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDeposits();

        // Submit fill that we won't include in the bundle block range.
        const fill = generateV3FillFromDeposit(deposits[0], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber,
        });
        // Substitute bundle block ranges.
        const bundleBlockRanges = getDefaultBlockRange(5);
        const destinationChainIndex =
          dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
        bundleBlockRanges[destinationChainIndex] = [fill.blockNumber + 1, fill.blockNumber + 2];

        await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
        expect(mockDestinationSpokePoolClient.getFills().length).to.equal(1);

        // The fill is a pre-fill because its earlier than the bundle block range. Because its corresponding
        // deposit is in the block range, we should refund it.
        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
        expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills[0].depositId).to.equal(
          fill.args.depositId
        );
      });

      it("Ignores duplicate deposits", async function () {
        // In this test, we send one fill per deposit. We assume you cannot send more than one fill per deposit.
        generateV3Deposit({ outputToken: randomAddress() });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        await mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]); // Duplicate deposit
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDepositsForDestinationChainWithDuplicates(destinationChainId);
        expect(deposits.length).to.equal(2);

        // Submit fill that we won't include in the bundle block range.
        const fill = generateV3FillFromDeposit(deposits[0], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber,
        });
        // Substitute bundle block ranges.
        const bundleBlockRanges = getDefaultBlockRange(5);
        const destinationChainIndex =
          dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
        bundleBlockRanges[destinationChainIndex] = [fill.blockNumber + 1, fill.blockNumber + 2];

        await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
        expect(mockDestinationSpokePoolClient.getFills().length).to.equal(1);

        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
        expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills[0].depositId).to.equal(
          fill.args.depositId
        );
      });

      it("Does not refund fill if fill is in-memory but in a future bundle", async function () {
        generateV3Deposit({ outputToken: randomAddress() });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDeposits();

        // Submit fill that we won't include in the bundle block range but is in a future bundle
        const futureFill = generateV3FillFromDeposit(deposits[0], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 11,
        });

        // Substitute bundle block ranges.
        const bundleBlockRanges = getDefaultBlockRange(5);
        const destinationChainIndex =
          dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
        bundleBlockRanges[destinationChainIndex] = [futureFill.blockNumber - 2, futureFill.blockNumber - 1];

        await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
        expect(mockDestinationSpokePoolClient.getFills().length).to.equal(1);

        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleFillsV3).to.deep.equal({});
      });

      it("Does not refund fill if fill is in-memory but its a SlowFill", async function () {
        generateV3Deposit({ outputToken: randomAddress() });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDeposits();

        // Submit fill in an older bundle but its a Slow Fill execution.
        const slowFill = generateV3FillFromDeposit(
          deposits[0],
          { blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber },
          undefined,
          undefined,
          interfaces.FillType.SlowFill
        );

        // Substitute bundle block ranges.
        const bundleBlockRanges = getDefaultBlockRange(5);
        const destinationChainIndex =
          dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
        bundleBlockRanges[destinationChainIndex] = [slowFill.blockNumber + 1, slowFill.blockNumber + 2];

        await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
        expect(mockDestinationSpokePoolClient.getFills().length).to.equal(1);

        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleFillsV3).to.deep.equal({});
      });
    });

    describe("Pre-slow-fill-requests", function () {
      it("Creates slow fill leaf if slow fill request is in-memory and in older bundle", async function () {
        generateV3Deposit({ outputToken: erc20_2.address });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDeposits();

        // Submit request that we won't include in the bundle block range.
        const request = generateSlowFillRequestFromDeposit(deposits[0], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber,
        });
        // Substitute bundle block ranges.
        const bundleBlockRanges = getDefaultBlockRange(5);
        const destinationChainIndex =
          dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
        bundleBlockRanges[destinationChainIndex] = [request.blockNumber + 1, request.blockNumber + 2];

        await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill"]);
        expect(mockDestinationSpokePoolClient.getSlowFillRequestsForOriginChain(originChainId).length).to.equal(1);

        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address].length).to.equal(1);
        expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address][0].depositId).to.equal(
          request.args.depositId
        );
      });

      it("Ignores duplicate deposits", async function () {
        // In this test, we should create one leaf per deposit.
        // We assume you cannot send more than one request per deposit.
        generateV3Deposit({ outputToken: erc20_2.address });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        await mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]); // Duplicate deposit
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDepositsForDestinationChainWithDuplicates(destinationChainId);
        expect(deposits.length).to.equal(2);

        // Submit request that we won't include in the bundle block range.
        const request = generateSlowFillRequestFromDeposit(deposits[0], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber,
        });
        // Substitute bundle block ranges.
        const bundleBlockRanges = getDefaultBlockRange(5);
        const destinationChainIndex =
          dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
        bundleBlockRanges[destinationChainIndex] = [request.blockNumber + 1, request.blockNumber + 2];

        await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill"]);
        expect(mockDestinationSpokePoolClient.getSlowFillRequestsForOriginChain(originChainId).length).to.equal(1);

        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address].length).to.equal(1);
        expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address][0].depositId).to.equal(
          request.args.depositId
        );
      });

      it("Does not create slow fill leaf if slow fill request is in-memory but in a future bundle", async function () {
        generateV3Deposit({ outputToken: erc20_2.address });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDeposits();

        // Submit request that we won't include in the bundle block range but is in a future bundle
        const request = generateSlowFillRequestFromDeposit(deposits[0], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 11,
        });

        // Substitute bundle block ranges.
        const bundleBlockRanges = getDefaultBlockRange(5);
        const destinationChainIndex =
          dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
        bundleBlockRanges[destinationChainIndex] = [request.blockNumber - 2, request.blockNumber - 1];

        await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill"]);
        expect(mockDestinationSpokePoolClient.getSlowFillRequestsForOriginChain(originChainId).length).to.equal(1);

        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleSlowFillsV3).to.deep.equal({});
      });

      it("Does not create slow fill leaf if slow fill request is in-memory but an invalid request", async function () {
        generateV3Deposit({ outputToken: randomAddress() });
        generateV3Deposit({ outputToken: erc20_2.address, fillDeadline: 0 });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDeposits();

        // Submit request that that is in a previous bundle but is invalid.
        generateSlowFillRequestFromDeposit(deposits[0], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber,
        });
        const expiredDepositRequest = generateSlowFillRequestFromDeposit(deposits[1], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber,
        });

        // Substitute bundle block ranges.
        const bundleBlockRanges = getDefaultBlockRange(5);
        const destinationChainIndex =
          dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
        bundleBlockRanges[destinationChainIndex] = [
          expiredDepositRequest.blockNumber + 1,
          expiredDepositRequest.blockNumber + 2,
        ];

        await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill"]);
        expect(mockDestinationSpokePoolClient.getSlowFillRequestsForOriginChain(originChainId).length).to.equal(2);

        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleSlowFillsV3).to.deep.equal({});
      });

      it("Creates slow fill leaf if fill status is RequestedSlowFill", async function () {
        const deposit = generateV3Deposit({ outputToken: erc20_2.address });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

        const depositHash = sdkUtils.getRelayHashFromEvent(mockOriginSpokePoolClient.getDeposits()[0]);

        // Can smock the fillStatuses() value here since the BundleDataClient doesn't need the fill event
        // to create a slow fill leaf.
        mockDestinationSpokePool.fillStatuses
          .whenCalledWith(depositHash)
          .returns(interfaces.FillStatus.RequestedSlowFill);

        // Check that bundle slow fills includes leaf.
        const bundleBlockRanges = getDefaultBlockRange(5);
        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address].length).to.equal(1);
        expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address][0].depositId).to.equal(
          deposit.args.depositId
        );
      });

      it("Does not create slow fill leaf if fill status is RequestedSlowFill but slow fill request is invalid", async function () {
        generateV3Deposit({ outputToken: randomAddress() });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

        const depositHash = sdkUtils.getRelayHashFromEvent(mockOriginSpokePoolClient.getDeposits()[0]);

        mockDestinationSpokePool.fillStatuses
          .whenCalledWith(depositHash)
          .returns(interfaces.FillStatus.RequestedSlowFill);

        // The deposit is for a token swap so the slow fill request is invalid.
        const bundleBlockRanges = getDefaultBlockRange(5);
        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleSlowFillsV3).to.deep.equal({});
      });
    });
  });
});