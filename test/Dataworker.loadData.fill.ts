import {
  BundleDataClient,
  ConfigStoreClient,
  GLOBAL_CONFIG_STORE_KEYS,
  HubPoolClient,
  SpokePoolClient,
} from "../src/clients";
import { amountToDeposit, destinationChainId, originChainId, repaymentChainId } from "./constants";
import { DataworkerConfig, setupDataworker } from "./fixtures/Dataworker.Fixture";
import {
  Contract,
  FakeContract,
  SignerWithAddress,
  V3FillFromDeposit,
  assertPromiseError,
  depositV3,
  ethers,
  expect,
  fillV3Relay,
  getDefaultBlockRange,
  getDisabledBlockRanges,
  randomAddress,
  sinon,
  smock,
  spyLogIncludes,
} from "./utils";

import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { getCurrentTime, toBN, toBNWei, fixedPointAdjustment, ZERO_ADDRESS, BigNumber, bnZero } from "../src/utils";
import {
  MockBundleDataClient,
  MockConfigStoreClient,
  MockHubPoolClient,
  MockSpokePoolClient,
  MockArweaveClient,
} from "./mocks";
import { interfaces, constants as sdkConstants, providers } from "@across-protocol/sdk";
import { cloneDeep } from "lodash";
import { CombinedRefunds } from "../src/dataworker/DataworkerUtils";
import { INFINITE_FILL_DEADLINE } from "../src/common";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient, bundleDataClient: BundleDataClient;
let hubPoolClient: HubPoolClient, configStoreClient: ConfigStoreClient;
let dataworkerInstance: Dataworker;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let spy: sinon.SinonSpy;

let updateAllClients: () => Promise<void>;

describe("Dataworker: Load bundle data", async function () {
  beforeEach(async function () {
    ({
      spokePool_1,
      erc20_1,
      spokePool_2,
      erc20_2,
      configStoreClient,
      hubPoolClient,
      l1Token_1,
      depositor,
      relayer,
      dataworkerInstance,
      spokePoolClient_1,
      spokePoolClient_2,
      spokePoolClients,
      updateAllClients,
      spy,
    } = await setupDataworker(ethers, 25, 25, 0));
    bundleDataClient = dataworkerInstance.clients.bundleDataClient;
  });

  it("Default conditions", async function () {
    await configStoreClient.update();

    // Throws error if hub pool client is not updated.
    await hubPoolClient.update();

    // Throws error if spoke pool clients not updated
    await assertPromiseError(bundleDataClient.loadData(getDefaultBlockRange(0), spokePoolClients), "SpokePoolClient");
    await spokePoolClient_1.update();
    await spokePoolClient_2.update();

    // Before any deposits, returns empty dictionaries.
    await updateAllClients();
    expect(await bundleDataClient.loadData(getDefaultBlockRange(1), spokePoolClients)).to.deep.equal({
      bundleDepositsV3: {},
      expiredDepositsToRefundV3: {},
      bundleFillsV3: {},
      unexecutableSlowFills: {},
      bundleSlowFillsV3: {},
    });
  });

  describe("Compute fills to refund", function () {
    let mockOriginSpokePoolClient: MockSpokePoolClient, mockDestinationSpokePoolClient: MockSpokePoolClient;
    let mockHubPoolClient: MockHubPoolClient;
    let mockDestinationSpokePool: FakeContract;
    let mockConfigStore: MockConfigStoreClient;
    const lpFeePct = toBNWei("0.01");

    beforeEach(async function () {
      await updateAllClients();
      mockHubPoolClient = new MockHubPoolClient(
        hubPoolClient.logger,
        hubPoolClient.hubPool,
        configStoreClient,
        hubPoolClient.deploymentBlock,
        hubPoolClient.chainId
      );
      mockConfigStore = new MockConfigStoreClient(
        configStoreClient.logger,
        configStoreClient.configStore,
        undefined,
        undefined,
        undefined,
        undefined,
        true
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
        inputAmount: eventOverride?.inputAmount ?? undefined,
        outputToken: eventOverride?.outputToken ?? erc20_2.address,
        message: eventOverride?.message ?? "0x",
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

    function generateV3FillFromDepositEvent(
      depositEvent: interfaces.Log,
      fillEventOverride?: Partial<interfaces.FillWithBlock>,
      _relayer = relayer.address,
      _repaymentChainId = repaymentChainId,
      fillType = interfaces.FillType.FastFill,
      outputAmount: BigNumber = depositEvent.args.outputAmount,
      updatedOutputAmount: BigNumber = depositEvent.args.outputAmount
    ): interfaces.Log {
      const { args } = depositEvent;
      return mockDestinationSpokePoolClient.fillV3Relay({
        ...args,
        relayer: _relayer,
        outputAmount,
        repaymentChainId: _repaymentChainId,
        relayExecutionInfo: {
          updatedRecipient: depositEvent.args.updatedRecipient,
          updatedMessage: depositEvent.args.updatedMessage,
          updatedOutputAmount: updatedOutputAmount,
          fillType,
        },
        blockNumber: fillEventOverride?.blockNumber ?? spokePoolClient_2.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.FillWithBlock);
    }

    it("Does not refund fills for zero value deposits", async function () {
      generateV3Deposit({
        inputAmount: bnZero,
        message: "0x",
      });
      generateV3Deposit({
        inputAmount: bnZero,
        message: "0x",
      });

      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();
      generateV3FillFromDeposit(deposits[0]);
      generateV3FillFromDeposit({
        ...deposits[1],
        messageHash: sdkConstants.ZERO_BYTES,
      });

      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );

      expect(data1.bundleFillsV3).to.deep.equal({});
      expect(spy.getCalls().filter((e) => e.lastArg.message.includes("invalid fills")).length).to.equal(0);
    });

    describe("Duplicate deposits in same bundle as fill", function () {
      it("Sends duplicate deposit refunds for fills in bundle", async function () {
        // Send duplicate deposits.
        generateV3Deposit({ outputToken: randomAddress() });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        await mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]); // Duplicate deposit
        await mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]); // Duplicate deposit
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDepositsForDestinationChainWithDuplicates(destinationChainId);
        expect(deposits.length).to.equal(3);

        // Fill deposit.
        generateV3FillFromDeposit(deposits[0]);
        await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);

        // Bundle should contain all deposits.
        // Bundle should refund fill.
        // Bundle should refund duplicate deposits to filler
        const bundleBlockRanges = getDefaultBlockRange(5);
        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(3);
        expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(3);
        expect(data1.expiredDepositsToRefundV3).to.deep.equal({});
      });

      it("Sends duplicate deposit refunds for slow fills in bundle", async function () {
        // Send duplicate deposits.
        generateV3Deposit({ outputToken: randomAddress() });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const dupe1 = await mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]); // Duplicate deposit
        const dupe2 = await mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]); // Duplicate deposit
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDepositsForDestinationChainWithDuplicates(destinationChainId);
        expect(deposits.length).to.equal(3);

        // Fill deposit as slow fill
        generateV3FillFromDeposit(deposits[0], {}, undefined, undefined, interfaces.FillType.SlowFill);
        await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);

        // Bundle should contain all deposits.
        // Bundle should refund fill.
        // Bundle should refund duplicate deposits to depositor
        const bundleBlockRanges = getDefaultBlockRange(5);
        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleFillsV3[destinationChainId][erc20_2.address].fills.length).to.equal(1);
        expect(data1.bundleFillsV3[destinationChainId][erc20_2.address].refunds).to.deep.equal({});
        expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(3);
        expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(2);
        expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address][0].transactionHash).to.equal(
          dupe1.transactionHash
        );
        expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address][1].transactionHash).to.equal(
          dupe2.transactionHash
        );
      });

      it("Does not account for duplicate deposit refunds for deposits after bundle block range", async function () {
        generateV3Deposit({
          outputToken: randomAddress(),
          blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 1,
        });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        await mockOriginSpokePoolClient.depositV3({
          ...mockOriginSpokePoolClient.getDeposits()[0],
          blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 11,
        });
        await mockOriginSpokePoolClient.depositV3({
          ...mockOriginSpokePoolClient.getDeposits()[0],
          blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 21,
        });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDepositsForDestinationChainWithDuplicates(destinationChainId);
        expect(deposits.length).to.equal(3);

        const fill = generateV3FillFromDeposit(deposits[0], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 21,
        });

        // Create a block range that removes latest event
        const destinationChainBlockRange = [fill.blockNumber - 1, fill.blockNumber + 1];
        const originChainBlockRange = [deposits[0].blockNumber, deposits[1].blockNumber];
        // Substitute bundle block ranges.
        const bundleBlockRanges = getDefaultBlockRange(5);
        const destinationChainIndex =
          dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
        bundleBlockRanges[destinationChainIndex] = destinationChainBlockRange;
        const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
        bundleBlockRanges[originChainIndex] = originChainBlockRange;
        await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(2);
        expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(2);
        expect(data1.expiredDepositsToRefundV3).to.deep.equal({});
      });

      it("Does not send duplicate deposit refunds if relayer repayment information is invalid", async function () {
        // Send duplicate deposits.
        generateV3Deposit({ outputToken: randomAddress() });
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        await mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]); // Duplicate deposit
        await mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]); // Duplicate deposit
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDepositsForDestinationChainWithDuplicates(destinationChainId);
        expect(deposits.length).to.equal(3);

        // Fill deposit with invalid repayment information.
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

        // Bundle should contain all deposits.
        const bundleBlockRanges = getDefaultBlockRange(5);
        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
        expect(data1.bundleFillsV3).to.deep.equal({});
        expect(spy.getCalls().filter((e) => e.lastArg.message.includes("unrepayable")).length).to.equal(1);
        expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(3);
        expect(data1.expiredDepositsToRefundV3).to.deep.equal({});
      });
    });

    it("Does not create unexecutable slow fill for zero value deposit", async function () {
      generateV3Deposit({
        inputAmount: bnZero,
        message: "0x",
      });
      generateV3Deposit({
        inputAmount: bnZero,
        message: "0x",
      });

      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();
      generateV3FillFromDeposit(
        {
          ...deposits[0],
        },
        undefined,
        undefined,
        undefined,
        interfaces.FillType.ReplacedSlowFill
      );
      generateV3FillFromDeposit(
        {
          ...deposits[1],
          message: sdkConstants.ZERO_BYTES,
        },
        undefined,
        undefined,
        undefined,
        interfaces.FillType.ReplacedSlowFill
      );

      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );

      expect(data1.unexecutableSlowFills).to.deep.equal({});
    });
    it("Saves V3 fast fill under correct repayment chain and repayment token", async function () {
      const depositV3Events: Event[] = [];
      const fillV3Events: Event[] = [];

      // Create three valid deposits
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();

      // Fill deposits from different relayers
      const relayer2 = randomAddress();
      fillV3Events.push(generateV3FillFromDeposit(deposits[0]));
      fillV3Events.push(generateV3FillFromDeposit(deposits[1]));
      fillV3Events.push(generateV3FillFromDeposit(deposits[2], {}, relayer2));
      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );

      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(depositV3Events.length);
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.map((e) => e.depositId)).to.deep.equal(
        fillV3Events.map((event) => event.args.depositId)
      );
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.map((e) => e.lpFeePct)).to.deep.equal(
        fillV3Events.map(() => lpFeePct)
      );
      const totalGrossRefundAmount = fillV3Events.reduce((agg, e) => agg.add(e.args.inputAmount), toBN(0));
      const totalV3LpFees = totalGrossRefundAmount.mul(lpFeePct).div(fixedPointAdjustment);
      expect(totalV3LpFees).to.equal(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].realizedLpFees);
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].totalRefundAmount).to.equal(
        totalGrossRefundAmount.sub(totalV3LpFees)
      );
      const refundAmountPct = fixedPointAdjustment.sub(lpFeePct);
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].refunds).to.deep.equal({
        [relayer.address]: fillV3Events
          .slice(0, fillV3Events.length - 1)
          .reduce((agg, e) => agg.add(e.args.inputAmount), toBN(0))
          .mul(refundAmountPct)
          .div(fixedPointAdjustment),
        [relayer2]: fillV3Events[fillV3Events.length - 1].args.inputAmount
          .mul(refundAmountPct)
          .div(fixedPointAdjustment),
      });
    });
    it("Ignores disabled chains", async function () {
      const depositV3Events: Event[] = [];
      const fillV3Events: Event[] = [];

      // Create three valid deposits
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();

      // Fill deposits from different relayers
      const relayer2 = randomAddress();
      fillV3Events.push(generateV3FillFromDeposit(deposits[0]));
      fillV3Events.push(generateV3FillFromDeposit(deposits[1]));
      fillV3Events.push(generateV3FillFromDeposit(deposits[2], {}, relayer2));
      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
      const emptyData = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDisabledBlockRanges(),
        spokePoolClients
      );
      expect(emptyData.bundleFillsV3).to.deep.equal({});
    });
    it("Saves V3 fast fill under correct repayment chain and repayment token when dealing with lite chains", async function () {
      // Mock the config store client to include the lite chain index.
      mockConfigStore.updateGlobalConfig(
        GLOBAL_CONFIG_STORE_KEYS.LITE_CHAIN_ID_INDICES,
        JSON.stringify([originChainId])
      );
      await mockConfigStore.update();
      // Ensure that our test has the right setup.
      expect(mockConfigStore.liteChainIndicesUpdates.length).to.equal(1);
      mockConfigStore.liteChainIndicesUpdates[0].timestamp = 0;
      expect(repaymentChainId).to.not.eq(originChainId);

      // Mock the config store client being included on the spoke client
      mockOriginSpokePoolClient.setConfigStoreClient(mockConfigStore);

      const depositV3Events: Event[] = [];
      const fillV3Events: Event[] = [];

      // Create three valid deposits
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();

      // Fill deposits from different relayers
      const relayer2 = randomAddress();
      fillV3Events.push(generateV3FillFromDeposit(deposits[0]));
      fillV3Events.push(generateV3FillFromDeposit(deposits[1]));
      fillV3Events.push(generateV3FillFromDeposit(deposits[2], {}, relayer2));
      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );

      expect(data1.bundleFillsV3[originChainId][erc20_1.address].fills.length).to.equal(depositV3Events.length);
      expect(data1.bundleFillsV3[originChainId][erc20_1.address].fills.map((e) => e.depositId)).to.deep.equal(
        fillV3Events.map((event) => event.args.depositId)
      );
      expect(data1.bundleFillsV3[originChainId][erc20_1.address].fills.map((e) => e.lpFeePct)).to.deep.equal(
        fillV3Events.map(() => lpFeePct)
      );
      const totalGrossRefundAmount = fillV3Events.reduce((agg, e) => agg.add(e.args.inputAmount), toBN(0));
      const totalV3LpFees = totalGrossRefundAmount.mul(lpFeePct).div(fixedPointAdjustment);
      expect(totalV3LpFees).to.equal(data1.bundleFillsV3[originChainId][erc20_1.address].realizedLpFees);
      expect(data1.bundleFillsV3[originChainId][erc20_1.address].totalRefundAmount).to.equal(
        totalGrossRefundAmount.sub(totalV3LpFees)
      );
      const refundAmountPct = fixedPointAdjustment.sub(lpFeePct);
      expect(data1.bundleFillsV3[originChainId][erc20_1.address].refunds).to.deep.equal({
        [relayer.address]: fillV3Events
          .slice(0, fillV3Events.length - 1)
          .reduce((agg, e) => agg.add(e.args.inputAmount), toBN(0))
          .mul(refundAmountPct)
          .div(fixedPointAdjustment),
        [relayer2]: fillV3Events[fillV3Events.length - 1].args.inputAmount
          .mul(refundAmountPct)
          .div(fixedPointAdjustment),
      });
    });

    it("Validates fill against old deposit if deposit is not in-memory", async function () {
      // For this test, we need to actually send a deposit on the spoke pool
      // because queryHistoricalDepositForFill eth_call's the contract.

      // Send a legacy deposit.
      const depositObject = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        erc20_2.address,
        amountToDeposit,
        {
          fillDeadline: INFINITE_FILL_DEADLINE.toNumber(),
        }
      );
      const depositBlock = await spokePool_1.provider.getBlockNumber();

      // Construct a spoke pool client with a small search range that would not include the deposit.
      spokePoolClient_1.firstBlockToSearch = depositBlock + 1;
      spokePoolClient_1.eventSearchConfig.fromBlock = spokePoolClient_1.firstBlockToSearch;
      await spokePoolClient_1.update();
      const deposits = spokePoolClient_1.getDeposits();
      expect(deposits.length).to.equal(0);

      // Send a fill now and force the bundle data client to query for the historical deposit.
      await fillV3Relay(spokePool_2, depositObject, relayer, repaymentChainId);
      await updateAllClients();
      const fills = spokePoolClient_2.getFills();
      expect(fills.length).to.equal(1);

      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
        ...spokePoolClients,
        [originChainId]: spokePoolClient_1,
        [destinationChainId]: spokePoolClient_2,
      });
      expect(spyLogIncludes(spy, -4, "Located V3 deposit outside of SpokePoolClient's search range")).is.true;
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
      expect(data1.bundleDepositsV3).to.deep.equal({});
    });
    it("Does not validate fill against deposit in future bundle if deposit is not in-memory", async function () {
      // For this test, we need to actually send a deposit on the spoke pool
      // because queryHistoricalDepositForFill eth_call's the contract.

      // Send a legacy deposit.
      const depositObject = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        erc20_2.address,
        amountToDeposit,
        {
          fillDeadline: INFINITE_FILL_DEADLINE.toNumber(),
        }
      );

      // Modify the block ranges such that the deposit is in a future bundle block range. This should render
      // the fill invalid.
      const depositBlock = await spokePool_1.provider.getBlockNumber();
      const bundleBlockRanges = getDefaultBlockRange(5);
      const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
      bundleBlockRanges[originChainIndex] = [depositBlock - 2, depositBlock - 1];

      // Construct a spoke pool client with a small search range that would not include the deposit.
      spokePoolClient_1.firstBlockToSearch = depositBlock + 1;
      spokePoolClient_1.eventSearchConfig.fromBlock = spokePoolClient_1.firstBlockToSearch;
      await spokePoolClient_1.update();
      const deposits = spokePoolClient_1.getDeposits();
      expect(deposits.length).to.equal(0);

      // Send a fill now and force the bundle data client to query for the historical deposit.
      await fillV3Relay(spokePool_2, depositObject, relayer, repaymentChainId);
      await updateAllClients();
      const fills = spokePoolClient_2.getFills();
      expect(fills.length).to.equal(1);

      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, {
        ...spokePoolClients,
        [originChainId]: spokePoolClient_1,
        [destinationChainId]: spokePoolClient_2,
      });
      expect(data1.bundleFillsV3).to.deep.equal({});
      expect(data1.bundleDepositsV3).to.deep.equal({});
      expect(spy.getCalls().filter((e) => e.lastArg.message.includes("invalid fills")).length).to.equal(1);
    });
    it("Validates fill from lite chain against old bundle deposit", async function () {
      // For this test, we need to actually send a deposit on the spoke pool
      // because queryHistoricalDepositForFill eth_call's the contract.

      // Send a legacy deposit where the fill deadline is infinite, so we can test the bundle data client uses
      // queryHistoricalDepositForFill to find the deposit.
      const depositObject = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        erc20_2.address,
        amountToDeposit,
        {
          fillDeadline: INFINITE_FILL_DEADLINE.toNumber(),
        }
      );
      const depositBlock = await spokePool_1.provider.getBlockNumber();
      // Construct a spoke pool client with a small search range that would not include the deposit.
      spokePoolClient_1.firstBlockToSearch = depositBlock + 1;
      spokePoolClient_1.eventSearchConfig.fromBlock = spokePoolClient_1.firstBlockToSearch;
      await spokePoolClient_1.update();
      const deposits = spokePoolClient_1.getDeposits();
      expect(deposits.length).to.equal(0);

      // Mock the config store client to include the lite chain index.
      mockConfigStore.updateGlobalConfig(
        GLOBAL_CONFIG_STORE_KEYS.LITE_CHAIN_ID_INDICES,
        JSON.stringify([originChainId])
      );
      await mockConfigStore.update();
      // Ensure that our test has the right setup.
      expect(mockConfigStore.liteChainIndicesUpdates.length).to.equal(1);
      mockConfigStore.liteChainIndicesUpdates[0].timestamp = depositObject.quoteTimestamp - 1;
      expect(mockConfigStore.liteChainIndicesUpdates[0].timestamp).to.be.lt(depositObject.quoteTimestamp);
      expect(repaymentChainId).to.not.eq(originChainId);

      // Mock the config store client being included on the spoke client
      (spokePoolClient_1 as any).configStoreClient = mockConfigStore;

      // Send a fill now and force the bundle data client to query for the historical deposit.
      await fillV3Relay(spokePool_2, depositObject, relayer, repaymentChainId);
      await updateAllClients();
      const fills = spokePoolClient_2.getFills();
      expect(fills.length).to.equal(1);

      // Load information needed to build a bundle
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
        ...spokePoolClients,
        [originChainId]: spokePoolClient_1,
        [destinationChainId]: spokePoolClient_2,
      });
      expect(spyLogIncludes(spy, -4, "Located V3 deposit outside of SpokePoolClient's search range")).is.true;

      // Ensure the repayment chain id is not in the bundle data.
      expect(data1.bundleFillsV3[repaymentChainId]).to.be.undefined;
      // Make sure that the origin data is in fact populated
      expect(data1.bundleFillsV3[originChainId][erc20_1.address].fills.length).to.eq(1);
      expect(data1.bundleDepositsV3).to.deep.equal({});
    });
    it("Searches for old deposit for fill but cannot find matching one", async function () {
      // For this test, we need to actually send a deposit on the spoke pool
      // because queryHistoricalDepositForFill eth_call's the contract.

      // Send a legacy deposit.
      const depositObject = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        erc20_2.address,
        amountToDeposit,
        {
          fillDeadline: INFINITE_FILL_DEADLINE.toNumber(),
        }
      );
      const depositBlock = await spokePool_1.provider.getBlockNumber();

      // Construct a spoke pool client with a small search range that would not include the deposit.
      spokePoolClient_1.firstBlockToSearch = depositBlock + 1;
      spokePoolClient_1.eventSearchConfig.fromBlock = spokePoolClient_1.firstBlockToSearch;
      await spokePoolClient_1.update();
      const deposits = spokePoolClient_1.getDeposits();
      expect(deposits.length).to.equal(0);

      // Send a fill now and force the bundle data client to query for the historical deposit.
      // However, send a fill that doesn't match with the above deposit. This should produce an invalid fill.
      await fillV3Relay(spokePool_2, { ...depositObject, depositId: depositObject.depositId.add(1) }, relayer);
      await updateAllClients();
      const fills = spokePoolClient_2.getFills();
      expect(fills.length).to.equal(1);

      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
        ...spokePoolClients,
        [originChainId]: spokePoolClient_1,
        [destinationChainId]: spokePoolClient_2,
      });
      expect(data1.bundleFillsV3).to.deep.equal({});
      expect(data1.bundleDepositsV3).to.deep.equal({});
    });
    it("Filters fills out of block range", async function () {
      generateV3Deposit({
        outputToken: randomAddress(),
        blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 1,
      });
      generateV3Deposit({
        outputToken: randomAddress(),
        blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 11,
      });
      generateV3Deposit({
        outputToken: randomAddress(),
        blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 21,
      });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();

      const fills = [
        generateV3FillFromDeposit(deposits[0], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 1,
        }),
        generateV3FillFromDeposit(deposits[1], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 11,
        }),
        generateV3FillFromDeposit(deposits[2], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 21,
        }),
      ];
      // Create a block range that contains only the middle events.
      const destinationChainBlockRange = [fills[1].blockNumber - 1, fills[1].blockNumber + 1];
      const originChainBlockRange = [deposits[1].blockNumber - 1, deposits[1].blockNumber + 1];
      // Substitute bundle block ranges.
      const bundleBlockRanges = getDefaultBlockRange(5);
      const destinationChainIndex =
        dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
      bundleBlockRanges[destinationChainIndex] = destinationChainBlockRange;
      const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
      bundleBlockRanges[originChainIndex] = originChainBlockRange;
      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
      expect(mockDestinationSpokePoolClient.getFills().length).to.equal(fills.length);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills[0].depositId).to.equal(
        fills[1].args.depositId
      );
    });
    it("Handles invalid fills", async function () {
      const depositEvent = generateV3Deposit();
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const invalidRelayData = {
        depositor: randomAddress(),
        recipient: randomAddress(),
        exclusiveRelayer: randomAddress(),
        inputToken: erc20_2.address,
        outputToken: erc20_1.address,
        inputAmount: depositEvent.args.inputAmount.add(1),
        outputAmount: depositEvent.args.outputAmount.add(1),
        originChainId: destinationChainId,
        depositId: toBN(depositEvent.args.depositId + 1),
        fillDeadline: depositEvent.args.fillDeadline + 1,
        exclusivityDeadline: depositEvent.args.exclusivityDeadline + 1,
        message: randomAddress(),
      };
      for (const [key, val] of Object.entries(invalidRelayData)) {
        const _depositEvent = cloneDeep(depositEvent);
        _depositEvent.args[key] = val;
        if (key === "inputToken") {
          // @dev if input token is changed, make origin chain match the chain where the replacement
          // token address is located so that bundle data client can determine its "repayment" token.
          _depositEvent.args.originChainId = destinationChainId;
        }
        generateV3FillFromDepositEvent(_depositEvent);
      }
      // Send one valid fill as a base test case.
      generateV3FillFromDepositEvent(depositEvent);
      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
      expect(spyLogIncludes(spy, -2, "invalid fills in range")).to.be.true;
    });
    it("Matches fill with deposit with outputToken = 0x0", async function () {
      await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        ZERO_ADDRESS,
        amountToDeposit
      );
      await spokePoolClient_1.update();
      const deposit = spokePoolClient_1.getDeposits()[0];
      await fillV3Relay(spokePool_2, deposit, relayer, repaymentChainId);
      await spokePoolClient_2.update();
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
        ...spokePoolClients,
        [originChainId]: spokePoolClient_1,
        [destinationChainId]: spokePoolClient_2,
      });
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
    });

    it("getBundleTimestampsFromCache and setBundleTimestampsInCache", async function () {
      // Unit test
      await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), spokePoolClients);
      await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(6), spokePoolClients);

      const key1 = JSON.stringify(getDefaultBlockRange(5));
      const key2 = JSON.stringify(getDefaultBlockRange(6));
      const cache1 = dataworkerInstance.clients.bundleDataClient.getBundleTimestampsFromCache(key1);
      const cache2 = dataworkerInstance.clients.bundleDataClient.getBundleTimestampsFromCache(key2);
      expect(cache1).to.not.be.undefined;
      expect(cache2).to.not.be.undefined;

      const key3 = "random";
      expect(dataworkerInstance.clients.bundleDataClient.getBundleTimestampsFromCache(key3)).to.be.undefined;
      const cache3 = { ...cache1, [destinationChainId]: [0, 0] };
      dataworkerInstance.clients.bundleDataClient.setBundleTimestampsInCache(key3, cache3);
      expect(dataworkerInstance.clients.bundleDataClient.getBundleTimestampsFromCache(key3)).to.deep.equal(cache3);
    });
    describe("Load data from Arweave", async function () {
      beforeEach(function () {
        const arweaveClient = new MockArweaveClient("", dataworkerInstance.logger);
        dataworkerInstance.clients.arweaveClient = arweaveClient;
        dataworkerInstance.clients.bundleDataClient.clients.arweaveClient = arweaveClient;
      });
      it("Correctly loads Arweave deposit data with message hashes", async function () {
        const depositV3Events: interfaces.Log[] = [];
        const fillV3Events: interfaces.Log[] = [];
        const blockRanges = getDefaultBlockRange(5);

        depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
        depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
        depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDeposits();

        fillV3Events.push(generateV3FillFromDeposit(deposits[0]));
        fillV3Events.push(generateV3FillFromDeposit(deposits[1]));
        fillV3Events.push(generateV3FillFromDeposit(deposits[2]));
        await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
        const fills = mockDestinationSpokePoolClient.getFills();

        const bundleDepositsV3 = {};
        const bundleFillsV3 = {};
        deposits.forEach((deposit) => {
          const legacyDeposit = {
            ...deposit,
            messageHash: "", // Superstruct defaults to "" for undefined.
          };
          bundleDepositsV3[deposit.originChainId] ??= {};
          bundleDepositsV3[deposit.originChainId][deposit.inputToken] ??= [];
          bundleDepositsV3[deposit.originChainId][deposit.inputToken].push(legacyDeposit);
        });
        fills.forEach((fill) => {
          bundleFillsV3[fill.originChainId] ??= {};
          bundleFillsV3[fill.originChainId][fill.inputToken] ??= {};
          bundleFillsV3[fill.originChainId][fill.inputToken]["fills"] ??= [];
          bundleFillsV3[fill.originChainId][fill.inputToken].fills.push(fill);
        });
        const mockArweaveData = [
          {
            data: {
              bundleDepositsV3,
              bundleFillsV3,
              expiredDepositsToRefundV3: {},
              unexecutableSlowFills: {},
              bundleSlowFillsV3: {},
            },
          },
        ];
        const arweaveCacheKey = dataworkerInstance.clients.bundleDataClient.getArweaveBundleDataClientKey(blockRanges);
        dataworkerInstance.clients.arweaveClient._setCache(arweaveCacheKey, mockArweaveData);

        const data1 = await dataworkerInstance.clients.bundleDataClient.loadPersistedDataFromArweave(blockRanges);
        Object.values(data1.bundleDepositsV3).forEach((x) => {
          Object.values(x).forEach((deposits) => {
            deposits.forEach((deposit) => expect(deposit.messageHash).to.eq(sdkConstants.ZERO_BYTES));
          });
        });
      });
      it("Correctly loads Arweave fill data with message hashes", async function () {
        const depositV3Events: interfaces.Log[] = [];
        const fillV3Events: interfaces.Log[] = [];
        const blockRanges = getDefaultBlockRange(5);

        depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
        depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
        depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDeposits();

        fillV3Events.push(generateV3FillFromDeposit(deposits[0]));
        fillV3Events.push(generateV3FillFromDeposit(deposits[1]));
        fillV3Events.push(generateV3FillFromDeposit(deposits[2]));
        await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
        const fills = mockDestinationSpokePoolClient.getFills();

        const bundleDepositsV3 = {};
        const bundleFillsV3 = {};
        deposits.forEach((deposit) => {
          bundleDepositsV3[deposit.originChainId] ??= {};
          bundleDepositsV3[deposit.originChainId][deposit.inputToken] ??= [];
          bundleDepositsV3[deposit.originChainId][deposit.inputToken].push(deposit);
        });
        fills.forEach((fill) => {
          const legacyFill = {
            ...fill,
            messageHash: "", // Superstruct defaults to "" for undefined.
          };
          bundleFillsV3[fill.originChainId] ??= {};
          bundleFillsV3[fill.originChainId][fill.inputToken] ??= {};
          bundleFillsV3[fill.originChainId][fill.inputToken]["fills"] ??= [];
          bundleFillsV3[fill.originChainId][fill.inputToken].fills.push(legacyFill);
        });
        const mockArweaveData = [
          {
            data: {
              bundleDepositsV3,
              bundleFillsV3,
              expiredDepositsToRefundV3: {},
              unexecutableSlowFills: {},
              bundleSlowFillsV3: {},
            },
          },
        ];
        const arweaveCacheKey = dataworkerInstance.clients.bundleDataClient.getArweaveBundleDataClientKey(blockRanges);
        dataworkerInstance.clients.arweaveClient._setCache(arweaveCacheKey, mockArweaveData);

        const data1 = await dataworkerInstance.clients.bundleDataClient.loadPersistedDataFromArweave(blockRanges);
        Object.values(data1.bundleFillsV3).forEach((x) => {
          Object.values(x).forEach((fills) => {
            fills.fills.forEach((fill) => expect(fill.messageHash).to.eq(sdkConstants.ZERO_BYTES));
          });
        });
      });
    });
    describe("Bytes32 address invalid cases", async function () {
      it("Fallback to msg.sender when the relayer repayment address is invalid on an EVM chain", async function () {
        const depositV3Events: interfaces.Log[] = [];
        const fillV3Events: interfaces.Log[] = [];
        const destinationChainId = mockDestinationSpokePoolClient.chainId;
        // Create three valid deposits
        depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
        depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
        depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDeposits();

        // Fill deposits from different relayers
        const relayer2 = randomAddress();
        fillV3Events.push(generateV3FillFromDeposit(deposits[0], { method: "fillRelay" }));
        fillV3Events.push(generateV3FillFromDeposit(deposits[1], { method: "fillRelay" }));
        fillV3Events.push(
          generateV3FillFromDeposit(
            deposits[2],
            { method: "fillRelay" },
            ethers.utils.hexlify(ethers.utils.randomBytes(32))
          )
        );
        await mockDestinationSpokePoolClient.update(["FilledRelay"]);
        // Replace the dataworker providers to use mock providers. We need to explicitly do this since we do not actually perform a contract call, so
        // we must inject a transaction response into the provider to simulate the case when the relayer repayment address is invalid.
        const provider = new providers.mocks.MockedProvider(bnZero, bnZero, destinationChainId);
        const spokeWrapper = new Contract(
          mockDestinationSpokePoolClient.spokePool.address,
          mockDestinationSpokePoolClient.spokePool.interface,
          provider
        );
        fillV3Events.forEach((event) => provider._setTransaction(event.transactionHash, { from: relayer2 }));
        mockDestinationSpokePoolClient.spokePool = spokeWrapper;

        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
          getDefaultBlockRange(5),
          spokePoolClients
        );
        // Fill with invalid repayment address gets repaid on destination chain now.
        expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills[0].depositId).to.equal(
          fillV3Events[0].args.depositId
        );
        expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills[1].depositId).to.equal(
          fillV3Events[1].args.depositId
        );
        expect(data1.bundleFillsV3[destinationChainId][erc20_2.address].fills[0].depositId).to.equal(
          fillV3Events[2].args.depositId
        );
      });
      // This is essentially a copy of the first test in this block, with the addition of the change to the config store.
      it("Fill with bytes32 relayer with lite chain deposit is refunded on lite chain to msg.sender", async function () {
        const depositV3Events: interfaces.Log[] = [];
        const fillV3Events: interfaces.Log[] = [];
        const destinationChainId = mockDestinationSpokePoolClient.chainId;
        // Update and set the config store client.
        hubPoolClient.configStoreClient._updateLiteChains([mockOriginSpokePoolClient.chainId]);
        mockOriginSpokePoolClient.configStoreClient = hubPoolClient.configStoreClient;
        // Create three valid deposits
        depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
        depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
        depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
        await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
        const deposits = mockOriginSpokePoolClient.getDeposits();

        // Fill deposits from different relayers
        const relayer2 = randomAddress();
        const invalidRelayer = ethers.utils.hexlify(ethers.utils.randomBytes(32));
        fillV3Events.push(generateV3FillFromDeposit(deposits[0], { method: "fillRelay" }));
        fillV3Events.push(generateV3FillFromDeposit(deposits[1], { method: "fillRelay" }));
        fillV3Events.push(generateV3FillFromDeposit(deposits[2], { method: "fillRelay" }, invalidRelayer));
        await mockDestinationSpokePoolClient.update(["FilledRelay"]);
        // Replace the dataworker providers to use mock providers. We need to explicitly do this since we do not actually perform a contract call, so
        // we must inject a transaction response into the provider to simulate the case when the relayer repayment address is invalid.
        const provider = new providers.mocks.MockedProvider(bnZero, bnZero, destinationChainId);
        const spokeWrapper = new Contract(
          mockDestinationSpokePoolClient.spokePool.address,
          mockDestinationSpokePoolClient.spokePool.interface,
          provider
        );
        fillV3Events.forEach((event) => provider._setTransaction(event.transactionHash, { from: relayer2 }));
        mockDestinationSpokePoolClient.spokePool = spokeWrapper;

        const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
          getDefaultBlockRange(5),
          spokePoolClients
        );
        expect(data1.bundleFillsV3[originChainId][erc20_1.address].fills.length).to.equal(depositV3Events.length);
        expect(data1.bundleFillsV3[originChainId][erc20_1.address].fills.map((e) => e.depositId)).to.deep.equal(
          fillV3Events.map((event) => event.args.depositId)
        );
        expect(data1.bundleFillsV3[originChainId][erc20_1.address].fills.map((e) => e.lpFeePct)).to.deep.equal(
          fillV3Events.map(() => lpFeePct)
        );
        const totalGrossRefundAmount = fillV3Events.reduce((agg, e) => agg.add(e.args.inputAmount), toBN(0));
        const totalV3LpFees = totalGrossRefundAmount.mul(lpFeePct).div(fixedPointAdjustment);
        expect(totalV3LpFees).to.equal(data1.bundleFillsV3[originChainId][erc20_1.address].realizedLpFees);
        expect(data1.bundleFillsV3[originChainId][erc20_1.address].totalRefundAmount).to.equal(
          totalGrossRefundAmount.sub(totalV3LpFees)
        );
        const refundAmountPct = fixedPointAdjustment.sub(lpFeePct);
        expect(data1.bundleFillsV3[originChainId][erc20_1.address].refunds).to.deep.equal({
          [relayer.address]: fillV3Events
            .slice(0, fillV3Events.length - 1)
            .reduce((agg, e) => agg.add(e.args.inputAmount), toBN(0))
            .mul(refundAmountPct)
            .div(fixedPointAdjustment),
          [relayer2]: fillV3Events[fillV3Events.length - 1].args.inputAmount
            .mul(refundAmountPct)
            .div(fixedPointAdjustment),
        });
      });
    });
  });

  describe("Miscellaneous functions", function () {
    it("getApproximateRefundsForBlockRange", async function () {
      // Send two deposits on different chains
      // Fill both deposits and request repayment on same chain
      await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        ZERO_ADDRESS,
        amountToDeposit
      );
      await depositV3(
        spokePool_2,
        originChainId,
        depositor,
        erc20_2.address,
        amountToDeposit,
        ZERO_ADDRESS,
        amountToDeposit
      );
      await updateAllClients();
      const deposit1 = spokePoolClient_1.getDeposits()[0];
      const deposit2 = spokePoolClient_2.getDeposits()[0];

      await fillV3Relay(spokePool_2, deposit1, relayer, repaymentChainId);
      await fillV3Relay(spokePool_1, deposit2, relayer, repaymentChainId);

      // Approximate refunds should count both fills
      await updateAllClients();
      const refunds = await bundleDataClient.getApproximateRefundsForBlockRange(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5)
      );
      const expectedRefunds = {
        [repaymentChainId]: {
          [l1Token_1.address]: {
            [relayer.address]: BigNumber.from(amountToDeposit.mul(2)).toString(),
          },
        },
      };

      // Convert refunds to have a nested string instead of BigNumber. It's three levels deep
      // which is a bit ugly but it's the easiest way to compare the two objects that are having
      // these BN issues.
      const convertToNumericStrings = (data: CombinedRefunds) =>
        Object.entries(data).reduce(
          (acc, [chainId, refunds]) => ({
            ...acc,
            [chainId]: Object.entries(refunds).reduce(
              (acc, [token, refunds]) => ({
                ...acc,
                [token]: Object.entries(refunds).reduce(
                  (acc, [address, amount]) => ({ ...acc, [address]: amount.toString() }),
                  {}
                ),
              }),
              {}
            ),
          }),
          {}
        );

      expect(convertToNumericStrings(refunds)).to.deep.equal(expectedRefunds);

      // Send an invalid fill and check it is not included.
      await fillV3Relay(spokePool_2, { ...deposit1, depositId: deposit1.depositId.add(1) }, relayer, repaymentChainId);
      await updateAllClients();
      expect(
        convertToNumericStrings(
          await bundleDataClient.getApproximateRefundsForBlockRange(
            [originChainId, destinationChainId],
            getDefaultBlockRange(5)
          )
        )
      ).to.deep.equal({
        [repaymentChainId]: {
          [l1Token_1.address]: {
            [relayer.address]: amountToDeposit.mul(2).toString(),
          },
        },
      });
    });
  });
});
