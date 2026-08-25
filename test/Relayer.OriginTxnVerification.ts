import {
  AcrossApiClient,
  ConfigStoreClient,
  HubPoolClient,
  MultiCallerClient,
  SpokePoolClient,
  TokenClient,
  EVMSpokePoolClient,
} from "../src/clients";
import { CONFIG_STORE_VERSION } from "../src/common";
import { DepositWithBlock } from "../src/interfaces";
import {
  CHAIN_ID_TEST_LIST,
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
  setupTokensForWallet,
  sinon,
  winston,
  deployMulticall3,
} from "./utils";
import { SvmAddress, EvmAddress, bnOne } from "../src/utils";

import { Relayer } from "../src/relayer/Relayer";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import { MockedMultiCallerClient } from "./mocks/MockMultiCallerClient";
import { MockProfitClient } from "./mocks/MockProfitClient";
import { MockCrossChainTransferClient } from "./mocks/MockCrossChainTransferClient";

describe("Relayer: Verify origin transaction", function () {
  let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
  let hubPool: Contract, configStore: Contract, l1Token: Contract;
  let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
  let spyLogger: winston.Logger;

  let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
  let configStoreClient: ConfigStoreClient, hubPoolClient: HubPoolClient, tokenClient: TokenClient;
  let relayerInstance: Relayer, mockCrossChainTransferClient: MockCrossChainTransferClient;
  let tryMulticallClient: MultiCallerClient;
  let multiCallerClient: MultiCallerClient, profitClient: MockProfitClient, mockInventoryClient: MockInventoryClient;
  let deposit: DepositWithBlock;

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

    for (const deployer of [depositor, relayer]) {
      await deployMulticall3(deployer);
    }

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

    configStoreClient = new ConfigStoreClient(spyLogger, configStore, { from: 0 }, CONFIG_STORE_VERSION);
    await configStoreClient.update();

    hubPoolClient = new SimpleMockHubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    multiCallerClient = new MockedMultiCallerClient(spyLogger);
    tryMulticallClient = new MockedMultiCallerClient(spyLogger);

    spokePoolClient_1 = new EVMSpokePoolClient(
      spyLogger,
      spokePool_1.connect(relayer),
      hubPoolClient,
      originChainId,
      spokePool1DeploymentBlock
    );
    spokePoolClient_2 = new EVMSpokePoolClient(
      spyLogger,
      spokePool_2.connect(relayer),
      hubPoolClient,
      destinationChainId,
      spokePool2DeploymentBlock
    );
    const spokePoolClients = { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 };

    const svmAddress = SvmAddress.from("11111111111111111111111111111111");
    tokenClient = new TokenClient(
      spyLogger,
      EvmAddress.from(relayer.address),
      svmAddress,
      spokePoolClients,
      hubPoolClient
    );
    profitClient = new MockProfitClient(spyLogger, hubPoolClient, spokePoolClients, [], relayer.address);
    for (const erc20 of [l1Token]) {
      await profitClient.initToken(erc20);
    }

    mockCrossChainTransferClient = new MockCrossChainTransferClient();
    mockInventoryClient = new MockInventoryClient(
      null,
      spyLogger,
      null,
      null,
      null,
      hubPoolClient,
      null,
      null,
      mockCrossChainTransferClient
    );
    mockInventoryClient.setTokenMapping({
      [l1Token.address]: {
        [originChainId]: erc20_1.address,
        [destinationChainId]: erc20_2.address,
      },
    });
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
        relayerDestinationTokens: {},
        slowDepositors: [],
        minDepositConfirmations: defaultMinDepositConfirmations,
        tryMulticallChains: [],
        sendingMessageRelaysEnabled: {},
        loggingInterval: -1,
        verifyOriginTxn: true,
      } as unknown as RelayerConfig
    );

    const weth = undefined;
    await setupTokensForWallet(spokePool_1, owner, [l1Token], weth, 100);
    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], weth, 10);
    await setupTokensForWallet(spokePool_2, depositor, [erc20_2], weth, 10);
    await setupTokensForWallet(spokePool_1, relayer, [erc20_1, erc20_2], weth, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_1, erc20_2], weth, 10);
    (hubPoolClient as SimpleMockHubPoolClient).mapTokenInfo(EvmAddress.from(erc20_1.address), await l1Token.symbol());
    (hubPoolClient as SimpleMockHubPoolClient).mapTokenInfo(EvmAddress.from(erc20_2.address), await l1Token.symbol());

    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);
    await configStore.updateTokenConfig(l1Token.address, defaultTokenConfig);

    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    const inputAmount = (await erc20_1.balanceOf(depositor.address)).div(10);
    await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      inputAmount,
      erc20_2.address,
      inputAmount.div(2)
    );

    await updateAllClients();
    [deposit] = spokePoolClient_1.getDeposits();
    expect(deposit).to.exist;
  });

  it("Accepts a deposit whose origin transaction is unchanged", async function () {
    expect(await relayerInstance.originTxnUnchanged(deposit)).to.be.true;
  });

  it("Skips verification when disabled", async function () {
    (relayerInstance.config as unknown as { verifyOriginTxn: boolean }).verifyOriginTxn = false;

    // Even a transaction that was never mined is accepted when verification is disabled.
    const txnRef = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    expect(await relayerInstance.originTxnUnchanged({ ...deposit, txnRef })).to.be.true;
  });

  it("Rejects a deposit whose origin transaction is no longer mined", async function () {
    const txnRef = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    expect(await relayerInstance.originTxnUnchanged({ ...deposit, txnRef })).to.be.false;
  });

  it("Rejects a deposit whose origin transaction moved block or index", async function () {
    const { blockNumber, txnIndex } = deposit;
    expect(await relayerInstance.originTxnUnchanged({ ...deposit, blockNumber: blockNumber + 1 })).to.be.false;
    expect(await relayerInstance.originTxnUnchanged({ ...deposit, txnIndex: txnIndex + 1 })).to.be.false;
  });

  // The receipt-level checks above all pass in this scenario; only comparing the emitted relay data catches it.
  it("Rejects a deposit whose relay data no longer matches the emitted event", async function () {
    const depositId = deposit.depositId.add(bnOne);
    expect(await relayerInstance.originTxnUnchanged({ ...deposit, depositId })).to.be.false;

    const outputAmount = deposit.outputAmount.sub(bnOne);
    expect(await relayerInstance.originTxnUnchanged({ ...deposit, outputAmount })).to.be.false;

    const recipient = EvmAddress.from(relayer.address);
    expect(await relayerInstance.originTxnUnchanged({ ...deposit, recipient })).to.be.false;
  });

  it("Fails open when the origin transaction can't be queried", async function () {
    const { provider } = (spokePoolClient_1 as EVMSpokePoolClient).spokePool;
    const stub = sinon.stub(provider, "getTransactionReceipt").rejects(new Error("RPC unavailable"));

    try {
      expect(await relayerInstance.originTxnUnchanged(deposit)).to.be.true;
    } finally {
      stub.restore();
    }
  });

  it("Queries each origin transaction at most once per loop", async function () {
    const { provider } = (spokePoolClient_1 as EVMSpokePoolClient).spokePool;
    const spy = sinon.spy(provider, "getTransactionReceipt");

    try {
      // Deposits sharing an origin transaction resolve against a single receipt lookup.
      await relayerInstance.prefetchOriginTxns([deposit, deposit]);
      expect(await relayerInstance.originTxnUnchanged(deposit)).to.be.true;
      expect(await relayerInstance.originTxnUnchanged(deposit)).to.be.true;
      expect(spy.callCount).to.equal(1);
    } finally {
      spy.restore();
    }
  });
});
