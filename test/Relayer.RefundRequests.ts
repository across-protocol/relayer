import { random } from "lodash";
import {
  ethers,
  expect,
  Contract,
  SignerWithAddress,
  setupTokensForWallet,
  getLastBlockTime,
  buildDeposit,
  buildFillForRepaymentChain,
} from "./utils";
import { createSpyLogger, deployConfigStore, deployAndConfigureHubPool, winston } from "./utils";
import { deploySpokePoolWithToken, enableRoutesOnHubPool, destinationChainId } from "./utils";
import { originChainId, toBNWei } from "./utils";
import { amountToLp, defaultMinDepositConfirmations, defaultTokenConfig } from "./constants";
import {
  SpokePoolClient,
  HubPoolClient,
  ConfigStoreClient,
  MultiCallerClient,
  AcrossApiClient,
  TokenClient,
  UBAClient,
} from "../src/clients";
import { FillWithBlock, RefundRequestWithBlock } from "../src/interfaces";
import { CONFIG_STORE_VERSION } from "../src/common";
import { delay } from "../src/utils";
import { MockInventoryClient, MockProfitClient } from "./mocks";
import { Relayer } from "../src/relayer/Relayer";
import { RelayerConfig } from "../src/relayer/RelayerConfig"; // Tested
import { MockedMultiCallerClient } from "./mocks/MockMultiCallerClient";

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
    ]));

    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token, destinationToken: erc20_1 },
      { destinationChainId: destinationChainId, l1Token, destinationToken: erc20_2 },
    ]);

    ({ spyLogger } = createSpyLogger());
    ({ configStore } = await deployConfigStore(owner, [l1Token]));
    configStoreClient = new ConfigStoreClient(spyLogger, configStore, { fromBlock: 0 }, CONFIG_STORE_VERSION, []);
    hubPoolClient = new HubPoolClient(spyLogger, hubPool, configStoreClient);

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
    spokePoolClients = { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 };

    const chainIds = [originChainId, destinationChainId];
    ubaClient = new UBAClient(chainIds, hubPoolClient, spokePoolClients, spyLogger);
    tokenClient = new TokenClient(spyLogger, relayer.address, spokePoolClients, hubPoolClient);
    profitClient = new MockProfitClient(spyLogger, hubPoolClient, spokePoolClients, []);
    profitClient.testInit();

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
        maxRelayerLookBack: 24 * 60 * 60,
        minDepositConfirmations: defaultMinDepositConfirmations,
        quoteTimeBuffer: 0,
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

    const fills = spokePoolClient_2.getFillsForRelayer(relayer.address);
    expect(fills.length).to.equal(1);
    const fill = fills.pop() as FillWithBlock;

    expect(fill.depositId).to.equal(deposit.depositId);
    expect(fill.amount).to.equal(deposit.amount);
    expect(fill.relayer).to.equal(relayer.address);

    expect(spokePoolClient_1.getRefundRequests().length).to.equal(0);

    const eligibleFills = relayerInstance.findEligibleFills(spokePoolClient_2, []);
    expect(eligibleFills.length).to.equal(1);
    const eligibleFill = eligibleFills.pop() as FillWithBlock;
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
    const fill = fills.pop() as FillWithBlock;

    expect(fill.depositId).to.equal(deposit.depositId);
    expect(fill.amount).to.equal(deposit.amount);
    expect(fill.relayer).to.equal(relayer.address);

    expect(spokePoolClient_1.getRefundRequests().length).to.equal(0);
    await relayerInstance.requestRefunds();

    // @note: hre doesn't always increment block numbers immediately after a txn, so burn
    // some time here so the subsequent call to spokePoolClient.update() doesn't bail.
    let latest: number;
    do {
      latest = await spokePoolClient_1.spokePool.provider.getBlockNumber();
      await delay(0.25);
    } while (latest <= spokePoolClient_1.latestBlockNumber);

    await updateAllClients();

    const refundRequests = spokePoolClient_1.getRefundRequests();
    expect(refundRequests.length).to.equal(1);
    const refundRequest = refundRequests.pop() as RefundRequestWithBlock;

    expect(refundRequest.depositId).to.equal(deposit.depositId);
    expect(refundRequest.amount).to.equal(deposit.amount);
    expect(refundRequest.relayer).to.equal(relayer.address);
  });

  it.skip("Ignores invalid refund requests", async function () {
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
