import {
  AcrossApiClient,
  ConfigStoreClient,
  HubPoolClient,
  MultiCallerClient,
  SpokePoolClient,
  TokenClient,
} from "../src/clients";
import { CONFIG_STORE_VERSION } from "../src/common";
import {
  CHAIN_ID_TEST_LIST,
  amountToDeposit,
  amountToLp,
  defaultMinDepositConfirmations,
  defaultTokenConfig,
  originChainId,
  destinationChainId,
  repaymentChainId,
} from "./constants";
import { MockInventoryClient, SimpleMockHubPoolClient } from "./mocks";
import {
  Contract,
  SignerWithAddress,
  createSpyLogger,
  deployAndConfigureHubPool,
  deployConfigStore,
  deploySpokePoolWithToken,
  depositV3,
  enableRoutesOnHubPool,
  ethers,
  expect,
  getLastBlockTime,
  lastSpyLogIncludes,
  setupTokensForWallet,
  sinon,
  spyLogIncludes,
  winston,
} from "./utils";

import { Relayer } from "../src/relayer/Relayer";
import { RelayerConfig } from "../src/relayer/RelayerConfig"; // Tested
import { MockedMultiCallerClient } from "./mocks/MockMultiCallerClient";
import { MockProfitClient } from "./mocks/MockProfitClient";
import { MockCrossChainTransferClient } from "./mocks/MockCrossChainTransferClient";

describe("Relayer: Initiates slow fill requests", async function () {
  let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
  let hubPool: Contract, configStore: Contract, l1Token: Contract;
  let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
  let spy: sinon.SinonSpy, spyLogger: winston.Logger;

  let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
  let configStoreClient: ConfigStoreClient, hubPoolClient: HubPoolClient, tokenClient: TokenClient;
  let relayerInstance: Relayer, mockCrossChainTransferClient: MockCrossChainTransferClient;
  let tryMulticallClient: MultiCallerClient;
  let multiCallerClient: MultiCallerClient, profitClient: MockProfitClient, mockInventoryClient: MockInventoryClient;

  const updateAllClients = async () => {
    await configStoreClient.update();
    await hubPoolClient.update();
    await tokenClient.update();
    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update()]);
  };

  beforeEach(async function () {
    let spokePool1DeploymentBlock: number, spokePool2DeploymentBlock: number;

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

    ({ spy, spyLogger } = createSpyLogger());
    ({ configStore } = await deployConfigStore(
      owner,
      [l1Token],
      undefined,
      undefined,
      undefined,
      undefined,
      CHAIN_ID_TEST_LIST
    ));

    configStoreClient = new ConfigStoreClient(spyLogger, configStore, { fromBlock: 0 }, CONFIG_STORE_VERSION);
    await configStoreClient.update();

    hubPoolClient = new SimpleMockHubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    multiCallerClient = new MockedMultiCallerClient(spyLogger); // leave out the gasEstimator for now.
    tryMulticallClient = new MockedMultiCallerClient(spyLogger);

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
    const spokePoolClients = { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 };
    tokenClient = new TokenClient(spyLogger, relayer.address, spokePoolClients, hubPoolClient);
    profitClient = new MockProfitClient(spyLogger, hubPoolClient, spokePoolClients, [], relayer.address);
    for (const erc20 of [l1Token]) {
      await profitClient.initToken(erc20);
    }

    mockCrossChainTransferClient = new MockCrossChainTransferClient();
    mockInventoryClient = new MockInventoryClient(
      null,
      null,
      null,
      null,
      null,
      hubPoolClient,
      null,
      null,
      mockCrossChainTransferClient
    );

    const chainIds = Object.values(spokePoolClients).map(({ chainId }) => chainId);
    relayerInstance = new Relayer(
      relayer.address,
      spyLogger,
      {
        spokePoolClients,
        hubPoolClient,
        configStoreClient,
        tokenClient,
        profitClient,
        multiCallerClient,
        inventoryClient: mockInventoryClient,
        acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, chainIds),
        tryMulticallClient,
      },
      {
        relayerTokens: [],
        slowDepositors: [],
        minDepositConfirmations: defaultMinDepositConfirmations,
        tryMulticallChains: [],
        loggingInterval: -1,
      } as unknown as RelayerConfig
    );

    const weth = undefined;
    await setupTokensForWallet(spokePool_1, owner, [l1Token], weth, 100); // Seed owner to LP.
    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], weth, 10);
    await setupTokensForWallet(spokePool_2, depositor, [erc20_2], weth, 10);
    await setupTokensForWallet(spokePool_1, relayer, [erc20_1, erc20_2], weth, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_1, erc20_2], weth, 10);
    (hubPoolClient as SimpleMockHubPoolClient).mapTokenInfo(erc20_1.address, await l1Token.symbol());
    (hubPoolClient as SimpleMockHubPoolClient).mapTokenInfo(erc20_2.address, await l1Token.symbol());

    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);
    await configStore.updateTokenConfig(l1Token.address, defaultTokenConfig);

    await updateAllClients();
  });

  it("Correctly requests slow fill for v3 Deposits if insufficient token balance", async function () {
    // Transfer away a lot of the relayers funds to simulate the relayer having insufficient funds.
    const balance = await erc20_1.balanceOf(relayer.address);
    await erc20_2.connect(relayer).transfer(depositor.address, balance.sub(amountToDeposit));

    const inputToken = erc20_1.address;
    const inputAmount = await erc20_1.balanceOf(depositor.address);
    const outputToken = erc20_2.address;
    const outputAmount = balance.sub(1);

    const relayerBalance = await erc20_2.connect(relayer).balanceOf(relayer.address);
    expect(relayerBalance.lt(outputAmount)).to.be.true;

    // The relayer wallet was seeded with 5x the deposit amount. Make the deposit 6x this size.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    expect(deposit).to.exist;

    await updateAllClients();
    const _txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
    const txnHashes = await _txnReceipts[destinationChainId];
    expect(txnHashes.length).to.equal(1);
    const txn = await spokePool_1.provider.getTransaction(txnHashes[0]);
    const { name: method } = spokePool_1.interface.parseTransaction(txn);
    expect(method).to.equal("requestSlowFill");
    expect(spyLogIncludes(spy, -5, "Insufficient balance to fill all deposits")).to.be.true;
    expect(lastSpyLogIncludes(spy, "Requested slow fill for deposit.")).to.be.true;

    // Verify that the slowFill request was received by the destination SpokePoolClient.
    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
    const slowFillRequest = spokePoolClient_2.getSlowFillRequest(deposit);
    expect(slowFillRequest).to.exist;

    const txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
    for (const receipts of Object.values(txnReceipts)) {
      expect((await receipts).length).to.equal(0);
    }
    expect(lastSpyLogIncludes(spy, "Insufficient balance to fill all deposits")).to.be.true;
  });
});
