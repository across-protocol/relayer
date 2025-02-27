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
  depositV3,
  ethers,
  expect,
  fillV3Relay,
  getDefaultBlockRange,
  getDisabledBlockRanges,
  mineRandomBlocks,
  requestSlowFill,
  smock,
} from "./utils";

import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { getCurrentTime, toBNWei, assert, ZERO_ADDRESS, bnZero } from "../src/utils";
import { MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient } from "./mocks";
import { interfaces, providers, utils as sdkUtils } from "@across-protocol/sdk";

describe("Dataworker: Load bundle data: Computing unexecutable slow fills", async function () {
  let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
  let l1Token_1: Contract;
  let depositor: SignerWithAddress, relayer: SignerWithAddress;

  let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
  let hubPoolClient: HubPoolClient, configStoreClient: ConfigStoreClient;
  let dataworkerInstance: Dataworker;
  let spokePoolClients: { [chainId: number]: SpokePoolClient };

  let spy: sinon.SinonSpy;

  let updateAllClients: () => Promise<void>;

  let mockOriginSpokePoolClient: MockSpokePoolClient, mockDestinationSpokePoolClient: MockSpokePoolClient;
  let mockHubPoolClient: MockHubPoolClient;
  let mockDestinationSpokePool: FakeContract;
  let mockConfigStore: MockConfigStoreClient;
  const lpFeePct = toBNWei("0.01");

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

  beforeEach(async function () {
    ({
      spokePool_1,
      erc20_1,
      spokePool_2,
      erc20_2,
      configStoreClient,
      spy,
      hubPoolClient,
      l1Token_1,
      depositor,
      relayer,
      dataworkerInstance,
      spokePoolClient_1,
      spokePoolClient_2,
      spokePoolClients,
      updateAllClients,
    } = await setupDataworker(ethers, 25, 25, 0));
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

  it("Filters for fast fills replacing slow fills from older bundles", async function () {
    // Generate a deposit that cannot be slow filled, to test that its ignored as a slow fill excess.
    // Generate a second deposit that can be slow filled but will be slow filled in an older bundle
    // Generate a third deposit that does get slow filled but the slow fill is not "seen" by the client.
    const depositWithMissingSlowFillRequest = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    await requestSlowFill(spokePool_2, relayer, depositWithMissingSlowFillRequest);
    const missingSlowFillRequestBlock = await spokePool_2.provider.getBlockNumber();
    await mineRandomBlocks();

    const depositsWithSlowFillRequests = [
      await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        erc20_1.address,
        amountToDeposit
      ),
      await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        erc20_2.address,
        amountToDeposit
      ),
    ];

    await spokePoolClient_1.update();
    const deposits = spokePoolClient_1.getDeposits();
    expect(deposits.length).to.equal(3);
    const eligibleSlowFills = depositsWithSlowFillRequests.filter((x) => erc20_2.address === x.outputToken);
    const ineligibleSlowFills = depositsWithSlowFillRequests.filter((x) => erc20_2.address !== x.outputToken);

    // Generate slow fill requests for the slow fill-eligible deposits
    await requestSlowFill(spokePool_2, relayer, eligibleSlowFills[0]);
    await requestSlowFill(spokePool_2, relayer, ineligibleSlowFills[0]);
    const lastSlowFillRequestBlock = await spokePool_2.provider.getBlockNumber();
    await mineRandomBlocks();

    // Now, generate fast fills replacing slow fills for all deposits.
    await fillV3Relay(spokePool_2, deposits[0], relayer, repaymentChainId);
    await fillV3Relay(spokePool_2, deposits[1], relayer, repaymentChainId);
    await fillV3Relay(spokePool_2, deposits[2], relayer, repaymentChainId);

    // Construct a spoke pool client with a small search range that would not include the first fill.
    spokePoolClient_2.firstBlockToSearch = missingSlowFillRequestBlock + 1;
    spokePoolClient_2.eventSearchConfig.fromBlock = spokePoolClient_2.firstBlockToSearch;

    // There should be one "missing" slow fill request.
    await spokePoolClient_2.update();
    const fills = spokePoolClient_2.getFills();
    expect(fills.length).to.equal(3);
    const slowFillRequests = spokePoolClient_2.getSlowFillRequestsForOriginChain(originChainId);
    expect(slowFillRequests.length).to.equal(2);
    assert(
      fills.every((x) => x.relayExecutionInfo.fillType === interfaces.FillType.ReplacedSlowFill),
      "All fills should be replaced slow fills"
    );
    assert(
      fills.every((x) => x.blockNumber > lastSlowFillRequestBlock),
      "Fills should be later than slow fill request"
    );

    // Create a block range that would make the slow fill requests appear to be in an "older" bundle.
    const destinationChainBlockRange = [lastSlowFillRequestBlock + 1, getDefaultBlockRange(5)[0][1]];
    const originChainBlockRange = [deposits[deposits.length - 1].blockNumber + 1, getDefaultBlockRange(5)[0][1]];
    // Substitute destination chain bundle block range.
    const bundleBlockRanges = getDefaultBlockRange(5);
    const destinationChainIndex =
      dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
    bundleBlockRanges[destinationChainIndex] = destinationChainBlockRange;
    const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
    bundleBlockRanges[originChainIndex] = originChainBlockRange;
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, {
      ...spokePoolClients,
      [originChainId]: spokePoolClient_1,
      [destinationChainId]: spokePoolClient_2,
    });

    // All fills and deposits are valid
    expect(data1.bundleDepositsV3).to.deep.equal({});
    expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(3);

    // There are two "unexecutable slow fills" because there are two deposits that have "equivalent" input
    // and output tokens AND:
    // - one slow fill request does not get seen by the spoke pool client
    // - one slow fill request is in an older bundle
    expect(data1.unexecutableSlowFills[destinationChainId][erc20_2.address].length).to.equal(2);
    expect(
      data1.unexecutableSlowFills[destinationChainId][erc20_2.address].map((x) => x.depositId).sort()
    ).to.deep.equal([depositWithMissingSlowFillRequest.depositId, eligibleSlowFills[0].depositId].sort());
  });

  it("Creates unexecutable slow fill even if fast fill repayment information is invalid", async function () {
    generateV3Deposit({ outputToken: erc20_2.address });
    await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
    const deposits = mockOriginSpokePoolClient.getDeposits();

    // Fill deposit but don't mine requested slow fill event. This makes BundleDataClient think that deposit's slow
    // fill request was sent in a prior bundle. This simulates the situation where the slow fill request
    // was sent in a prior bundle to the fast fill.

    // Fill deposits with invalid repayment information
    const invalidRelayer = ethers.utils.randomBytes(32);
    const invalidFillEvent = generateV3FillFromDeposit(
      deposits[0],
      { method: "fillRelay" },
      invalidRelayer,
      undefined,
      interfaces.FillType.ReplacedSlowFill
    );
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

    // Substitute bundle block ranges.
    const bundleBlockRanges = getDefaultBlockRange(5);
    const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
    const originChainBlockRange = [deposits[deposits.length - 1].blockNumber + 1, getDefaultBlockRange(5)[0][1]];
    bundleBlockRanges[originChainIndex] = originChainBlockRange;
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);

    // The fill cannot be refunded but there is still an unexecutable slow fill leaf we need to refund.
    expect(data1.bundleFillsV3).to.deep.equal({});
    expect(data1.bundleDepositsV3).to.deep.equal({});
    expect(data1.unexecutableSlowFills[destinationChainId][erc20_2.address].length).to.equal(1);
    const logs = spy.getCalls().filter((x) => x.lastArg.message.includes("unrepayable"));
    expect(logs.length).to.equal(1);
  });

  it("Handles fast fills replacing invalid slow fill request from older bundles", async function () {
    // Create a Lite chain to test that slow fill requests involving lite chains are ignored.
    mockConfigStore.updateGlobalConfig(
      GLOBAL_CONFIG_STORE_KEYS.LITE_CHAIN_ID_INDICES,
      JSON.stringify([mockOriginSpokePoolClient.chainId])
    );
    await mockConfigStore.update();
    (spokePoolClient_1 as any).configStoreClient = mockConfigStore;
    (spokePoolClient_2 as any).configStoreClient = mockConfigStore;

    // Generate a deposit that cannot be slow filled, to test that its ignored as a slow fill excess.
    // - first deposit is FROM lite chain
    // - second deposit is TO lite chain
    const depositsWithSlowFillRequests = [
      await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        amountToDeposit,
        erc20_2.address,
        amountToDeposit
      ),
      await depositV3(
        spokePool_2,
        originChainId,
        depositor,
        erc20_2.address,
        amountToDeposit,
        erc20_1.address,
        amountToDeposit
      ),
    ];

    await spokePoolClient_1.update();
    await spokePoolClient_2.update();
    const originChainDeposit = spokePoolClient_1.getDeposits()[0];
    const destinationChainDeposit = spokePoolClient_2.getDeposits()[0];

    // Generate slow fill requests for the slow fill-eligible deposits
    await requestSlowFill(spokePool_2, relayer, depositsWithSlowFillRequests[0]);
    await requestSlowFill(spokePool_1, relayer, depositsWithSlowFillRequests[1]);
    const lastDestinationChainSlowFillRequestBlock = await spokePool_2.provider.getBlockNumber();
    const lastOriginChainSlowFillRequestBlock = await spokePool_2.provider.getBlockNumber();

    await mineRandomBlocks();

    // Now, generate fast fills replacing slow fills for all deposits.
    await fillV3Relay(spokePool_2, originChainDeposit, relayer, repaymentChainId);
    await fillV3Relay(spokePool_1, destinationChainDeposit, relayer, repaymentChainId);

    await spokePoolClient_1.update();
    await spokePoolClient_2.update();
    assert(
      spokePoolClient_2.getFills().every((x) => x.relayExecutionInfo.fillType === interfaces.FillType.ReplacedSlowFill),
      "All fills should be replaced slow fills"
    );
    assert(
      spokePoolClient_1.getFills().every((x) => x.relayExecutionInfo.fillType === interfaces.FillType.ReplacedSlowFill),
      "All fills should be replaced slow fills"
    );

    // Create a block range that would make the slow fill requests appear to be in an "older" bundle.
    const destinationChainBlockRange = [lastDestinationChainSlowFillRequestBlock + 1, getDefaultBlockRange(5)[0][1]];
    const originChainBlockRange = [lastOriginChainSlowFillRequestBlock + 1, getDefaultBlockRange(5)[0][1]];
    // Substitute destination chain bundle block range.
    const bundleBlockRanges = getDefaultBlockRange(5);
    const destinationChainIndex =
      dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
    bundleBlockRanges[destinationChainIndex] = destinationChainBlockRange;
    const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
    bundleBlockRanges[originChainIndex] = originChainBlockRange;

    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, {
      ...spokePoolClients,
      [originChainId]: spokePoolClient_1,
      [destinationChainId]: spokePoolClient_2,
    });

    // All fills are valid. Note, origin chain deposit must take repayment on origin chain.
    expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
    expect(data1.bundleFillsV3[originChainId][erc20_1.address].fills.length).to.equal(1);

    // There are zero "unexecutable slow fills" because the slow fill requests in an older bundle are invalid
    expect(data1.unexecutableSlowFills).to.deep.equal({});
  });

  it("Replacing a slow fill request with a fast fill in same bundle doesn't create unexecutable slow fill", async function () {
    generateV3Deposit({ outputToken: erc20_2.address });
    await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
    const deposits = mockOriginSpokePoolClient.getDeposits();

    generateSlowFillRequestFromDeposit(deposits[0]);
    generateV3FillFromDeposit(deposits[0], undefined, undefined, undefined, interfaces.FillType.ReplacedSlowFill);
    await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill", "FilledV3Relay"]);
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), spokePoolClients);

    expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
    expect(data1.bundleSlowFillsV3).to.deep.equal({});
    expect(data1.unexecutableSlowFills).to.deep.equal({});
  });

  it("Does not create unexecutable slow fill if deposit triggering pre-slow-fill refund is in current bundle", async function () {
    // Send deposit and fill replacing slow fill in current bundle.
    const deposit = generateV3Deposit({
      outputToken: erc20_2.address,
      blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 11,
    });
    await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
    const deposits = mockOriginSpokePoolClient.getDeposits();

    // Send slow fill request in prior bundle.
    const request = generateSlowFillRequestFromDeposit(deposits[0], {
      blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber,
    });

    // Send fast fill replacing slow fill in current bundle.
    const fill = generateV3FillFromDeposit(
      deposits[0],
      { blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 11 },
      undefined,
      undefined,
      interfaces.FillType.ReplacedSlowFill
    );
    expect(fill.blockNumber).to.greaterThan(request.blockNumber);
    await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill", "FilledV3Relay"]);

    // Substitute bundle block ranges.
    const bundleBlockRanges = getDefaultBlockRange(5);
    const destinationChainIndex =
      dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
    bundleBlockRanges[destinationChainIndex] = [request.blockNumber + 1, fill.blockNumber + 1];

    // Should not create unexecutable slow fill.
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
    expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(1);
    expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
    expect(data1.unexecutableSlowFills).to.deep.equal({});

    // If instead the deposit was from a prior bundle then we would create an unexecutable slow fill because
    // the slow fill leaf would have been created prior to the fast fill's bundle.
    const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
    bundleBlockRanges[originChainIndex] = [deposit.blockNumber + 1, deposit.blockNumber + 2];
    const data2 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
    expect(data2.bundleDepositsV3).to.deep.equal({});
    expect(data2.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
    expect(data2.unexecutableSlowFills[destinationChainId][erc20_2.address].length).to.equal(1);
  });

  it("Ignores disabled chains for unexecutable slow fills", async function () {
    generateV3Deposit({ outputToken: erc20_2.address });
    await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
    const deposits = mockOriginSpokePoolClient.getDeposits();

    generateSlowFillRequestFromDeposit(deposits[0]);
    generateV3FillFromDeposit(deposits[0], undefined, undefined, undefined, interfaces.FillType.ReplacedSlowFill);
    await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill", "FilledV3Relay"]);

    const emptyData = await dataworkerInstance.clients.bundleDataClient.loadData(
      getDisabledBlockRanges(),
      spokePoolClients
    );
    expect(emptyData.unexecutableSlowFills).to.deep.equal({});
    expect(emptyData.bundleFillsV3).to.deep.equal({});
    expect(emptyData.bundleSlowFillsV3).to.deep.equal({});
  });

  it("Adds prior bundle expired deposits that requested a slow fill in a prior bundle to unexecutable slow fills", async function () {
    // Send deposit that expires in this bundle.
    const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
      [originChainId, destinationChainId],
      getDefaultBlockRange(5),
      spokePoolClients
    );
    const expiredDeposit = generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 });
    await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

    // Let's make fill status for the relay hash always return RequestedSlowFill.
    const expiredDepositHash = sdkUtils.getRelayHashFromEvent(mockOriginSpokePoolClient.getDeposits()[0]);
    mockDestinationSpokePool.fillStatuses
      .whenCalledWith(expiredDepositHash)
      .returns(interfaces.FillStatus.RequestedSlowFill);

    // Now, load a bundle that doesn't include the deposit in its range.
    const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
    const oldOriginChainToBlock = getDefaultBlockRange(5)[0][1];
    const bundleBlockRanges = getDefaultBlockRange(5);
    bundleBlockRanges[originChainIndex] = [expiredDeposit.blockNumber + 1, oldOriginChainToBlock];
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);

    // Now, there is no bundle deposit but still an expired deposit to refund.
    // There is also an unexecutable slow fill.
    expect(data1.bundleDepositsV3).to.deep.equal({});
    expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);
    expect(data1.unexecutableSlowFills[destinationChainId][erc20_2.address].length).to.equal(1);
  });

  it("Does not add prior bundle expired lite chain deposits that requested a slow fill in a prior bundle to unexecutable slow fills", async function () {
    mockConfigStore.updateGlobalConfig(
      GLOBAL_CONFIG_STORE_KEYS.LITE_CHAIN_ID_INDICES,
      JSON.stringify([mockOriginSpokePoolClient.chainId])
    );
    await mockConfigStore.update();
    (mockOriginSpokePoolClient as any).configStoreClient = mockConfigStore;
    (mockDestinationSpokePool as any).configStoreClient = mockConfigStore;
    const updateEventTimestamp = mockConfigStore.liteChainIndicesUpdates[0].timestamp;

    // Send lite chain deposit that expires in this bundle.
    const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
      [originChainId, destinationChainId],
      getDefaultBlockRange(5),
      spokePoolClients
    );
    const expiredDeposit = generateV3Deposit({
      fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1,
      quoteTimestamp: updateEventTimestamp,
    });
    await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

    const deposit = mockOriginSpokePoolClient.getDeposits()[0];
    assert(deposit.fromLiteChain, "Deposit should be from lite chain");

    // Let's make fill status for the relay hash always return RequestedSlowFill.
    const expiredDepositHash = sdkUtils.getRelayHashFromEvent(mockOriginSpokePoolClient.getDeposits()[0]);
    mockDestinationSpokePool.fillStatuses
      .whenCalledWith(expiredDepositHash)
      .returns(interfaces.FillStatus.RequestedSlowFill);

    // Now, load a bundle that doesn't include the deposit in its range.
    const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
    const oldOriginChainToBlock = getDefaultBlockRange(5)[0][1];
    const bundleBlockRanges = getDefaultBlockRange(5);
    bundleBlockRanges[originChainIndex] = [expiredDeposit.blockNumber + 1, oldOriginChainToBlock];
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);

    // Now, there is no bundle deposit but still an expired deposit to refund.
    // There is NOT an unexecutable slow fill.
    expect(data1.bundleDepositsV3).to.deep.equal({});
    expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);
    expect(data1.unexecutableSlowFills).to.deep.equal({});
  });

  it("Does not add prior bundle expired deposits that did not request a slow fill in a prior bundle to unexecutable slow fills", async function () {
    // Send deposit that expires in this bundle.
    const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
      [originChainId, destinationChainId],
      getDefaultBlockRange(5),
      spokePoolClients
    );
    const expiredDeposit = generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 });
    await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

    // Let's make fill status for the relay hash always return Unfilled.
    const expiredDepositHash = sdkUtils.getRelayHashFromEvent(mockOriginSpokePoolClient.getDeposits()[0]);
    mockDestinationSpokePool.fillStatuses.whenCalledWith(expiredDepositHash).returns(interfaces.FillStatus.Unfilled);

    // Now, load a bundle that doesn't include the deposit in its range.
    const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
    const oldOriginChainToBlock = getDefaultBlockRange(5)[0][1];
    const bundleBlockRanges = getDefaultBlockRange(5);
    bundleBlockRanges[originChainIndex] = [expiredDeposit.blockNumber + 1, oldOriginChainToBlock];
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);

    // Now, there is no bundle deposit but still an expired deposit to refund.
    // There is also an unexecutable slow fill.
    expect(data1.bundleDepositsV3).to.deep.equal({});
    expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);
    expect(data1.unexecutableSlowFills).to.deep.equal({});
  });

  it("Does not add unexecutable slow fill for prior bundle expired deposits that requested a slow fill if slow fill request is in current bundle", async function () {
    // Send deposit that expires in this bundle.
    const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
      [originChainId, destinationChainId],
      getDefaultBlockRange(5),
      spokePoolClients
    );
    const expiredDeposit = generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 });
    await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);

    // If the slow fill request took place in the current bundle, then it is not marked as unexecutable since
    // it would not have produced a slow fill request.
    const deposit = mockOriginSpokePoolClient.getDeposits()[0];
    generateSlowFillRequestFromDeposit(deposit);
    await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill"]);

    // Let's make fill status for the relay hash always return RequestedSlowFill.
    const expiredDepositHash = sdkUtils.getRelayHashFromEvent(mockOriginSpokePoolClient.getDeposits()[0]);
    mockDestinationSpokePool.fillStatuses
      .whenCalledWith(expiredDepositHash)
      .returns(interfaces.FillStatus.RequestedSlowFill);

    // Now, load a bundle that doesn't include the deposit in its range.
    const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
    const oldOriginChainToBlock = getDefaultBlockRange(5)[0][1];
    const bundleBlockRanges = getDefaultBlockRange(5);
    bundleBlockRanges[originChainIndex] = [expiredDeposit.blockNumber + 1, oldOriginChainToBlock];
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);

    // Now, there is no bundle deposit but still an expired deposit to refund.
    // There is also no unexecutable slow fill because the slow fill request was sent in this bundle.
    expect(data1.bundleDepositsV3).to.deep.equal({});
    expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);
    expect(data1.unexecutableSlowFills).to.deep.equal({});
    expect(data1.bundleSlowFillsV3).to.deep.equal({});
  });
});
