import { BundleDataClient, ConfigStoreClient, HubPoolClient, SpokePoolClient } from "../src/clients";
import { amountToDeposit, destinationChainId, originChainId, repaymentChainId } from "./constants";
import { DataworkerConfig, setupDataworker } from "./fixtures/Dataworker.Fixture";
import {
  Contract,
  FakeContract,
  SignerWithAddress,
  V3FillFromDeposit,
  depositV3,
  ethers,
  expect,
  getDefaultBlockRange,
  getDisabledBlockRanges,
  sinon,
  smock,
  spyLogIncludes,
} from "./utils";

import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { getCurrentTime, toBNWei, ZERO_ADDRESS, BigNumber, bnZero } from "../src/utils";
import { MockHubPoolClient, MockSpokePoolClient } from "./mocks";
import { interfaces, utils as sdkUtils } from "@across-protocol/sdk";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient, bundleDataClient: BundleDataClient;
let hubPoolClient: HubPoolClient, configStoreClient: ConfigStoreClient;
let dataworkerInstance: Dataworker;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let spy: sinon.SinonSpy;

let updateAllClients: () => Promise<void>;

// TODO: Rename this file to BundleDataClient
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

  describe("Computing bundle deposits and expired deposits to refund", function () {
    let mockOriginSpokePoolClient: MockSpokePoolClient, mockDestinationSpokePoolClient: MockSpokePoolClient;
    let mockHubPoolClient: MockHubPoolClient;
    let mockDestinationSpokePool: FakeContract;
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
      const fillObject = V3FillFromDeposit(deposit, _relayer, _repaymentChainId);
      return mockDestinationSpokePoolClient.fillV3Relay({
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

    it("Filters expired deposits", async function () {
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );
      // Send unexpired deposit
      generateV3Deposit();
      // Send expired deposit
      const expiredDeposits = [generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 })];
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );

      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(2);
      expect(
        data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].map((deposit) => deposit.depositId)
      ).to.deep.equal(expiredDeposits.map((event) => event.args.depositId));
      expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);
    });

    it("Ignores disabled chains", async function () {
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );
      // Send unexpired deposit
      generateV3Deposit();
      // Send expired deposit
      generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

      // Returns no data if block range is undefined
      const emptyData = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDisabledBlockRanges(),
        spokePoolClients
      );
      expect(emptyData.bundleDepositsV3).to.deep.equal({});
      expect(emptyData.expiredDepositsToRefundV3).to.deep.equal({});
    });

    it("Does not consider zero value deposits", async function () {
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );
      // Send unexpired and expired deposits in bundle block range.
      generateV3Deposit({
        inputAmount: bnZero,
        message: "0x",
      });
      generateV3Deposit({
        fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1,
        inputAmount: bnZero,
        message: "0x",
      });

      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );

      expect(data1.bundleDepositsV3).to.deep.equal({});
      expect(data1.expiredDepositsToRefundV3).to.deep.equal({});
    });

    it("Does not consider expired zero value deposits from prior bundle", async function () {
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );
      // Send expired deposits
      const priorBundleDeposit = generateV3Deposit({
        fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1,
        inputAmount: bnZero,
        message: "0x",
      });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

      const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
      const oldOriginChainToBlock = getDefaultBlockRange(5)[0][1];
      const bundleBlockRanges = getDefaultBlockRange(5);
      bundleBlockRanges[originChainIndex] = [priorBundleDeposit.blockNumber + 1, oldOriginChainToBlock];
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);

      expect(data1.bundleDepositsV3).to.deep.equal({});
      expect(data1.expiredDepositsToRefundV3).to.deep.equal({});
    });

    it("Filters unexpired deposit out of block range", async function () {
      // Send deposit behind and after origin chain block range. Should not be included in bundleDeposits.
      // First generate mock deposit events with some block time between events.
      const deposits = [
        generateV3Deposit({ blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 1 }),
        generateV3Deposit({ blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 11 }),
        generateV3Deposit({ blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 21 }),
      ];
      // Create a block range that contains only the middle deposit.
      const originChainBlockRange = [deposits[1].blockNumber - 1, deposits[1].blockNumber + 1];
      // Substitute origin chain bundle block range.
      const bundleBlockRanges = [originChainBlockRange].concat(getDefaultBlockRange(5).slice(1));
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      expect(mockOriginSpokePoolClient.getDeposits().length).to.equal(deposits.length);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(1);
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address][0].depositId).to.equal(deposits[1].args.depositId);
    });
    it("Includes duplicate deposits in bundle data", async function () {
      const deposit = generateV3Deposit();
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const depositToDuplicate = mockOriginSpokePoolClient.getDeposits()[0];
      const dupe1 = mockOriginSpokePoolClient.depositV3(depositToDuplicate);
      const dupe2 = mockOriginSpokePoolClient.depositV3(depositToDuplicate);
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      expect(
        mockOriginSpokePoolClient.getDepositsForDestinationChainWithDuplicates(destinationChainId).length
      ).to.equal(3);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(3);
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address][0].transactionHash).to.equal(
        deposit.transactionHash
      );
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address][1].transactionHash).to.equal(dupe1.transactionHash);
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address][2].transactionHash).to.equal(dupe2.transactionHash);
    });
    it("Filters duplicate deposits out of block range", async function () {
      const deposit = generateV3Deposit({ blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 1 });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const depositToDuplicate = mockOriginSpokePoolClient.getDeposits()[0];
      const duplicateDeposit = mockOriginSpokePoolClient.depositV3({
        ...depositToDuplicate,
        blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 11,
      });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      expect(
        mockOriginSpokePoolClient.getDepositsForDestinationChainWithDuplicates(destinationChainId).length
      ).to.equal(2);
      const originChainBlockRange = [deposit.blockNumber, duplicateDeposit.blockNumber - 1];
      // Substitute origin chain bundle block range.
      const bundleBlockRanges = [originChainBlockRange].concat(getDefaultBlockRange(5).slice(1));
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(1);
    });
    it("Ignores expired deposits that were filled in same bundle", async function () {
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );
      // Send deposit that expires in this bundle.
      const expiredDeposit = generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(1);
      expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);

      // Now, send a fill for the deposit that would be in the same bundle. This should eliminate the expired
      // deposit from a refund.
      generateV3FillFromDepositEvent(expiredDeposit);
      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);
      const data2 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(6),
        spokePoolClients
      );
      expect(data2.expiredDepositsToRefundV3).to.deep.equal({});
      expect(data2.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
    });

    it("Returns prior bundle expired deposits", async function () {
      // Send deposit that expires in this bundle.
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );
      // Send deposit that expires in this bundle.
      const expiredDeposit = generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(1);
      expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);

      // Now, load a bundle that doesn't include the deposit in its range.
      const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
      const oldOriginChainToBlock = getDefaultBlockRange(5)[0][1];
      const bundleBlockRanges = getDefaultBlockRange(5);
      bundleBlockRanges[originChainIndex] = [expiredDeposit.blockNumber + 1, oldOriginChainToBlock];
      const data2 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);

      // Now, there is no bundle deposit but still an expired deposit to refund.
      expect(data2.bundleDepositsV3).to.deep.equal({});
      expect(data2.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);
    });
    it("Includes duplicate prior bundle expired deposits", async function () {
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );

      // Send deposit that expires in this bundle and send duplicate at same block.
      const expiredDeposit = generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      mockOriginSpokePoolClient.depositV3(mockOriginSpokePoolClient.getDeposits()[0]);
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(2);
      expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(2);

      // Now, load a bundle that doesn't include the deposits in its range.
      const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
      const oldOriginChainToBlock = getDefaultBlockRange(5)[0][1];
      const bundleBlockRanges = getDefaultBlockRange(5);
      bundleBlockRanges[originChainIndex] = [expiredDeposit.blockNumber + 1, oldOriginChainToBlock];
      const data2 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);

      // Now, there is no bundle deposit but still two expired deposits to refund.
      expect(data2.bundleDepositsV3).to.deep.equal({});
      expect(data2.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(2);
    });
    it("Handles when deposit is greater than origin bundle end block but fill is within range", async function () {
      // Send deposit after origin chain block range.
      const blockRanges = getDefaultBlockRange(5);
      const futureDeposit = generateV3Deposit();
      const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
      blockRanges[originChainIndex] = [blockRanges[0][0], futureDeposit.blockNumber - 1];

      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

      generateV3FillFromDepositEvent(futureDeposit);
      await mockDestinationSpokePoolClient.update(["FilledV3Relay"]);

      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(blockRanges, spokePoolClients);
      expect(data1.bundleDepositsV3).to.deep.equal({});

      // Fill should not be included since we cannot validate fills when the deposit is in a following bundle.
      // This fill is considered a "pre-fill" and will be validated when the deposit is included in a bundle.
      expect(data1.bundleFillsV3).to.deep.equal({});
      expect(spyLogIncludes(spy, -2, "invalid fills in range")).to.be.true;
    });
    it("Does not count prior bundle expired deposits that were filled", async function () {
      // Send deposit that expires in this bundle.
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );
      const expiredDeposit = generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

      // Let's make fill status for the relay hash always return Filled.
      const expiredDepositHash = sdkUtils.getRelayHashFromEvent(mockOriginSpokePoolClient.getDeposits()[0]);
      mockDestinationSpokePool.fillStatuses.whenCalledWith(expiredDepositHash).returns(interfaces.FillStatus.Filled);

      // Now, load a bundle that doesn't include the deposit in its range.
      const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
      const oldOriginChainToBlock = getDefaultBlockRange(5)[0][1];
      const bundleBlockRanges = getDefaultBlockRange(5);
      bundleBlockRanges[originChainIndex] = [expiredDeposit.blockNumber + 1, oldOriginChainToBlock];
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);

      // There should be no expired deposit to refund because its fill status is Filled.
      expect(data1.bundleDepositsV3).to.deep.equal({});
      expect(data1.expiredDepositsToRefundV3).to.deep.equal({});
    });
    it("Does not count prior bundle expired deposits that we queried a fill for", async function () {
      // Send deposit that expires in this bundle.
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );
      const expiredDeposit = generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();

      // Unlike previous test, we send a fill that the spoke pool client should query which also eliminates this
      // expired deposit from being refunded.
      generateV3FillFromDeposit(deposits[0]);
      await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill", "FilledV3Relay"]);
      expect(mockDestinationSpokePoolClient.getFills().length).to.equal(1);

      // Now, load a bundle that doesn't include the deposit in its range.
      const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
      const oldOriginChainToBlock = getDefaultBlockRange(5)[0][1];
      const bundleBlockRanges = getDefaultBlockRange(5);
      bundleBlockRanges[originChainIndex] = [expiredDeposit.blockNumber + 1, oldOriginChainToBlock];
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);

      // There should be no expired deposit to refund.
      expect(data1.bundleDepositsV3).to.deep.equal({});
      expect(data1.expiredDepositsToRefundV3).to.deep.equal({});
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
    });
  });

  describe("Miscellaneous functions", function () {
    it("getUpcomingDepositAmount", async function () {
      // Send two deposits on different chains
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
      expect(await bundleDataClient.getUpcomingDepositAmount(originChainId, erc20_1.address, 0)).to.equal(
        amountToDeposit
      );
      expect(await bundleDataClient.getUpcomingDepositAmount(destinationChainId, erc20_2.address, 0)).to.equal(
        amountToDeposit
      );

      // Removes deposits using block, token, and chain filters.
      expect(
        await bundleDataClient.getUpcomingDepositAmount(
          originChainId,
          erc20_1.address,
          spokePoolClient_1.latestBlockSearched // block higher than the deposit
        )
      ).to.equal(0);
      expect(
        await bundleDataClient.getUpcomingDepositAmount(
          originChainId,
          erc20_2.address, // diff token
          0
        )
      ).to.equal(0);
      expect(
        await bundleDataClient.getUpcomingDepositAmount(
          destinationChainId, // diff chain
          erc20_1.address,
          0
        )
      ).to.equal(0);

      // spoke pool client for chain not defined
      expect(
        await bundleDataClient.getUpcomingDepositAmount(
          originChainId + destinationChainId + repaymentChainId + 1, // spoke pool client for chain is not defined in BundleDataClient
          erc20_1.address,
          0
        )
      ).to.equal(0);
    });
  });
});
