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
  getDefaultBlockRange,
  getDisabledBlockRanges,
  randomAddress,
  requestSlowFill,
  sinon,
  smock,
  spyLogIncludes,
} from "./utils";

import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { getCurrentTime, toBNWei, ZERO_ADDRESS, bnZero } from "../src/utils";
import { MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient } from "./mocks";
import { interfaces, utils as sdkUtils, constants as sdkConstants, providers } from "@across-protocol/sdk";
import { cloneDeep } from "lodash";
import { INFINITE_FILL_DEADLINE } from "../src/common";

describe("Dataworker: Load bundle data: Computing slow fills", async function () {
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
      {} as DataworkerConfig,
      { ...dataworkerInstance.clients, bundleDataClient },
      dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers,
      dataworkerInstance.maxRefundCountOverride,
      dataworkerInstance.maxL1TokenCountOverride,
      dataworkerInstance.blockRangeEndBlockBuffer
    );
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

  it("Ignores disabled chains for slow fill requests", async function () {
    // Only one deposit is eligible to be slow filled because its input and output tokens are equivalent.
    generateV3Deposit({ outputToken: randomAddress() });
    generateV3Deposit({ outputToken: erc20_2.address });
    await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
    const deposits = mockOriginSpokePoolClient.getDeposits();

    generateSlowFillRequestFromDeposit(deposits[0]);
    generateSlowFillRequestFromDeposit(deposits[1]);
    await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill"]);
    expect(mockDestinationSpokePoolClient.getSlowFillRequestsForOriginChain(originChainId).length).to.equal(2);

    const emptyData = await dataworkerInstance.clients.bundleDataClient.loadData(
      getDisabledBlockRanges(),
      spokePoolClients
    );
    expect(emptyData.bundleDepositsV3).to.deep.equal({});
    expect(emptyData.expiredDepositsToRefundV3).to.deep.equal({});
    expect(emptyData.bundleSlowFillsV3).to.deep.equal({});
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

  it("Handles slow fill requests out of block range", async function () {
    generateV3Deposit({
      outputToken: erc20_2.address,
      blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 1,
    });
    generateV3Deposit({
      outputToken: erc20_2.address,
      blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 11,
    });
    generateV3Deposit({
      outputToken: erc20_2.address,
      blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 21,
    });
    await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
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
    // Create a block range that contains only the middle events.
    const destinationChainBlockRange = [events[1].blockNumber - 1, events[1].blockNumber + 1];
    const originChainBlockRange = [deposits[1].blockNumber - 1, deposits[1].blockNumber + 1];
    // Substitute bundle block ranges.
    const bundleBlockRanges = getDefaultBlockRange(5);
    const destinationChainIndex =
      dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
    bundleBlockRanges[destinationChainIndex] = destinationChainBlockRange;
    const originChainIndex = dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(originChainId);
    bundleBlockRanges[originChainIndex] = originChainBlockRange;
    await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill"]);
    expect(mockDestinationSpokePoolClient.getSlowFillRequestsForOriginChain(originChainId).length).to.equal(3);
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
    expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address].length).to.equal(1);
    expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address][0].depositId).to.equal(
      events[1].args.depositId
    );
  });

  it("Validates slow fill request against old bundle deposit if deposit is not in-memory", async function () {
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

  it("Does not validate slow fill request against future bundle deposit if deposit is not in-memory", async function () {
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
    // the slow fill request invalid.
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

    // Send a slow fill request now and force the bundle data client to query for the historical deposit.
    await requestSlowFill(spokePool_2, relayer, depositObject);
    await updateAllClients();
    const requests = spokePoolClient_2.getSlowFillRequestsForOriginChain(originChainId);
    expect(requests.length).to.equal(1);

    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, {
      ...spokePoolClients,
      [originChainId]: spokePoolClient_1,
      [destinationChainId]: spokePoolClient_2,
    });
    expect(data1.bundleSlowFillsV3).to.deep.equal({});
    expect(data1.bundleDepositsV3).to.deep.equal({});
    expect(spy.getCalls().filter((e) => e.lastArg.message.includes("invalid slow fill requests")).length).to.equal(1);
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
      depositId: deposit.depositId.add(1),
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

    // Send a slow fill request now and force the bundle data client to query for the historical deposit.
    await requestSlowFill(spokePool_2, relayer, { ...depositObject, depositId: depositObject.depositId.add(1) });
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

    // Send a legacy deposit. We'll set output token to a random token to invalidate the slow fill request (e.g.
    // input and output are not "equivalent" tokens)
    const invalidOutputToken = erc20_1;
    const depositObject = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      amountToDeposit,
      invalidOutputToken.address,
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
    expect(
      spy
        .getCalls()
        .find((e) => e.lastArg.message.includes("Located V3 deposit outside of SpokePoolClient's search range"))
    ).to.not.be.undefined;

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
    expect(sdkUtils.getRelayHashFromEvent({ ...requests[0], message: depositObject.message })).to.equal(
      sdkUtils.getRelayHashFromEvent(depositObject)
    );

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
    expect(sdkUtils.getRelayHashFromEvent({ ...requests[0], message: depositObject.message })).to.equal(
      sdkUtils.getRelayHashFromEvent(depositObject)
    );

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
    expect(sdkUtils.getRelayHashFromEvent({ ...requests[0], message: depositObject.message })).to.equal(
      sdkUtils.getRelayHashFromEvent(depositObject)
    );

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

  it("Does not create slow fill for zero value deposit", async function () {
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
    generateSlowFillRequestFromDeposit(deposits[0]);
    generateSlowFillRequestFromDeposit({
      ...deposits[1],
      message: sdkConstants.ZERO_BYTES,
    });
    await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill"]);
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), spokePoolClients);

    expect(data1.bundleSlowFillsV3).to.deep.equal({});
  });

  it("Does not create a slow fill leaf if fast fill follows slow fill request but repayment information is invalid", async function () {
    generateV3Deposit({ outputToken: erc20_2.address });
    await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
    const deposits = mockOriginSpokePoolClient.getDeposits();

    generateSlowFillRequestFromDeposit(deposits[0]);

    // Fill deposits with invalid repayment information
    const invalidRelayer = ethers.utils.randomBytes(32);
    const invalidFillEvent = generateV3FillFromDeposit(
      deposits[0],
      { method: "fillRelay" },
      invalidRelayer,
      undefined,
      interfaces.FillType.ReplacedSlowFill
    );
    await mockDestinationSpokePoolClient.update(["FilledRelay", "RequestedV3SlowFill"]);
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

    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), spokePoolClients);

    // Slow fill request, fast fill and deposit should all be in same bundle. Test that the bundle data client is
    // aware of the fill, even if its invalid, and therefore doesn't create a slow fill leaf.

    // The fill cannot be refunded but there is still an unexecutable slow fill leaf we need to refund.
    expect(data1.bundleFillsV3).to.deep.equal({});
    expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(1);
    expect(data1.bundleSlowFillsV3).to.deep.equal({});
    const logs = spy.getCalls().filter((x) => x.lastArg.message.includes("unrepayable"));
    expect(logs.length).to.equal(1);
  });
});
