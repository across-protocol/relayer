import {
  AcrossApiClient,
  ConfigStoreClient,
  EVMSpokePoolClient,
  MultiCallerClient,
  SpokePoolClient,
} from "../src/clients";
import { CONFIG_STORE_VERSION } from "../src/common";
import { Relayer } from "../src/relayer/Relayer";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import {
  CHAIN_ID_TEST_LIST,
  amountToLp,
  defaultMinDepositConfirmations,
  defaultTokenConfig,
  destinationChainId,
  originChainId,
} from "./constants";
import { MockInventoryClient, MockProfitClient, SimpleMockHubPoolClient, SimpleMockTokenClient } from "./mocks";
import { MockedMultiCallerClient } from "./mocks/MockMultiCallerClient";
import {
  BigNumber,
  Contract,
  SignerWithAddress,
  deployAndConfigureHubPool,
  deployConfigStore,
  deployMulticall3,
  deploySpokePoolWithToken,
  depositV3,
  enableRoutesOnHubPool,
  ethers,
  expect,
  getLastBlockTime,
  setupTokensForWallet,
  toBN,
  toBNWei,
  winston,
  createSpyLogger,
} from "./utils";
import { EvmAddress, SvmAddress } from "../src/utils";

describe("Relayer: concurrent destination balance", function () {
  let spokePoolOrigin: Contract, originToken: Contract;
  let spokePoolDestination: Contract, destinationToken: Contract;
  let hubPool: Contract, configStore: Contract, l1Token: Contract;
  let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
  let spokePoolOriginClient: SpokePoolClient, spokePoolDestinationClient: SpokePoolClient;
  let configStoreClient: ConfigStoreClient, hubPoolClient: SimpleMockHubPoolClient;
  let tokenClient: SimpleMockTokenClient, profitClient: MockProfitClient;
  let inventoryClient: MockInventoryClient, relayerInstance: Relayer;
  let multiCallerClient: MultiCallerClient, tryMulticallClient: MultiCallerClient;
  let deploymentBlockOrigin: number, deploymentBlockDestination: number;
  let inputAmount: BigNumber, outputAmount: BigNumber;

  const updateAllClients = async (): Promise<void> => {
    await configStoreClient.update();
    await hubPoolClient.update();
    await tokenClient.update();
    await Promise.all([spokePoolOriginClient.update(), spokePoolDestinationClient.update()]);
    tokenClient.clearTokenShortfall();
  };

  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    ({ spokePool: spokePoolOrigin, erc20: originToken, deploymentBlock: deploymentBlockOrigin } =
      await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({ spokePool: spokePoolDestination, erc20: destinationToken, deploymentBlock: deploymentBlockDestination } =
      await deploySpokePoolWithToken(destinationChainId, originChainId));
    ({ hubPool, l1Token_1: l1Token } = await deployAndConfigureHubPool(owner, [
      { l2ChainId: originChainId, spokePool: spokePoolOrigin },
      { l2ChainId: destinationChainId, spokePool: spokePoolDestination },
      { l2ChainId: 1, spokePool: spokePoolOrigin },
    ]));
    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token, destinationToken: originToken },
      { destinationChainId: destinationChainId, l1Token, destinationToken },
    ]);
    for (const signer of [depositor, relayer]) {
      await deployMulticall3(signer);
    }

    const { spyLogger } = createSpyLogger();
    ({ configStore } = await deployConfigStore(owner, [l1Token], undefined, undefined, undefined, undefined, CHAIN_ID_TEST_LIST));
    configStoreClient = new ConfigStoreClient(spyLogger, configStore, { from: 0 }, CONFIG_STORE_VERSION);
    await configStoreClient.update();
    hubPoolClient = new SimpleMockHubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    multiCallerClient = new MockedMultiCallerClient(spyLogger);
    tryMulticallClient = new MockedMultiCallerClient(spyLogger);
    spokePoolOriginClient = new EVMSpokePoolClient(
      spyLogger,
      spokePoolOrigin.connect(relayer),
      hubPoolClient,
      originChainId,
      deploymentBlockOrigin
    );
    spokePoolDestinationClient = new EVMSpokePoolClient(
      spyLogger,
      spokePoolDestination.connect(relayer),
      hubPoolClient,
      destinationChainId,
      deploymentBlockDestination
    );
    const spokePoolClients = {
      [originChainId]: spokePoolOriginClient,
      [destinationChainId]: spokePoolDestinationClient,
    };
    tokenClient = new SimpleMockTokenClient(
      spyLogger,
      EvmAddress.from(relayer.address),
      SvmAddress.from("11111111111111111111111111111111"),
      spokePoolClients,
      hubPoolClient
    );
    tokenClient.setRemoteTokens([l1Token, originToken, destinationToken]);
    profitClient = new MockProfitClient(spyLogger, hubPoolClient, spokePoolClients, []);
    await profitClient.initToken(l1Token);
    inventoryClient = new MockInventoryClient(null, spyLogger, null, null, null, hubPoolClient);
    inventoryClient.setTokenMapping({
      [l1Token.address]: {
        [originChainId]: originToken.address,
        [destinationChainId]: destinationToken.address,
      },
    });
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
        tryMulticallClient,
        inventoryClient,
        acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, [originChainId, destinationChainId]),
      },
      {
        relayerTokens: [],
        relayerDestinationTokens: {},
        slowDepositors: [],
        minDepositConfirmations: defaultMinDepositConfirmations,
        tryMulticallChains: [],
        sendingRelaysEnabled: true,
        sendingTransactionsEnabled: true,
        sendingMessageRelaysEnabled: {},
        allowedRecipients: {},
        loggingInterval: -1,
      } as unknown as RelayerConfig
    );

    const decimals = await originToken.decimals();
    outputAmount = toBN(100).mul(toBN(10).pow(decimals));
    inputAmount = outputAmount.mul(101).div(100);
    await setupTokensForWallet(spokePoolOrigin, owner, [l1Token], undefined, 100);
    await setupTokensForWallet(spokePoolOrigin, depositor, [originToken], undefined, 300);
    await destinationToken.mint(relayer.address, outputAmount);
    hubPoolClient.mapTokenInfo(EvmAddress.from(originToken.address), await l1Token.symbol());
    hubPoolClient.mapTokenInfo(EvmAddress.from(destinationToken.address), await l1Token.symbol());
    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);
    await configStore.updateTokenConfig(l1Token.address, defaultTokenConfig);
    await originToken.connect(relayer).approve(spokePoolDestination.address, toBNWei(100000));
    await destinationToken.connect(relayer).approve(spokePoolDestination.address, toBNWei(100000));
    await updateAllClients();
    const currentTime = await getLastBlockTime(spokePoolOrigin.provider);
    await Promise.all([spokePoolOrigin, spokePoolDestination].map((spokePool) => spokePool.setCurrentTime(currentTime)));
  });

  it("reserves destination balance sequentially across competing deposits", async function () {
    const aliceDeposit = await depositV3(
      spokePoolOrigin,
      destinationChainId,
      depositor,
      originToken.address,
      inputAmount,
      destinationToken.address,
      outputAmount
    );
    const bobDeposit = await depositV3(
      spokePoolOrigin,
      destinationChainId,
      depositor,
      originToken.address,
      inputAmount,
      destinationToken.address,
      outputAmount
    );

    await updateAllClients();
    const txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
    expect((await txnReceipts[destinationChainId]).length).to.equal(1);

    await Promise.all([spokePoolOriginClient.update(), spokePoolDestinationClient.update()]);
    const fills = spokePoolDestinationClient.getFillsForOriginChain(originChainId);
    expect(fills).to.have.lengthOf(1);
    expect(fills[0].depositId).to.equal(aliceDeposit.depositId);
    expect(fills.some((fill) => fill.depositId.eq(bobDeposit.depositId))).to.equal(false);
  });
});
