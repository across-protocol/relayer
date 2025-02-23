import { ConfigStoreClient, HubPoolClient, SpokePoolClient } from "../src/clients";
import { amountToDeposit, destinationChainId, originChainId, repaymentChainId } from "./constants";
import { DataworkerConfig, setupDataworker } from "./fixtures/Dataworker.Fixture";
import {
  Contract,
  FakeContract,
  SignerWithAddress,
  V3FillFromDeposit,
  createRandomBytes32,
  depositV3,
  ethers,
  expect,
  fillV3Relay,
  getDefaultBlockRange,
  randomAddress,
  smock,
} from "./utils";
import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import {
  getCurrentTime,
  toBNWei,
  ZERO_ADDRESS,
  bnZero,
  TransactionResponse,
  spreadEventWithBlockNumber,
} from "../src/utils";
import { MockBundleDataClient, MockHubPoolClient, MockSpokePoolClient } from "./mocks";
import { interfaces, utils as sdkUtils, providers } from "@across-protocol/sdk";
import { FillWithBlock } from "../src/interfaces";

let erc20_1: Contract, erc20_2: Contract;
let l1Token_1: Contract;
let relayer: SignerWithAddress, depositor: SignerWithAddress;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let hubPoolClient: HubPoolClient, configStoreClient: ConfigStoreClient;
let dataworkerInstance: Dataworker;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let spy: sinon.SinonSpy;

let updateAllClients: () => Promise<void>;

describe("Dataworker: Load bundle data: Pre-fill and Pre-Slow-Fill request logic", async function () {
  beforeEach(async function () {
    ({
      erc20_1,
      erc20_2,
      hubPoolClient,
      configStoreClient,
      spy,
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
        await spokePoolClient_1.update(["FundsDeposited"]);

        // Mine fill, update spoke pool client to advance its latest block searched far enough such that the
        // fillStatuses() call and findFillEvent() queries work but ignore the fill event to force the Bundle Client
        // to query fresh for the fill status.
        await fillV3Relay(spokePoolClient_2.spokePool, deposit, relayer, repaymentChainId);
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
      const bundleDataClient = new MockBundleDataClient(
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
        {} as DataworkerConfig,
        { ...dataworkerInstance.clients, bundleDataClient },
        dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers,
        dataworkerInstance.maxRefundCountOverride,
        dataworkerInstance.maxL1TokenCountOverride,
        dataworkerInstance.blockRangeEndBlockBuffer
      );
    });

    function generateV3Deposit(eventOverride?: Partial<interfaces.DepositWithBlock>): interfaces.Log {
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
    ): interfaces.Log {
      const method = fillEventOverride?.method ?? "fillV3Relay";
      const fillObject = V3FillFromDeposit(deposit, _relayer, _repaymentChainId);
      return mockDestinationSpokePoolClient[method]({
        ...fillObject,
        relayExecutionInfo: {
          updatedRecipient: fillObject.relayExecutionInfo.updatedRecipient,
          updatedMessage: fillObject.relayExecutionInfo.updatedMessage,
          updatedOutputAmount: fillObject.relayExecutionInfo.updatedOutputAmount,
          fillType,
        },
        blockNumber: fillEventOverride?.blockNumber ?? spokePoolClient_2.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.FillWithBlock);
    }

    function generateSlowFillRequestFromDeposit(
      deposit: interfaces.DepositWithBlock,
      fillEventOverride?: Partial<interfaces.FillWithBlock>
    ): interfaces.Log {
      const fillObject = V3FillFromDeposit(deposit, ZERO_ADDRESS);
      const { relayer, repaymentChainId, relayExecutionInfo, ...relayData } = fillObject;
      return mockDestinationSpokePoolClient.requestV3SlowFill({
        ...relayData,
        blockNumber: fillEventOverride?.blockNumber ?? spokePoolClient_2.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.SlowFillRequestWithBlock);
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

      describe("Pre-fill has invalid repayment information", function () {
        it("Refunds fill to msg.sender if fill is not in-memory and repayment info is invalid", async function () {
          generateV3Deposit({ outputToken: randomAddress() });
          await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
          const deposits = mockOriginSpokePoolClient.getDeposits();

          // Submit fill that we won't include in the bundle block range. Make sure its relayer address is invalid
          // so that the bundle data client is forced to overwrite the refund recipient.
          const fill = generateV3FillFromDeposit(deposits[0], { method: "fillRelay" }, createRandomBytes32());
          const fillWithBlock = {
            ...spreadEventWithBlockNumber(fill),
            destinationChainId,
          } as FillWithBlock;
          (dataworkerInstance.clients.bundleDataClient as MockBundleDataClient).setMatchingFillEvent(
            deposits[0],
            fillWithBlock
          );

          // Don't include the fill event in the update so that the bundle data client is forced to load the event
          // fresh.
          await mockDestinationSpokePoolClient.update([]);
          expect(mockDestinationSpokePoolClient.getFills().length).to.equal(0);

          // Mock FillStatus to be Filled so that the BundleDataClient searches for event.
          mockDestinationSpokePoolClient.setRelayFillStatus(deposits[0], interfaces.FillStatus.Filled);

          // Replace the dataworker providers to use mock providers. We need to explicitly do this since we do not actually perform a contract call, so
          // we must inject a transaction response into the provider to simulate the case when the relayer repayment address is invalid
          // but the msg.sender is valid.
          const provider = new providers.mocks.MockedProvider(bnZero, bnZero, destinationChainId);
          const validRelayerAddress = randomAddress();
          provider._setTransaction(fill.transactionHash, {
            from: validRelayerAddress,
          } as unknown as TransactionResponse);
          const spokeWrapper = new Contract(
            mockDestinationSpokePoolClient.spokePool.address,
            mockDestinationSpokePoolClient.spokePool.interface,
            provider
          );
          mockDestinationSpokePoolClient.spokePool = spokeWrapper;

          // The fill is a pre-fill because its earlier than the bundle block range. Because its corresponding
          // deposit is in the block range, we should refund it.
          const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
            getDefaultBlockRange(5),
            spokePoolClients
          );
          expect(data1.bundleFillsV3[destinationChainId][erc20_2.address].fills.length).to.equal(1);
          expect(data1.bundleFillsV3[destinationChainId][erc20_2.address].fills[0].depositId).to.equal(
            fill.args.depositId
          );
          // Check its refunded to correct address:
          expect(data1.bundleFillsV3[destinationChainId][erc20_2.address].fills[0].relayer).to.equal(
            validRelayerAddress
          );
        });

        it("Refunds fill to msg.sender if fill is in-memory and repayment info is invalid", async function () {
          generateV3Deposit({ outputToken: randomAddress() });
          await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
          const deposits = mockOriginSpokePoolClient.getDeposits();

          // Submit fill with invalid relayer address so that the bundle data client is forced to
          // overwrite the refund recipient.
          const fill = generateV3FillFromDeposit(deposits[0], { method: "fillRelay" }, createRandomBytes32());
          await mockDestinationSpokePoolClient.update(["FilledRelay"]);
          expect(mockDestinationSpokePoolClient.getFills().length).to.equal(1);

          // Replace the dataworker providers to use mock providers. We need to explicitly do this since we do not actually perform a contract call, so
          // we must inject a transaction response into the provider to simulate the case when the relayer repayment address is invalid
          // but the msg.sender is valid.
          const provider = new providers.mocks.MockedProvider(bnZero, bnZero, destinationChainId);
          const validRelayerAddress = randomAddress();
          provider._setTransaction(fill.transactionHash, {
            from: validRelayerAddress,
          } as unknown as TransactionResponse);
          const spokeWrapper = new Contract(
            mockDestinationSpokePoolClient.spokePool.address,
            mockDestinationSpokePoolClient.spokePool.interface,
            provider
          );
          mockDestinationSpokePoolClient.spokePool = spokeWrapper;

          // The fill is a pre-fill because its earlier than the bundle block range. Because its corresponding
          // deposit is in the block range, we should refund it.
          const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
            getDefaultBlockRange(5),
            spokePoolClients
          );
          expect(data1.bundleFillsV3[destinationChainId][erc20_2.address].fills.length).to.equal(1);
          expect(data1.bundleFillsV3[destinationChainId][erc20_2.address].fills[0].depositId).to.equal(
            fill.args.depositId
          );
          // Check its refunded to correct address:
          expect(data1.bundleFillsV3[destinationChainId][erc20_2.address].fills[0].relayer).to.equal(
            validRelayerAddress
          );
        });

        it("Does not refund fill to msg.sender if fill is not in-memory and repayment address and msg.sender are invalid for repayment chain", async function () {
          generateV3Deposit({ outputToken: randomAddress() });
          await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
          const deposits = mockOriginSpokePoolClient.getDeposits();

          // Send fill with invalid repayment address
          const invalidRelayer = ethers.utils.randomBytes(32);
          const invalidFillEvent = generateV3FillFromDeposit(deposits[0], { method: "fillRelay" }, invalidRelayer);
          const invalidFill = {
            ...spreadEventWithBlockNumber(invalidFillEvent),
            destinationChainId,
          } as FillWithBlock;
          await mockDestinationSpokePoolClient.update([]);

          // Replace the dataworker providers to use mock providers. We need to explicitly do this since we do not actually perform a contract call, so
          // we must inject a transaction response into the provider to simulate the case when the relayer repayment address is invalid. In this case,
          // set the msg.sender as an invalid address.
          const provider = new providers.mocks.MockedProvider(bnZero, bnZero, destinationChainId);
          const spokeWrapper = new Contract(
            mockDestinationSpokePoolClient.spokePool.address,
            mockDestinationSpokePoolClient.spokePool.interface,
            provider
          );
          provider._setTransaction(invalidFillEvent.transactionHash, { from: invalidRelayer });
          mockDestinationSpokePoolClient.spokePool = spokeWrapper;

          // Mock FillStatus to be Filled for any invalid fills otherwise the BundleDataClient will
          // query relayStatuses() on the spoke pool.
          mockDestinationSpokePoolClient.setRelayFillStatus(deposits[0], interfaces.FillStatus.Filled);
          // Also mock the matched fill event so that BundleDataClient doesn't query for it.
          (dataworkerInstance.clients.bundleDataClient as MockBundleDataClient).setMatchingFillEvent(
            deposits[0],
            invalidFill
          );

          const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
            getDefaultBlockRange(5),
            spokePoolClients
          );

          expect(data1.bundleFillsV3).to.deep.equal({});
          expect(spy.getCalls().filter((e) => e.lastArg.message.includes("unrepayable")).length).to.equal(1);
        });

        it("Does not refund fill to msg.sender if fill is in-memory and repayment address and msg.sender are invalid for repayment chain", async function () {
          generateV3Deposit({ outputToken: randomAddress() });
          await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
          const deposits = mockOriginSpokePoolClient.getDeposits();

          // Send fill with invalid repayment address
          const invalidRelayer = ethers.utils.randomBytes(32);
          const invalidFillEvent = generateV3FillFromDeposit(deposits[0], { method: "fillRelay" }, invalidRelayer);
          await mockDestinationSpokePoolClient.update(["FilledRelay"]);

          // Replace the dataworker providers to use mock providers. We need to explicitly do this since we do not actually perform a contract call, so
          // we must inject a transaction response into the provider to simulate the case when the relayer repayment address is invalid. In this case,
          // set the msg.sender as an invalid address.
          const provider = new providers.mocks.MockedProvider(bnZero, bnZero, destinationChainId);
          const spokeWrapper = new Contract(
            mockDestinationSpokePoolClient.spokePool.address,
            mockDestinationSpokePoolClient.spokePool.interface,
            provider
          );
          provider._setTransaction(invalidFillEvent.transactionHash, { from: invalidRelayer });
          mockDestinationSpokePoolClient.spokePool = spokeWrapper;

          const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
            getDefaultBlockRange(5),
            spokePoolClients
          );

          expect(data1.bundleFillsV3).to.deep.equal({});
          expect(spy.getCalls().filter((e) => e.lastArg.message.includes("unrepayable")).length).to.equal(1);
        });

        it("Does not refund lite chain fill to msg.sender if fill is not in-memory and repayment address and msg.sender are invalid for origin chain", async function () {
          generateV3Deposit({ outputToken: randomAddress(), fromLiteChain: true });
          await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
          const deposits = mockOriginSpokePoolClient.getDeposits();

          // Fill deposits from different relayers
          const invalidRelayer = ethers.utils.randomBytes(32);
          const invalidFillEvent = generateV3FillFromDeposit(deposits[0], { method: "fillRelay" }, invalidRelayer);
          const invalidFill = {
            ...spreadEventWithBlockNumber(invalidFillEvent),
            destinationChainId,
          } as FillWithBlock;
          await mockDestinationSpokePoolClient.update([]);
          // Replace the dataworker providers to use mock providers. We need to explicitly do this since we do not actually perform a contract call, so
          // we must inject a transaction response into the provider to simulate the case when the relayer repayment address is invalid. In this case,
          // set the msg.sender as an invalid address.
          const provider = new providers.mocks.MockedProvider(bnZero, bnZero, destinationChainId);
          const spokeWrapper = new Contract(
            mockDestinationSpokePoolClient.spokePool.address,
            mockDestinationSpokePoolClient.spokePool.interface,
            provider
          );
          provider._setTransaction(invalidFillEvent.transactionHash, { from: invalidRelayer });
          mockDestinationSpokePoolClient.spokePool = spokeWrapper;

          // Mock FillStatus to be Filled for any invalid fills otherwise the BundleDataClient will
          // query relayStatuses() on the spoke pool.
          mockDestinationSpokePoolClient.setRelayFillStatus(deposits[0], interfaces.FillStatus.Filled);
          // Also mock the matched fill event so that BundleDataClient doesn't query for it.
          (dataworkerInstance.clients.bundleDataClient as MockBundleDataClient).setMatchingFillEvent(
            deposits[0],
            invalidFill
          );

          const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
            getDefaultBlockRange(5),
            spokePoolClients
          );

          expect(data1.bundleFillsV3).to.deep.equal({});
          expect(spy.getCalls().filter((e) => e.lastArg.message.includes("unrepayable")).length).to.equal(1);
        });

        it("Does not refund lite chain fill to msg.sender if fill is in-memory and repayment address and msg.sender are invalid for origin chain", async function () {
          generateV3Deposit({ outputToken: randomAddress(), fromLiteChain: true });
          await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
          const deposits = mockOriginSpokePoolClient.getDeposits();

          // Fill deposits from different relayers
          const invalidRelayer = ethers.utils.randomBytes(32);
          const invalidFillEvent = generateV3FillFromDeposit(deposits[0], { method: "fillRelay" }, invalidRelayer);
          await mockDestinationSpokePoolClient.update(["FilledRelay"]);
          // Replace the dataworker providers to use mock providers. We need to explicitly do this since we do not actually perform a contract call, so
          // we must inject a transaction response into the provider to simulate the case when the relayer repayment address is invalid. In this case,
          // set the msg.sender as an invalid address.
          const provider = new providers.mocks.MockedProvider(bnZero, bnZero, destinationChainId);
          const spokeWrapper = new Contract(
            mockDestinationSpokePoolClient.spokePool.address,
            mockDestinationSpokePoolClient.spokePool.interface,
            provider
          );
          provider._setTransaction(invalidFillEvent.transactionHash, { from: invalidRelayer });
          mockDestinationSpokePoolClient.spokePool = spokeWrapper;

          const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
            getDefaultBlockRange(5),
            spokePoolClients
          );

          expect(data1.bundleFillsV3).to.deep.equal({});
          expect(spy.getCalls().filter((e) => e.lastArg.message.includes("unrepayable")).length).to.equal(1);
        });
      });

      it("Refunds deposit as a duplicate if fill is not in-memory and is a slow fill", async function () {
        generateV3Deposit({ outputToken: randomAddress() });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDeposits();

        // Submit fill that we won't include in the bundle block range.
        const fill = generateV3FillFromDeposit(
          deposits[0],
          { method: "fillRelay" },
          undefined,
          undefined,
          interfaces.FillType.SlowFill
        );
        const fillWithBlock = {
          ...spreadEventWithBlockNumber(fill),
          destinationChainId,
        } as FillWithBlock;
        (dataworkerInstance.clients.bundleDataClient as MockBundleDataClient).setMatchingFillEvent(
          deposits[0],
          fillWithBlock
        );

        // Don't include the fill event in the update so that the bundle data client is forced to load the event
        // fresh.
        await mockDestinationSpokePoolClient.update([]);
        expect(mockDestinationSpokePoolClient.getFills().length).to.equal(0);

        // Mock FillStatus to be Filled so that the BundleDataClient searches for event.
        mockDestinationSpokePoolClient.setRelayFillStatus(deposits[0], interfaces.FillStatus.Filled);

        // The fill is a pre-fill because its earlier than the bundle block range. Because its corresponding
        // deposit is in the block range, we should refund it.
        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
          getDefaultBlockRange(5),
          spokePoolClients
        );
        expect(data1.bundleFillsV3).to.deep.equal({});
        // Should refund the deposit:
        expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);
      });

      it("Refunds pre-fills in-memory for duplicate deposits", async function () {
        // In this test, we send multiple deposits per fill. We assume you cannot send more than one fill per deposit.
        generateV3Deposit({ outputToken: randomAddress() });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        await mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]);
        await mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]);
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDepositsForDestinationChainWithDuplicates(destinationChainId);
        expect(deposits.length).to.equal(3);

        // Submit fill that we won't include in the bundle block range.
        const fill = generateV3FillFromDeposit(deposits[0], {
          method: "fillRelay",
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber,
        });
        // Substitute bundle block ranges.
        const bundleBlockRanges = getDefaultBlockRange(5);
        const destinationChainIndex =
          dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
        bundleBlockRanges[destinationChainIndex] = [fill.blockNumber + 1, fill.blockNumber + 2];

        await mockDestinationSpokePoolClient.update(["FilledRelay"]);
        expect(mockDestinationSpokePoolClient.getFills().length).to.equal(1);

        // This should return one refund for each pre-fill.
        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(3);
        expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(3);
        // Duplicate deposits should not be refunded to depositor
        expect(data1.expiredDepositsToRefundV3).to.deep.equal({});
      });

      it("Refunds duplicate deposits if pre-fill is not in memory", async function () {
        generateV3Deposit({ outputToken: randomAddress() });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        await mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]);
        await mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]);
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDepositsForDestinationChainWithDuplicates(destinationChainId);
        expect(deposits.length).to.equal(3);

        // Submit fill that we won't include in the bundle block range
        const fill = generateV3FillFromDeposit(deposits[0], { method: "fillRelay" });
        const fillWithBlock = {
          ...spreadEventWithBlockNumber(fill),
          destinationChainId,
        } as FillWithBlock;
        (dataworkerInstance.clients.bundleDataClient as MockBundleDataClient).setMatchingFillEvent(
          deposits[0],
          fillWithBlock
        );

        // Don't include the fill event in the update so that the bundle data client is forced to load the event
        // fresh.
        await mockDestinationSpokePoolClient.update([]);
        expect(mockDestinationSpokePoolClient.getFills().length).to.equal(0);

        // Mock FillStatus to be Filled so that the BundleDataClient searches for event.
        mockDestinationSpokePoolClient.setRelayFillStatus(deposits[0], interfaces.FillStatus.Filled);

        // The fill is a pre-fill because its earlier than the bundle block range. Because its corresponding
        // deposit is in the block range, we refund the pre-fill once per duplicate deposit.
        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
          getDefaultBlockRange(5),
          spokePoolClients
        );
        expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(3);
        expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(3);
        expect(data1.expiredDepositsToRefundV3).to.deep.equal({});
      });

      it("Does not refund fill if fill is in-memory but in a future bundle", async function () {
        generateV3Deposit({ outputToken: randomAddress() });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDeposits();

        // Submit fill that we won't include in the bundle block range but is in a future bundle
        const futureFill = generateV3FillFromDeposit(deposits[0], {
          method: "fillRelay",
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 11,
        });

        // Substitute bundle block ranges.
        const bundleBlockRanges = getDefaultBlockRange(5);
        const destinationChainIndex =
          dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
        bundleBlockRanges[destinationChainIndex] = [futureFill.blockNumber - 2, futureFill.blockNumber - 1];

        await mockDestinationSpokePoolClient.update(["FilledRelay"]);
        expect(mockDestinationSpokePoolClient.getFills().length).to.equal(1);

        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleFillsV3).to.deep.equal({});
      });

      it("Refunds deposit as duplicate if fill is in-memory but its a SlowFill", async function () {
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
        // Should refund the deposit:
        expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);
      });
    });

    describe("Pre-slow-fill-requests", function () {
      it("Creates slow fill leaf if slow fill request is in-memory and in older bundle", async function () {
        generateV3Deposit({ outputToken: erc20_2.address });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDeposits();

        // Submit request that is older than the bundle block range.
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

      it("Creates one leaf for duplicate deposits", async function () {
        const deposit = generateV3Deposit({ outputToken: erc20_2.address });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        await mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]); // Duplicate deposit
        await mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]); // Duplicate deposit
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDepositsForDestinationChainWithDuplicates(destinationChainId);
        expect(deposits.length).to.equal(3);

        // Submit request for prior bundle.
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
        expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(3);
        expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address].length).to.equal(1);
        expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address][0].depositId).to.equal(
          deposit.args.depositId
        );

        // The first deposit should be matched which is important because the quote timestamp of the deposit is not
        // in the relay data hash so it can change between duplicate deposits.
        expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address][0].transactionHash).to.equal(
          deposit.transactionHash
        );
      });

      it("Does not create slow fill leaf if slow fill request is in-memory but an invalid request", async function () {
        generateV3Deposit({ outputToken: randomAddress() }); // Token swap
        generateV3Deposit({ outputToken: erc20_2.address, fillDeadline: 0 }); // Fill deadline expired
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDeposits();

        // Submit request that is in a previous bundle but is invalid.
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
        await mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]); // Duplicate deposit
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDepositsForDestinationChainWithDuplicates(destinationChainId);
        expect(deposits.length).to.equal(2);

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
        generateV3Deposit({ outputToken: randomAddress() }); // Token swap
        generateV3Deposit({ outputToken: erc20_2.address, fillDeadline: 0 }); // Fill deadline expired
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
