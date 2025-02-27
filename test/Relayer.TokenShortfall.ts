import {
  AcrossApiClient,
  ConfigStoreClient,
  HubPoolClient,
  MultiCallerClient,
  SpokePoolClient,
  TokenClient,
} from "../src/clients";
import { CONFIG_STORE_VERSION } from "../src/common";
import { Relayer } from "../src/relayer/Relayer";
import { RelayerConfig } from "../src/relayer/RelayerConfig"; // Tested
import {
  CHAIN_ID_TEST_LIST,
  amountToLp,
  defaultMinDepositConfirmations,
  defaultTokenConfig,
  originChainId,
  destinationChainId,
  repaymentChainId,
} from "./constants";
import { MockInventoryClient, MockProfitClient, SimpleMockHubPoolClient } from "./mocks";
import { MockCrossChainTransferClient } from "./mocks/MockCrossChainTransferClient";
import { MockedMultiCallerClient } from "./mocks/MockMultiCallerClient";
import {
  BigNumber,
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
  spyLogIncludes,
  setupTokensForWallet,
  sinon,
  toBN,
  toBNWei,
  winston,
} from "./utils";

describe("Relayer: Token balance shortfall", async function () {
  const noSlowRelays = false; // Don't send slow fills.
  const bn10 = toBN(10);

  let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
  let hubPool: Contract, configStore: Contract, l1Token: Contract;
  let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
  let spy: sinon.SinonSpy, spyLogger: winston.Logger;

  let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
  let configStoreClient: ConfigStoreClient, hubPoolClient: HubPoolClient, tokenClient: TokenClient;
  let relayerInstance: Relayer;
  let multiCallerClient: MultiCallerClient, tryMulticallClient: MultiCallerClient, profitClient: MockProfitClient;
  let spokePool1DeploymentBlock: number, spokePool2DeploymentBlock: number;

  let inputToken: string, outputToken: string;
  let inputTokenDecimals: BigNumber;
  let inputAmount: BigNumber, outputAmount: BigNumber;

  const updateAllClients = async () => {
    await configStoreClient.update();
    await hubPoolClient.update();
    await tokenClient.update();
    await spokePoolClient_1.update();
    await spokePoolClient_2.update();
    tokenClient.clearTokenShortfall();
  };

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
    profitClient = new MockProfitClient(spyLogger, hubPoolClient, spokePoolClients, []);
    for (const erc20 of [l1Token]) {
      await profitClient.initToken(erc20);
    }

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
        inventoryClient: new MockInventoryClient(
          null,
          null,
          null,
          null,
          null,
          hubPoolClient,
          null,
          null,
          new MockCrossChainTransferClient()
        ),
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

    // Seed Owner and depositor wallets but dont seed relayer to test how the relayer handles being out of funds.
    await setupTokensForWallet(spokePool_1, owner, [l1Token], null, 100); // Seed owner to LP.
    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], null, 10);
    await setupTokensForWallet(spokePool_2, depositor, [erc20_2], null, 10);

    // Execute large approval so we dont need to worry about this.
    await erc20_1.connect(relayer).approve(spokePool_1.address, toBNWei(100000));
    await erc20_2.connect(relayer).approve(spokePool_2.address, toBNWei(100000));

    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);
    await configStore.updateTokenConfig(l1Token.address, defaultTokenConfig);

    await updateAllClients();

    inputToken = erc20_1.address;
    outputToken = erc20_2.address;
    (hubPoolClient as SimpleMockHubPoolClient).mapTokenInfo(erc20_1.address, await l1Token.symbol());
    (hubPoolClient as SimpleMockHubPoolClient).mapTokenInfo(erc20_2.address, await l1Token.symbol());
    inputTokenDecimals = await erc20_1.decimals();

    // Standard deposit outputAmount is 100 tokens. Work backwards to inputAmount to simplify the shortfall math.
    outputAmount = toBN(100).mul(bn10.pow(inputTokenDecimals));
    inputAmount = outputAmount.mul(101).div(100);

    const currentTime = await getLastBlockTime(spokePool_1.provider);
    await Promise.all([spokePool_1, spokePool_2].map((spokePool) => spokePool.setCurrentTime(currentTime)));
  });

  it("Produces expected logs based on insufficient single token balance", async function () {
    await depositV3(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount);
    await depositV3(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount);

    // Seed the relayer with 50 tokens. This is insufficient to fill the relay and should produce the expected log.
    await erc20_2.mint(relayer.address, toBN(50).mul(bn10.pow(inputTokenDecimals)));

    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill(noSlowRelays);

    expect(lastSpyLogIncludes(spy, "Insufficient balance to fill all deposits")).to.be.true;
    expect(lastSpyLogIncludes(spy, "Shortfall on Hardhat2:")).to.be.true;
    expect(lastSpyLogIncludes(spy, `${await l1Token.symbol()} cumulative shortfall of 150.00`)).to.be.true;
    expect(lastSpyLogIncludes(spy, "blocking deposits: 0,1")).to.be.true;

    // Submitting another relay should increment the shortfall and log accordingly. Total shortfall of 250 now.
    await depositV3(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount);
    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill(noSlowRelays);
    expect(lastSpyLogIncludes(spy, `${await l1Token.symbol()} cumulative shortfall of 250.00`)).to.be.true;
    expect(lastSpyLogIncludes(spy, "blocking deposits: 0,1,2")).to.be.true;

    // Mint more tokens to the relayer to fill the shortfall. Mint enough to just cover the most recent relay. The
    // Other relays should not be filled.
    await erc20_2.mint(relayer.address, toBN(60).mul(bn10.pow(inputTokenDecimals)));
    await updateAllClients();
    const txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill(noSlowRelays);
    const txnHashes = await txnReceipts[destinationChainId];
    expect(txnHashes.length).to.equal(1);
    const txn = await spokePool_1.provider.getTransaction(txnHashes[0]);
    const { name: method, args } = spokePool_1.interface.parseTransaction(txn);
    expect(method).to.equal("fillRelay");
    expect(args[0].depositId).to.equal(0); // depositId 0

    expect(spyLogIncludes(spy, -5, `${await l1Token.symbol()} cumulative shortfall of 190.00`)).to.be.true;
    expect(spyLogIncludes(spy, -5, "blocking deposits: 1,2")).to.be.true;
  });

  it("Produces expected logs based on insufficient multiple token balance", async function () {
    // Deposit 100 tokens to be relayed of each token type.
    await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      inputAmount,
      erc20_2.address,
      outputAmount
    );
    await depositV3(spokePool_2, originChainId, depositor, erc20_2.address, inputAmount, erc20_1.address, outputAmount);

    await updateAllClients();

    await relayerInstance.checkForUnfilledDepositsAndFill(noSlowRelays);

    expect(lastSpyLogIncludes(spy, "Insufficient balance to fill all deposits")).to.be.true;
    expect(lastSpyLogIncludes(spy, "Shortfall on Hardhat1:")).to.be.true; // both networks should show shortfalls.
    expect(lastSpyLogIncludes(spy, "Shortfall on Hardhat2:")).to.be.true;
    expect(lastSpyLogIncludes(spy, `${await l1Token.symbol()} cumulative shortfall of 100.00`)).to.be.true;
    expect(lastSpyLogIncludes(spy, "blocking deposits: 0")).to.be.true;
  });
});
