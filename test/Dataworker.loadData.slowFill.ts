import {
  BundleDataClient,
  ConfigStoreClient,
  GLOBAL_CONFIG_STORE_KEYS,
  HubPoolClient,
  SpokePoolClient,
} from "../src/clients";
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
  mineRandomBlocks,
  randomAddress,
  requestSlowFill,
  sinon,
  smock,
  spyLogIncludes,
} from "./utils";

import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { getCurrentTime, Event, toBNWei, assert, ZERO_ADDRESS } from "../src/utils";
import { MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient } from "./mocks";
import { interfaces, utils as sdkUtils } from "@across-protocol/sdk";
import { cloneDeep } from "lodash";

describe("BundleDataClient: Slow fill handling & validation", async function () {
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
    await fillV3(spokePool_2, relayer, deposits[0]);
    await fillV3(spokePool_2, relayer, deposits[1]);
    await fillV3(spokePool_2, relayer, deposits[2]);

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
    // Substitute destination chain bundle block range.
    const bundleBlockRanges = getDefaultBlockRange(5);
    const destinationChainIndex =
      dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
    bundleBlockRanges[destinationChainIndex] = destinationChainBlockRange;
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, {
      ...spokePoolClients,
      [originChainId]: spokePoolClient_1,
      [destinationChainId]: spokePoolClient_2,
    });

    // All fills and deposits are valid
    expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(3);
    expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(3);

    // There are two "unexecutable slow fills" because there are two deposits that have "equivalent" input
    // and output tokens AND:
    // - one slow fill request does not get seen by the spoke pool client
    // - one slow fill request is in an older bundle
    expect(data1.unexecutableSlowFills[destinationChainId][erc20_2.address].length).to.equal(2);
    expect(
      data1.unexecutableSlowFills[destinationChainId][erc20_2.address].map((x) => x.depositId).sort()
    ).to.deep.equal([depositWithMissingSlowFillRequest.depositId, eligibleSlowFills[0].depositId].sort());
  });

  it("Saves valid slow fill requests under destination chain and token", async function () {
    // Only one deposit is eligible to be slow filled because its input and output tokens are equivalent.
    generateV3Deposit({ outputToken: randomAddress() });
    const eligibleToSlowFill = generateV3Deposit({ outputToken: erc20_2.address });
    await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
    const deposits = mockOriginSpokePoolClient.getDeposits();

    generateSlowFillRequestFromDeposit(deposits[0]);
    generateSlowFillRequestFromDeposit(deposits[1]);
    await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill"]);
    expect(mockDestinationSpokePoolClient.getSlowFillRequestsForOriginChain(originChainId).length).to.equal(2);
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), spokePoolClients);
    expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address].length).to.equal(1);
    expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address][0].depositId).to.equal(
      eligibleToSlowFill.args.depositId
    );
  });

  it("Slow fill requests cannot coincide with fill in same bundle", async function () {
    generateV3Deposit({ outputToken: erc20_2.address });
    generateV3Deposit({ outputToken: erc20_2.address });
    await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
    const deposits = mockOriginSpokePoolClient.getDeposits();

    generateSlowFillRequestFromDeposit(deposits[0]);
    generateSlowFillRequestFromDeposit(deposits[1]);
    generateV3FillFromDeposit(deposits[0]);
    await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill", "FilledV3Relay"]);
    expect(mockDestinationSpokePoolClient.getFills().length).to.equal(1);
    expect(mockDestinationSpokePoolClient.getSlowFillRequestsForOriginChain(originChainId).length).to.equal(2);
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), spokePoolClients);

    // Only the deposit that wasn't fast filled should be included in the slow fill requests.
    expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
    expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address].length).to.equal(1);
    expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address][0].depositId).to.equal(deposits[1].depositId);
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

  it("Handles slow fill requests out of block range", async function () {
    generateV3Deposit({ outputToken: erc20_2.address });
    generateV3Deposit({ outputToken: erc20_2.address });
    generateV3Deposit({ outputToken: erc20_2.address });
    await mockOriginSpokePoolClient.update(["FundsDeposited", "V3FundsDeposited"]);
    const deposits = mockOriginSpokePoolClient.getDeposits();

    const events = [
      generateSlowFillRequestFromDeposit(deposits[0], {
        blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 1,
      }),
      generateSlowFillRequestFromDeposit(deposits[1], {
        blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 11,
      }),
      generateSlowFillRequestFromDeposit(deposits[2], {
        blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 21,
      }),
    ];
    // Create a block range that contains only the middle event.
    const destinationChainBlockRange = [events[1].blockNumber - 1, events[1].blockNumber + 1];
    // Substitute destination chain bundle block range.
    const bundleBlockRanges = getDefaultBlockRange(5);
    const destinationChainIndex =
      dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
    bundleBlockRanges[destinationChainIndex] = destinationChainBlockRange;
    await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill"]);
    expect(mockDestinationSpokePoolClient.getSlowFillRequestsForOriginChain(originChainId).length).to.equal(3);
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
    expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address].length).to.equal(1);
    expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address][0].depositId).to.equal(
      events[1].args.depositId
    );
  });

  it("Validates slow fill request against old deposit", async function () {
    // For this test, we need to actually send a deposit on the spoke pool
    // because queryHistoricalDepositForFill eth_call's the contract.

    // Send a deposit.
    const depositObject = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    const depositBlock = await spokePool_1.provider.getBlockNumber();

    // Construct a spoke pool client with a small search range that would not include the deposit.
    spokePoolClient_1.firstBlockToSearch = depositBlock + 1;
    spokePoolClient_1.eventSearchConfig.fromBlock = spokePoolClient_1.firstBlockToSearch;
    await spokePoolClient_1.update();
    const deposits = spokePoolClient_1.getDeposits();
    expect(deposits.length).to.equal(0);

    // Send a slow fill request now and force the bundle data client to query for the historical deposit.
    await requestSlowFill(spokePool_2, relayer, depositObject);
    await updateAllClients();
    const requests = spokePoolClient_2.getSlowFillRequestsForOriginChain(originChainId);
    expect(requests.length).to.equal(1);

    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
      ...spokePoolClients,
      [originChainId]: spokePoolClient_1,
      [destinationChainId]: spokePoolClient_2,
    });
    expect(spyLogIncludes(spy, -4, "Located V3 deposit outside of SpokePoolClient's search range")).is.true;
    expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address].length).to.equal(1);
    expect(data1.bundleDepositsV3).to.deep.equal({});
  });

  it("Handles invalid slow fill requests with mismatching params from deposit", async function () {
    generateV3Deposit();
    await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
    const deposit = mockOriginSpokePoolClient.getDeposits()[0];
    const invalidRelayData = {
      depositor: randomAddress(),
      recipient: randomAddress(),
      exclusiveRelayer: randomAddress(),
      inputToken: erc20_2.address,
      outputToken: erc20_1.address,
      inputAmount: deposit.inputAmount.add(1),
      outputAmount: deposit.outputAmount.add(1),
      originChainId: destinationChainId,
      depositId: deposit.depositId + 1,
      fillDeadline: deposit.fillDeadline + 1,
      exclusivityDeadline: deposit.exclusivityDeadline + 1,
      message: randomAddress(),
      destinationChainId: originChainId,
    };
    for (const [key, val] of Object.entries(invalidRelayData)) {
      const _deposit = cloneDeep(deposit);
      _deposit[key] = val;
      if (key === "inputToken") {
        // @dev if input token is changed, make origin chain match the chain where the replacement
        // token address is located so that bundle data client can determine its "repayment" token.
        _deposit.originChainId = destinationChainId;
      }
      generateSlowFillRequestFromDeposit(_deposit);
    }
    // Send one valid fill as a base test case.
    generateSlowFillRequestFromDeposit(deposit);
    await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill"]);
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), spokePoolClients);
    expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address].length).to.equal(1);
  });

  it("Slow fill request for deposit that expired in bundle", async function () {
    const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
      [originChainId, destinationChainId],
      getDefaultBlockRange(5),
      spokePoolClients
    );
    // Send expired deposit
    generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 });
    await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
    const deposits = mockOriginSpokePoolClient.getDeposits();

    // Send valid slow fill request
    generateSlowFillRequestFromDeposit(deposits[0]);
    await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill"]);
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), spokePoolClients);

    // Slow fill request should not be created, instead deposit should be refunded as an expired one
    expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(1);
    expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);
    expect(data1.bundleSlowFillsV3).to.deep.equal({});
  });

  it("Searches for old deposit for slow fill request but cannot find matching one", async function () {
    // For this test, we need to actually send a deposit on the spoke pool
    // because queryHistoricalDepositForFill eth_call's the contract.

    // Send a deposit.
    const depositObject = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    const depositBlock = await spokePool_1.provider.getBlockNumber();

    // Construct a spoke pool client with a small search range that would not include the deposit.
    spokePoolClient_1.firstBlockToSearch = depositBlock + 1;
    spokePoolClient_1.eventSearchConfig.fromBlock = spokePoolClient_1.firstBlockToSearch;
    await spokePoolClient_1.update();
    const deposits = spokePoolClient_1.getDeposits();
    expect(deposits.length).to.equal(0);

    // Send a slow fill request now and force the bundle data client to query for the historical deposit.
    await requestSlowFill(spokePool_2, relayer, { ...depositObject, depositId: depositObject.depositId + 1 });
    await updateAllClients();
    const requests = spokePoolClient_2.getSlowFillRequestsForOriginChain(originChainId);
    expect(requests.length).to.equal(1);

    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
      ...spokePoolClients,
      [originChainId]: spokePoolClient_1,
      [destinationChainId]: spokePoolClient_2,
    });
    expect(data1.bundleSlowFillsV3).to.deep.equal({});
    expect(data1.bundleDepositsV3).to.deep.equal({});
  });

  it("Searches for old deposit for slow fill request but deposit isn't eligible for slow fill", async function () {
    // For this test, we need to actually send a deposit on the spoke pool
    // because queryHistoricalDepositForFill eth_call's the contract.

    // Send a deposit. We'll set output token to a random token to invalidate the slow fill request (e.g.
    // input and output are not "equivalent" tokens)
    const invalidOutputToken = erc20_1;
    const depositObject = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      invalidOutputToken.address,
      amountToDeposit
    );
    const depositBlock = await spokePool_1.provider.getBlockNumber();

    // Construct a spoke pool client with a small search range that would not include the deposit.
    spokePoolClient_1.firstBlockToSearch = depositBlock + 1;
    spokePoolClient_1.eventSearchConfig.fromBlock = spokePoolClient_1.firstBlockToSearch;
    await spokePoolClient_1.update();
    const deposits = spokePoolClient_1.getDeposits();
    expect(deposits.length).to.equal(0);

    // Send a slow fill request now and force the bundle data client to query for the historical deposit.
    await requestSlowFill(spokePool_2, relayer, depositObject);
    await updateAllClients();
    const requests = spokePoolClient_2.getSlowFillRequestsForOriginChain(originChainId);
    expect(requests.length).to.equal(1);

    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
      ...spokePoolClients,
      [originChainId]: spokePoolClient_1,
      [destinationChainId]: spokePoolClient_2,
    });
    // Here we can see that the historical query for the deposit actually succeeds, but the deposit itself
    // was not one eligible to be slow filled.
    expect(spyLogIncludes(spy, -4, "Located V3 deposit outside of SpokePoolClient's search range")).is.true;

    expect(data1.bundleSlowFillsV3).to.deep.equal({});
    expect(data1.bundleDepositsV3).to.deep.equal({});
  });

  it("Slow fill request for deposit that isn't eligible for slow fill", async function () {
    const invalidOutputToken = erc20_1;
    const depositObject = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      invalidOutputToken.address,
      amountToDeposit
    );
    await spokePoolClient_1.update();

    await requestSlowFill(spokePool_2, relayer, depositObject);
    await updateAllClients();
    const requests = spokePoolClient_2.getSlowFillRequestsForOriginChain(originChainId);
    expect(requests.length).to.equal(1);
    expect(sdkUtils.getRelayHashFromEvent(requests[0])).to.equal(sdkUtils.getRelayHashFromEvent(depositObject));

    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
      ...spokePoolClients,
      [originChainId]: spokePoolClient_1,
      [destinationChainId]: spokePoolClient_2,
    });

    expect(data1.bundleSlowFillsV3).to.deep.equal({});
    expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(1);
  });

  it("Slow fill request for deposit that isn't eligible for slow fill because origin is lite chain", async function () {
    mockConfigStore.updateGlobalConfig(
      GLOBAL_CONFIG_STORE_KEYS.LITE_CHAIN_ID_INDICES,
      JSON.stringify([spokePoolClient_1.chainId])
    );
    await mockConfigStore.update();
    (spokePoolClient_1 as any).configStoreClient = mockConfigStore;
    (spokePoolClient_2 as any).configStoreClient = mockConfigStore;
    const depositObject = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    await spokePoolClient_1.update();
    expect(mockConfigStore.liteChainIndicesUpdates.length).to.equal(1);
    expect(mockConfigStore.liteChainIndicesUpdates[0].timestamp).to.be.lt(depositObject.quoteTimestamp);
    await requestSlowFill(spokePool_2, relayer, depositObject);
    await updateAllClients();
    const requests = spokePoolClient_2.getSlowFillRequestsForOriginChain(originChainId);
    expect(requests.length).to.equal(1);
    expect(sdkUtils.getRelayHashFromEvent(requests[0])).to.equal(sdkUtils.getRelayHashFromEvent(depositObject));

    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
      ...spokePoolClients,
      [originChainId]: spokePoolClient_1,
      [destinationChainId]: spokePoolClient_2,
    });

    expect(data1.bundleSlowFillsV3).to.deep.equal({});
    expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(1);
  });

  it("Slow fill request for deposit that isn't eligible for slow fill because destination is lite chain", async function () {
    mockConfigStore.updateGlobalConfig(
      GLOBAL_CONFIG_STORE_KEYS.LITE_CHAIN_ID_INDICES,
      JSON.stringify([spokePoolClient_2.chainId])
    );
    await mockConfigStore.update();
    (spokePoolClient_1 as any).configStoreClient = mockConfigStore;
    (spokePoolClient_2 as any).configStoreClient = mockConfigStore;
    const depositObject = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    await spokePoolClient_1.update();
    expect(mockConfigStore.liteChainIndicesUpdates.length).to.equal(1);
    expect(mockConfigStore.liteChainIndicesUpdates[0].timestamp).to.be.lt(depositObject.quoteTimestamp);
    await requestSlowFill(spokePool_2, relayer, depositObject);
    await updateAllClients();
    const requests = spokePoolClient_2.getSlowFillRequestsForOriginChain(originChainId);
    expect(requests.length).to.equal(1);
    expect(sdkUtils.getRelayHashFromEvent(requests[0])).to.equal(sdkUtils.getRelayHashFromEvent(depositObject));

    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
      ...spokePoolClients,
      [originChainId]: spokePoolClient_1,
      [destinationChainId]: spokePoolClient_2,
    });

    expect(data1.bundleSlowFillsV3).to.deep.equal({});
    expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(1);
  });

  it("Invalid slow fill request against old deposit with origin lite chain", async function () {
    mockConfigStore.updateGlobalConfig(
      GLOBAL_CONFIG_STORE_KEYS.LITE_CHAIN_ID_INDICES,
      JSON.stringify([spokePoolClient_1.chainId])
    );
    await mockConfigStore.update();
    (spokePoolClient_1 as any).configStoreClient = mockConfigStore;
    (spokePoolClient_2 as any).configStoreClient = mockConfigStore;
    // Send a deposit.
    const depositObject = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    const depositBlock = await spokePool_1.provider.getBlockNumber();

    // Construct a spoke pool client with a small search range that would not include the deposit.
    spokePoolClient_1.firstBlockToSearch = depositBlock + 1;
    spokePoolClient_1.eventSearchConfig.fromBlock = spokePoolClient_1.firstBlockToSearch;
    await spokePoolClient_1.update();
    expect(mockConfigStore.liteChainIndicesUpdates.length).to.equal(1);
    expect(mockConfigStore.liteChainIndicesUpdates[0].timestamp).to.be.lt(depositObject.quoteTimestamp);
    const deposits = spokePoolClient_1.getDeposits();
    expect(deposits.length).to.equal(0);

    // Send a slow fill request now and force the bundle data client to query for the historical deposit.
    await requestSlowFill(spokePool_2, relayer, depositObject);
    await updateAllClients();
    const requests = spokePoolClient_2.getSlowFillRequestsForOriginChain(originChainId);
    expect(requests.length).to.equal(1);

    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
      ...spokePoolClients,
      [originChainId]: spokePoolClient_1,
      [destinationChainId]: spokePoolClient_2,
    });
    expect(spyLogIncludes(spy, -4, "Located V3 deposit outside of SpokePoolClient's search range")).is.true;
    expect(data1.bundleSlowFillsV3).to.deep.equal({});
    expect(data1.bundleDepositsV3).to.deep.equal({});
  });

  it("Invalid slow fill request against old deposit with destination lite chain", async function () {
    mockConfigStore.updateGlobalConfig(
      GLOBAL_CONFIG_STORE_KEYS.LITE_CHAIN_ID_INDICES,
      JSON.stringify([spokePoolClient_2.chainId])
    );
    await mockConfigStore.update();
    (spokePoolClient_1 as any).configStoreClient = mockConfigStore;
    (spokePoolClient_2 as any).configStoreClient = mockConfigStore;
    // Send a deposit.
    const depositObject = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      erc20_2.address,
      amountToDeposit
    );
    const depositBlock = await spokePool_1.provider.getBlockNumber();

    // Construct a spoke pool client with a small search range that would not include the deposit.
    spokePoolClient_1.firstBlockToSearch = depositBlock + 1;
    spokePoolClient_1.eventSearchConfig.fromBlock = spokePoolClient_1.firstBlockToSearch;
    await spokePoolClient_1.update();
    expect(mockConfigStore.liteChainIndicesUpdates.length).to.equal(1);
    expect(mockConfigStore.liteChainIndicesUpdates[0].timestamp).to.be.lt(depositObject.quoteTimestamp);
    const deposits = spokePoolClient_1.getDeposits();
    expect(deposits.length).to.equal(0);

    // Send a slow fill request now and force the bundle data client to query for the historical deposit.
    await requestSlowFill(spokePool_2, relayer, depositObject);
    await updateAllClients();
    const requests = spokePoolClient_2.getSlowFillRequestsForOriginChain(originChainId);
    expect(requests.length).to.equal(1);

    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), {
      ...spokePoolClients,
      [originChainId]: spokePoolClient_1,
      [destinationChainId]: spokePoolClient_2,
    });
    expect(spyLogIncludes(spy, -4, "Located V3 deposit outside of SpokePoolClient's search range")).is.true;
    expect(data1.bundleSlowFillsV3).to.deep.equal({});
    expect(data1.bundleDepositsV3).to.deep.equal({});
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
