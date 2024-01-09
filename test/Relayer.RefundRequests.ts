import * as sdk from "@across-protocol/sdk-v2";
import hre from "hardhat";
import { random } from "lodash";
import {
  AcrossApiClient,
  ConfigStoreClient,
  HubPoolClient,
  MultiCallerClient,
  SpokePoolClient,
  TokenClient,
  UBAClient,
} from "../src/clients";
import { CONFIG_STORE_VERSION } from "../src/common";
import { FillWithBlock, RefundRequestWithBlock } from "../src/interfaces";
import { Relayer } from "../src/relayer/Relayer";
import { RelayerConfig } from "../src/relayer/RelayerConfig"; // Tested
import { delay } from "../src/utils";
import {
  CHAIN_ID_TEST_LIST,
  amountToLp,
  defaultMinDepositConfirmations,
  defaultTokenConfig,
  repaymentChainId,
} from "./constants";
import { MockConfigStoreClient, MockInventoryClient, MockProfitClient } from "./mocks";
import { MockedMultiCallerClient } from "./mocks/MockMultiCallerClient";
import {
  Contract,
  SignerWithAddress,
  buildDeposit,
  buildFillForRepaymentChain,
  buildRefundRequest,
  createSpyLogger,
  deployAndConfigureHubPool,
  deployConfigStore,
  deploySpokePoolWithToken,
  destinationChainId,
  enableRoutesOnHubPool,
  ethers,
  expect,
  getLastBlockTime,
  originChainId,
  setupTokensForWallet,
  toBNWei,
  winston,
} from "./utils";
import { generateNoOpSpokePoolClientsForDefaultChainIndices } from "./utils/UBAUtils";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let hubPool: Contract, configStore: Contract, l1Token: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
let spyLogger: winston.Logger;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let spokePoolClients: { [chainId: number]: SpokePoolClient };
let configStoreClient: ConfigStoreClient, hubPoolClient: HubPoolClient, tokenClient: TokenClient;
let relayerInstance: Relayer;
let multiCallerClient: MultiCallerClient, profitClient: MockProfitClient;
let spokePool1DeploymentBlock: number, spokePool2DeploymentBlock: number;
let ubaClient: UBAClient;

// @dev During test it occasionally occurs that hre does not mine a block, even though a transaction was submitted.
// This leads to sporadic failures. Therefore, implement a polling loop and kick the chain as needed in order to ensure
// it doesn't stall. This absolutely should not be necessary; there's obviously one or more bugs somewhere.
// @todo: Resolve this.
async function waitOnBlock(spokePoolClient: SpokePoolClient): Promise<void> {
  const provider = spokePoolClient.spokePool.provider;

  let loop = 0;
  let latest = await provider.getBlockNumber();
  while (latest <= spokePoolClient.latestBlockSearched) {
    if (loop++ % 5 === 0) {
      await hre.network.provider.send("evm_mine");
    }
    await delay(0.1);
    latest = await provider.getBlockNumber();
  }
}

describe("Relayer: Request refunds for cross-chain repayments", async function () {
  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    ({
      spokePool: spokePool_1,
      erc20: erc20_1,
      deploymentBlock: spokePool1DeploymentBlock,
    } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({
      spokePool: spokePool_2,
      erc20: erc20_2,
      deploymentBlock: spokePool2DeploymentBlock,
    } = await deploySpokePoolWithToken(destinationChainId, originChainId));

    ({ hubPool, l1Token_1: l1Token } = await deployAndConfigureHubPool(owner, [
      { l2ChainId: destinationChainId, spokePool: spokePool_2 },
      { l2ChainId: originChainId, spokePool: spokePool_1 },
      { l2ChainId: repaymentChainId, spokePool: spokePool_1 },
      { l2ChainId: 1, spokePool: spokePool_1 },
    ]));

    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token, destinationToken: erc20_1 },
      { destinationChainId: destinationChainId, l1Token, destinationToken: erc20_2 },
    ]);

    ({ spyLogger } = createSpyLogger());
    ({ configStore } = await deployConfigStore(
      owner,
      [l1Token],
      undefined,
      undefined,
      undefined,
      undefined,
      CHAIN_ID_TEST_LIST
    ));
    configStoreClient = new MockConfigStoreClient(
      spyLogger,
      configStore,
      { fromBlock: 0 },
      CONFIG_STORE_VERSION,
      [originChainId, destinationChainId],
      originChainId,
      false
    ) as unknown as ConfigStoreClient;
    await configStoreClient.update();

    hubPoolClient = new HubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    multiCallerClient = new MockedMultiCallerClient(spyLogger);

    spokePoolClient_1 = new SpokePoolClient(
      spyLogger,
      spokePool_1.connect(relayer),
      hubPoolClient,
      originChainId,
      spokePool1DeploymentBlock
    );
    spokePoolClient_2 = new SpokePoolClient(
      spyLogger,
      spokePool_2.connect(relayer),
      hubPoolClient,
      destinationChainId,
      spokePool2DeploymentBlock
    );

    // Map SpokePool clients by chain ID.
    spokePoolClients = Object.fromEntries(
      [spokePoolClient_1, spokePoolClient_2].map((spokePoolClient) => [spokePoolClient.chainId, spokePoolClient])
    );

    for (const spokePoolClient of Object.values(spokePoolClients)) {
      await spokePoolClient.update();
    }

    ubaClient = new UBAClient(
      new sdk.clients.UBAClientConfig(),
      [],
      hubPoolClient,
      generateNoOpSpokePoolClientsForDefaultChainIndices(spokePoolClients)
    );
    tokenClient = new TokenClient(spyLogger, relayer.address, spokePoolClients, hubPoolClient);
    profitClient = new MockProfitClient(spyLogger, hubPoolClient, spokePoolClients, []);

    relayerInstance = new Relayer(
      relayer.address,
      spyLogger,
      {
        spokePoolClients,
        hubPoolClient,
        configStoreClient,
        ubaClient,
        tokenClient,
        profitClient,
        multiCallerClient,
        inventoryClient: new MockInventoryClient(),
        acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, spokePoolClients),
      },
      {
        relayerTokens: [],
        slowDepositors: [],
        relayerDestinationChains: [],
        minDepositConfirmations: defaultMinDepositConfirmations,
      } as unknown as RelayerConfig
    );

    await setupTokensForWallet(spokePool_1, owner, [l1Token], null, 100); // Seed owner to LP.
    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], null, 10);
    await setupTokensForWallet(spokePool_2, depositor, [erc20_2], null, 10);
    await setupTokensForWallet(spokePool_1, relayer, [erc20_1, erc20_2], null, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_1, erc20_2], null, 10);

    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);
    await configStore.updateTokenConfig(l1Token.address, defaultTokenConfig);

    await updateAllClients();

    // Set the spokePool's time to the provider time. This is done to enable the block utility time finder identify a
    // "reasonable" block number based off the block time when looking at quote timestamps.
    for (const spokePool of [spokePool_1, spokePool_2]) {
      await spokePool.setCurrentTime(await getLastBlockTime(spokePool.provider));
    }
  });

  it("Correctly identifies fills eligible for cross-chain refunds", async function () {
    const deposit = await buildDeposit(
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token,
      depositor,
      destinationChainId,
      toBNWei(random(1, 10).toPrecision(9))
    );
    await buildFillForRepaymentChain(spokePool_2, relayer, deposit, 1, spokePoolClient_1.chainId);
    await updateAllClients();

    const fills = await ubaClient.getFills(spokePoolClient_2.chainId, { relayer: relayer.address });
    expect(fills.length).to.equal(1);
    const fill = fills[0] as FillWithBlock;

    expect(fill.depositId).to.equal(deposit.depositId);
    expect(fill.amount).to.equal(deposit.amount);
    expect(fill.relayer).to.equal(relayer.address);

    const refundRequests = await ubaClient.getRefundRequests(spokePoolClient_1.chainId, { relayer: relayer.address });
    expect(refundRequests.length).to.equal(0);

    const eligibleFills = await relayerInstance.findFillsWithoutRefundRequests(
      spokePoolClient_2.chainId,
      refundRequests,
      spokePoolClient_2.deploymentBlock
    );
    expect(eligibleFills.length).to.equal(1);
    const eligibleFill = eligibleFills[0] as FillWithBlock;
    expect(eligibleFill).to.deep.equal(fill);
  });

  it("Correctly submits requestRefund transactions", async function () {
    const deposit = await buildDeposit(
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token,
      depositor,
      destinationChainId,
      toBNWei(random(1, 10).toPrecision(9))
    );
    await buildFillForRepaymentChain(spokePool_2, relayer, deposit, 1, spokePoolClient_1.chainId);
    await updateAllClients();

    const fills = spokePoolClient_2.getFillsForRelayer(relayer.address);
    expect(fills.length).to.equal(1);
    const fill = fills[0] as FillWithBlock;

    expect(fill.depositId).to.equal(deposit.depositId);
    expect(fill.amount).to.equal(deposit.amount);
    expect(fill.relayer).to.equal(relayer.address);

    expect(spokePoolClient_1.getRefundRequests().length).to.equal(0);
    await relayerInstance.requestRefunds();
    await waitOnBlock(spokePoolClient_1);
    await updateAllClients();

    let refundRequests = spokePoolClient_1.getRefundRequests();
    expect(refundRequests.length).to.equal(1);
    let refundRequest = refundRequests[0] as RefundRequestWithBlock;
    const transactionHash = refundRequest.transactionHash;

    expect(refundRequest.depositId).to.equal(deposit.depositId);
    expect(refundRequest.amount).to.equal(deposit.amount);
    expect(refundRequest.relayer).to.equal(relayer.address);

    // Extension: Ensure that the refund request is not resubmitted.
    await relayerInstance.requestRefunds();
    await waitOnBlock(spokePoolClient_1);
    await updateAllClients();

    refundRequests = spokePoolClient_1.getRefundRequests();
    expect(refundRequests.length).to.equal(1);
    refundRequest = refundRequests[0] as RefundRequestWithBlock;
    expect(refundRequest.transactionHash).to.equal(transactionHash);
  });

  // @note Temporarily disabled, pending upstream fixes in the SDK.
  it("Skips refund requests for invalid fills", async function () {
    const deposit = await buildDeposit(
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token,
      depositor,
      destinationChainId,
      toBNWei(random(1, 10).toPrecision(9))
    );

    // Submit a invalid fill (for a non-existent deposit).
    const fakeDeposit = { ...deposit };
    fakeDeposit.realizedLpFeePct = fakeDeposit.realizedLpFeePct.sub(1);
    fakeDeposit.relayerFeePct = fakeDeposit.relayerFeePct.sub(fakeDeposit.relayerFeePct);

    const fakeFill = await buildFillForRepaymentChain(spokePool_2, relayer, fakeDeposit, 1, spokePoolClient_1.chainId);
    await waitOnBlock(spokePoolClient_2);
    await updateAllClients();

    // Confirm that both the deposit and fill were read by the relevant SpokePoolClient instances.
    expect(spokePoolClient_1.getDeposits().length).to.equal(1);
    const fills = spokePoolClient_2.getFillsForRelayer(relayer.address);
    expect(fills.length).to.equal(1); // 1 invalid fill
    expect(fills[0].depositId).to.equal(fakeDeposit.depositId);
    expect(fills[0].depositId).to.equal(fakeFill.depositId);

    let refundRequests = spokePoolClient_1.getRefundRequests();
    expect(refundRequests.length).to.equal(0);

    await relayerInstance.requestRefunds();
    await waitOnBlock(spokePoolClient_1);
    await updateAllClients();

    refundRequests = spokePoolClient_1.getRefundRequests();
    expect(refundRequests.length).to.equal(0);
  });

  it("Ignores invalid refund requests", async function () {
    // Submit a deposit.
    const deposit = await buildDeposit(
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token,
      depositor,
      destinationChainId,
      toBNWei(random(1, 10).toPrecision(9))
    );

    // Submit a legitimate fill for the deposit.
    await buildFillForRepaymentChain(spokePool_2, relayer, deposit, 1, spokePoolClient_1.chainId);
    await waitOnBlock(spokePoolClient_2);
    await updateAllClients();

    // Confirm that both the deposit and fill were read by the relevant SpokePoolClient instances.
    const deposits = spokePoolClient_1.getDeposits();
    expect(deposits.length).to.equal(1);
    expect(deposits[0].depositId).to.equal(deposit.depositId);

    const fill = (await ubaClient.getFills(spokePoolClient_2.chainId, { relayer: relayer.address }))[0];
    expect(fill).to.not.be.undefined;
    expect(fill.depositId).to.equal(deposit.depositId);

    // Submit an _invalid_ refund request for the valid fill.
    const refundToken = erc20_1.address;
    const dummyFill = { ...fill };
    dummyFill.realizedLpFeePct = dummyFill.realizedLpFeePct.sub(1);
    const { hash: transactionHash } = await buildRefundRequest(
      spokePoolClient_1.spokePool,
      relayer,
      dummyFill,
      refundToken
    );
    await waitOnBlock(spokePoolClient_2);
    await updateAllClients();

    // Confirm the invalid fill is received by the SpokePoolClient.
    let refundRequests = spokePoolClient_1.getRefundRequests();
    expect(refundRequests.length).to.equal(1);
    expect(refundRequests[0].depositId).to.equal(deposit.depositId);
    expect(refundRequests[0].transactionHash).to.equal(transactionHash);

    // Request the relayer to evaluate fills and refund requests, and submit any new refund requests if necessary.
    await relayerInstance.requestRefunds();
    await waitOnBlock(spokePoolClient_1);
    await updateAllClients();

    // Ensure that the relayer submitted a refund request.
    refundRequests = spokePoolClient_1.getRefundRequests();
    expect(refundRequests.length).to.equal(2);
    refundRequests.forEach(({ depositId }) => expect(depositId).to.equal(deposit.depositId));
    expect(refundRequests[0].transactionHash).to.equal(transactionHash);
  });

  it.skip("Finds deposits outside of the relayer lookback window", async function () {
    // @todo
    return;
  });

  it.skip("Finds fills outside of the relayer lookback window", async function () {
    // @todo
    return;
  });
});

async function updateAllClients() {
  await configStoreClient.update();
  await hubPoolClient.update();
  await tokenClient.update();
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
}
