import { constants as sdkConsts, utils as sdkUtils } from "@across-protocol/sdk";
import hre from "hardhat";
import {
  ConfigStoreClient,
  HubPoolClient,
  MultiCallerClient,
  SpokePoolClient,
  EVMSpokePoolClient,
  AcrossApiClient,
} from "../src/clients";
import { Relayer } from "../src/relayer/Relayer";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import { Deposit, RelayData } from "../src/interfaces";
import { bnZero, toAddressType, EvmAddress, SvmAddress, Address, fixedPointAdjustment } from "../src/utils";
import { originChainId, destinationChainId, repaymentChainId, defaultMinDepositConfirmations } from "./constants";
import {
  MockConfigStoreClient,
  MockInventoryClient,
  MockProfitClient,
  MockedMultiCallerClient,
  SimpleMockHubPoolClient,
  SimpleMockTokenClient,
} from "./mocks";
import {
  BigNumber,
  Contract,
  SignerWithAddress,
  createSpyLogger,
  deployAndConfigureHubPool,
  deployConfigStore,
  deployMulticall3,
  deploySpokePoolWithToken,
  depositV3,
  enableRoutesOnHubPool,
  expect,
  setupTokensForWallet,
  sinon,
  toBN,
  toBNWei,
  winston,
} from "./utils";

const { EMPTY_MESSAGE } = sdkConsts;

interface ProfitScenario {
  nativeGasCost?: BigNumber;
  gasPrice?: BigNumber;
  auxiliaryNativeCost?: BigNumber;
}

describe("Relayer: Auxiliary Native Cost", function () {
  const priceOne = toBNWei("1");

  let hubPool: Contract;
  let spokePoolOrigin: Contract;
  let spokePoolDestination: Contract;
  let l1Token: Contract;
  let erc20Origin: Contract;
  let erc20Destination: Contract;

  let hubPoolClient: HubPoolClient;
  let spokePoolClientOrigin: SpokePoolClient;
  let spokePoolClientDestination: SpokePoolClient;
  let configStoreClient: ConfigStoreClient;
  let tokenClient: SimpleMockTokenClient;
  let profitClient: MockProfitClient;
  let multiCallerClient: MockedMultiCallerClient;
  let tryMulticallClient: MockedMultiCallerClient;
  let inventoryClient: MockInventoryClient;

  let relayerInstance: Relayer;

  let owner: SignerWithAddress;
  let depositor: SignerWithAddress;
  let relayerSigner: SignerWithAddress;

  let spy: sinon.SinonSpy;
  let spyLogger: winston.Logger;

  const updateAllClients = async (): Promise<void> => {
    await configStoreClient.update();
    await hubPoolClient.update();
    await tokenClient.update();
    await spokePoolClientOrigin.update();
    await spokePoolClientDestination.update();
  };

  const configureProfitScenario = ({
    nativeGasCost = toBNWei("0.1"),
    gasPrice = bnZero.add(1),
    auxiliaryNativeCost = bnZero,
  }: ProfitScenario): void => {
    const tokenGasCost = nativeGasCost.mul(gasPrice);
    profitClient.setGasCost(destinationChainId, {
      nativeGasCost,
      tokenGasCost,
      gasPrice,
    });
    profitClient.setAuxiliaryNativeTokenCost(destinationChainId, auxiliaryNativeCost);
  };

  const computeFillMetrics = async (deposit: Deposit) => {
    return profitClient.calculateFillProfitability(deposit, bnZero, bnZero);
  };

  beforeEach(async function () {
    [owner, depositor, relayerSigner] = await hre.ethers.getSigners();

    ({ spokePool: spokePoolOrigin, erc20: erc20Origin } = await deploySpokePoolWithToken(originChainId));

    ({ spokePool: spokePoolDestination, erc20: erc20Destination } = await deploySpokePoolWithToken(destinationChainId));

    ({ hubPool, l1Token_1: l1Token } = await deployAndConfigureHubPool(owner, [
      { l2ChainId: destinationChainId, spokePool: spokePoolDestination },
      { l2ChainId: originChainId, spokePool: spokePoolOrigin },
      { l2ChainId: repaymentChainId, spokePool: spokePoolOrigin },
      { l2ChainId: 1, spokePool: spokePoolOrigin },
    ]));

    for (const signer of [depositor, relayerSigner]) {
      await deployMulticall3(signer);
    }

    ({ spy, spyLogger } = createSpyLogger());

    const { configStore } = await deployConfigStore(owner, [l1Token]);
    configStoreClient = new MockConfigStoreClient(
      spyLogger,
      configStore,
      { from: 0 },
      undefined,
      [originChainId, destinationChainId],
      originChainId,
      false
    ) as unknown as ConfigStoreClient;
    await configStoreClient.update();

    hubPoolClient = new SimpleMockHubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    multiCallerClient = new MockedMultiCallerClient(spyLogger);
    tryMulticallClient = new MockedMultiCallerClient(spyLogger);

    spokePoolClientOrigin = new EVMSpokePoolClient(
      spyLogger,
      spokePoolOrigin.connect(relayerSigner),
      hubPoolClient,
      originChainId,
      (await spokePoolOrigin.deploymentTransaction())?.blockNumber ?? 0
    );

    spokePoolClientDestination = new EVMSpokePoolClient(
      spyLogger,
      spokePoolDestination.connect(relayerSigner),
      hubPoolClient,
      destinationChainId,
      (await spokePoolDestination.deploymentTransaction())?.blockNumber ?? 0
    );

    await Promise.all([spokePoolClientOrigin.update(), spokePoolClientDestination.update()]);

    const relayerAddressEVM = EvmAddress.from(relayerSigner.address);
    const relayerAddressSVM = SvmAddress.from("11111111111111111111111111111111");

    const spokePoolClients = {
      [originChainId]: spokePoolClientOrigin,
      [destinationChainId]: spokePoolClientDestination,
    };

    tokenClient = new SimpleMockTokenClient(
      spyLogger,
      relayerAddressEVM,
      relayerAddressSVM,
      spokePoolClients,
      hubPoolClient
    );
    tokenClient.setRemoteTokens([l1Token, erc20Origin, erc20Destination]);

    const enabledChainIds = Object.values(spokePoolClients).map(({ chainId }) => chainId);

    profitClient = new MockProfitClient(
      spyLogger,
      hubPoolClient,
      spokePoolClients,
      enabledChainIds,
      relayerAddressEVM,
      relayerAddressSVM,
      bnZero
    );
    await profitClient.initToken(l1Token);
    profitClient.setGasPadding(toBNWei("1"));
    profitClient.setGasMultiplier(toBNWei("1"));

    inventoryClient = new MockInventoryClient(null, null, null, null, null, hubPoolClient);
    inventoryClient.setTokenMapping({
      [l1Token.address]: {
        [originChainId]: erc20Origin.address,
        [destinationChainId]: erc20Destination.address,
      },
    });

    relayerInstance = new Relayer(
      relayerSigner.address,
      spyLogger,
      {
        spokePoolClients,
        hubPoolClient,
        configStoreClient,
        tokenClient,
        profitClient,
        multiCallerClient,
        inventoryClient,
        acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, enabledChainIds),
        tryMulticallClient,
      },
      {
        relayerTokens: [],
        minDepositConfirmations: defaultMinDepositConfirmations,
        sendingRelaysEnabled: true,
        sendingMessageRelaysEnabled: { [destinationChainId]: true },
        tryMulticallChains: [],
        loggingInterval: -1,
      } as unknown as RelayerConfig
    );

    const nativeToken = profitClient.resolveNativeToken(destinationChainId);
    const gasToken = profitClient.resolveGasToken(destinationChainId);
    const l1TokenSymbol = await l1Token.symbol();

    profitClient.setTokenPrice(nativeToken.symbol, priceOne);
    profitClient.setTokenPrice(gasToken.symbol, priceOne);
    profitClient.setTokenPrice(l1TokenSymbol, priceOne);

    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token, destinationToken: erc20Origin },
      { destinationChainId: destinationChainId, l1Token, destinationToken: erc20Destination },
    ]);

    await setupTokensForWallet(spokePoolOrigin, owner, [l1Token], undefined, 1000);
    await setupTokensForWallet(spokePoolOrigin, depositor, [erc20Origin], undefined, 1000);
    await setupTokensForWallet(spokePoolDestination, depositor, [erc20Destination], undefined, 1000);
    await setupTokensForWallet(spokePoolOrigin, relayerSigner, [erc20Origin, erc20Destination], undefined, 1000);
    await setupTokensForWallet(spokePoolDestination, relayerSigner, [erc20Origin, erc20Destination], undefined, 1000);

    (hubPoolClient as SimpleMockHubPoolClient).mapTokenInfo(EvmAddress.from(erc20Origin.address), l1TokenSymbol);
    (hubPoolClient as SimpleMockHubPoolClient).mapTokenInfo(EvmAddress.from(erc20Destination.address), l1TokenSymbol);

    await l1Token.approve(hubPool.address, toBNWei("1000"));
    await hubPool.addLiquidity(l1Token.address, toBNWei("1000"));

    await updateAllClients();
  });

  afterEach(function () {
    multiCallerClient.clearTransactionQueue();
  });

  const makeRelayDeposit = async (
    overrides: Partial<Pick<RelayData, "inputAmount" | "outputAmount" | "message">> = {}
  ): Promise<Deposit> => {
    const inputAmount = overrides.inputAmount ?? toBNWei("110");
    const outputAmount = overrides.outputAmount ?? toBNWei("100");
    const message = overrides.message ?? EMPTY_MESSAGE;

    const deposit = await depositV3(
      spokePoolOrigin,
      destinationChainId,
      depositor,
      erc20Origin.address,
      inputAmount,
      erc20Destination.address,
      outputAmount,
      { message }
    );

    await updateAllClients();
    return deposit;
  };

  it("combines gas and auxiliary native costs in profitability", async function () {
    configureProfitScenario({ auxiliaryNativeCost: toBNWei("1.5") });

    const deposit = await makeRelayDeposit();
    const fill = await computeFillMetrics(deposit);

    expect(fill.auxiliaryNativeTokenCost.eq(toBNWei("1.5"))).to.be.true;
    expect(fill.auxiliaryNativeTokenCostUsd.eq(fill.auxiliaryNativeTokenCost)).to.be.true;
    expect(fill.nativeTokenFillCostUsd.eq(fill.gasCostUsd.add(fill.auxiliaryNativeTokenCostUsd))).to.be.true;
  });

  it("fills deposits when auxiliary cost stays within margin", async function () {
    configureProfitScenario({ auxiliaryNativeCost: toBNWei("2") });

    const deposit = await makeRelayDeposit();
    const receiptsByChain = await relayerInstance.checkForUnfilledDepositsAndFill();
    const receipts = await receiptsByChain[destinationChainId];

    expect(receipts.length).to.equal(1);

    const fill = await computeFillMetrics(deposit);
    expect(fill.profitable).to.be.true;
    expect(fill.netRelayerFeeUsd.gt(bnZero)).to.be.true;
  });

  it("skips filling when auxiliary cost exceeds relayer margin", async function () {
    configureProfitScenario({ auxiliaryNativeCost: toBNWei("20") });

    const deposit = await makeRelayDeposit();
    const fill = await computeFillMetrics(deposit);
    expect(fill.profitable).to.be.false;

    const receiptsByChain = await relayerInstance.checkForUnfilledDepositsAndFill();
    const receipts = await receiptsByChain[destinationChainId];
    expect(receipts.length).to.equal(0);
    expect(
      spy
        .getCalls()
        .find(({ lastArg }) => typeof lastArg?.message === "string" && lastArg.message.includes("Skipping fill"))
    ).to.not.be.undefined;
  });
});
