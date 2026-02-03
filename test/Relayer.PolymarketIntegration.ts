import hre from "hardhat";
import { clients } from "@across-protocol/sdk";
import { deploy as deployMulticall3 } from "@across-protocol/sdk/dist/cjs/utils/Multicall";
import {
  AcrossApiClient,
  ConfigStoreClient,
  EVMSpokePoolClient,
  HubPoolClient,
  MultiCallerClient,
  SpokePoolClient,
} from "../src/clients";
import { Relayer } from "../src/relayer/Relayer";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import { bnUint256Max, EvmAddress, SvmAddress } from "../src/utils";
import { PolymarketClient } from "../src/clients/PolymarketClient";
import { defaultMinDepositConfirmations, CONFIG_STORE_VERSION, amountToLp, defaultTokenConfig } from "./constants";
import {
  MockConfigStoreClient,
  MockInventoryClient,
  MockProfitClient,
  SimpleMockHubPoolClient,
  SimpleMockTokenClient,
} from "./mocks";
import { MockedMultiCallerClient } from "./mocks/MockMultiCallerClient";
import {
  BigNumber,
  Contract,
  SignerWithAddress,
  createSpyLogger,
  getLastBlockTime,
  deployAndConfigureHubPool,
  deployConfigStore,
  deploySpokePoolWithToken,
  depositV3,
  enableRoutesOnHubPool,
  ethers,
  expect,
  setupTokensForWallet,
  sinon,
  winston,
} from "./utils";

const POLYGON_CHAIN_ID = 137;
const ORIGIN_CHAIN_ID = 1;

const encodePolymarketIntent = (params: {
  recipient: string;
  solver: string;
  outcomeToken: string;
  tokenId: number;
  outcomeAmount: BigNumber;
  limitPrice: BigNumber;
  clientOrderId: string;
}): string => {
  return ethers.utils.defaultAbiCoder.encode(
    [
      "tuple(uint8 version,address recipient,address solver,address outcomeToken,uint256 tokenId,uint256 outcomeAmount,uint256 limitPrice,bytes32 clientOrderId)",
    ],
    [
      {
        version: 1,
        recipient: params.recipient,
        solver: params.solver,
        outcomeToken: params.outcomeToken,
        tokenId: params.tokenId,
        outcomeAmount: params.outcomeAmount,
        limitPrice: params.limitPrice,
        clientOrderId: params.clientOrderId,
      },
    ]
  );
};

async function maybeForkPolygon(): Promise<void> {
  const forkUrl = process.env.POLYGON_FORK_URL;
  if (!forkUrl) return;
  await hre.network.provider.request({
    method: "hardhat_reset",
    params: [{ forking: { jsonRpcUrl: forkUrl } }],
  });
}

describe("Relayer: Polymarket integration (Polygon fork optional)", function () {
  let owner: SignerWithAddress;
  let depositor: SignerWithAddress;
  let relayer: SignerWithAddress;
  let user: SignerWithAddress;

  let spokePoolOrigin: Contract;
  let spokePoolDest: Contract;
  let erc20Origin: Contract;
  let hubPool: Contract;
  let configStore: Contract;
  let l1Token: Contract;
  let usdc: Contract;
  let outcome: Contract;
  let handler: Contract;

  let spokePoolClientOrigin: SpokePoolClient;
  let spokePoolClientDest: clients.EVMSpokePoolClient;
  let spokePoolClients: { [chainId: number]: SpokePoolClient };
  let configStoreClient: ConfigStoreClient;
  let hubPoolClient: HubPoolClient;
  let tokenClient: SimpleMockTokenClient;
  let profitClient: MockProfitClient;
  let inventoryClient: MockInventoryClient;
  let multiCallerClient: MultiCallerClient;
  let tryMulticallClient: MultiCallerClient;
  let relayerInstance: Relayer;
  let placeFokOrderStub: sinon.SinonStub;

  let spy: sinon.SinonSpy;
  let spyLogger: winston.Logger;

  let originDeploymentBlock: number;
  let destDeploymentBlock: number;

  before(async function () {
    await maybeForkPolygon();
  });

  beforeEach(async function () {
    [owner, depositor, relayer, user] = await ethers.getSigners();

    ({ spy, spyLogger } = createSpyLogger());

    await deployMulticall3(owner);
    await deployMulticall3(relayer);

    ({
      spokePool: spokePoolOrigin,
      erc20: erc20Origin,
      deploymentBlock: originDeploymentBlock,
    } = await deploySpokePoolWithToken(ORIGIN_CHAIN_ID));
    ({
      spokePool: spokePoolDest,
      deploymentBlock: destDeploymentBlock,
    } = await deploySpokePoolWithToken(POLYGON_CHAIN_ID));
    const currentTime = await getLastBlockTime(spokePoolOrigin.provider);
    await Promise.all([spokePoolOrigin, spokePoolDest].map((spokePool) => spokePool.setCurrentTime(currentTime)));

    ({ hubPool, l1Token_1: l1Token } = await deployAndConfigureHubPool(owner, [
      { l2ChainId: ORIGIN_CHAIN_ID, spokePool: spokePoolOrigin },
      { l2ChainId: POLYGON_CHAIN_ID, spokePool: spokePoolDest },
    ]));

    ({ configStore } = await deployConfigStore(owner, [l1Token]));

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: ORIGIN_CHAIN_ID, l1Token, destinationToken: erc20Origin },
      { destinationChainId: POLYGON_CHAIN_ID, l1Token, destinationToken: usdc },
    ]);

    await configStore.updateTokenConfig(l1Token.address, defaultTokenConfig);

    configStoreClient = new MockConfigStoreClient(
      spyLogger,
      configStore,
      { from: 0 },
      CONFIG_STORE_VERSION,
      [ORIGIN_CHAIN_ID, POLYGON_CHAIN_ID],
      ORIGIN_CHAIN_ID,
      false
    ) as unknown as ConfigStoreClient;
    await configStoreClient.update();

    hubPoolClient = new SimpleMockHubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();
    hubPoolClient.mapTokenInfo(EvmAddress.from(erc20Origin.address), await l1Token.symbol(), 18);
    hubPoolClient.mapTokenInfo(EvmAddress.from(usdc.address), await l1Token.symbol(), 6);

    multiCallerClient = new MockedMultiCallerClient(spyLogger);
    tryMulticallClient = new MockedMultiCallerClient(spyLogger);

    spokePoolClientOrigin = new EVMSpokePoolClient(
      spyLogger,
      spokePoolOrigin.connect(relayer),
      hubPoolClient,
      ORIGIN_CHAIN_ID,
      originDeploymentBlock
    );
    spokePoolClientDest = new EVMSpokePoolClient(
      spyLogger,
      spokePoolDest.connect(relayer),
      hubPoolClient,
      POLYGON_CHAIN_ID,
      destDeploymentBlock
    );
    spokePoolClients = {
      [ORIGIN_CHAIN_ID]: spokePoolClientOrigin,
      [POLYGON_CHAIN_ID]: spokePoolClientDest,
    };
    await Promise.all(Object.values(spokePoolClients).map((client) => client.update()));

    const relayerAddressEvm = EvmAddress.from(relayer.address);
    const relayerAddressSvm = SvmAddress.from("11111111111111111111111111111111");
    tokenClient = new SimpleMockTokenClient(
      spyLogger,
      relayerAddressEvm,
      relayerAddressSvm,
      spokePoolClients,
      hubPoolClient
    );
    tokenClient.setRemoteTokens([l1Token, erc20Origin, usdc]);

    profitClient = new MockProfitClient(
      spyLogger,
      hubPoolClient,
      spokePoolClients,
      [],
      relayerAddressEvm,
      relayerAddressSvm
    );
    sinon.stub(profitClient, "getTotalGasCost").resolves({
      nativeGasCost: BigNumber.from(500_000),
      tokenGasCost: BigNumber.from(500_000),
      gasPrice: BigNumber.from(1),
    });
    await profitClient.initToken(l1Token);

    inventoryClient = new MockInventoryClient(null, null, null, null, null, hubPoolClient);
    inventoryClient.setTokenMapping({
      [l1Token.address]: {
        [ORIGIN_CHAIN_ID]: erc20Origin.address,
        [POLYGON_CHAIN_ID]: usdc.address,
      },
    });

    const Handler = await ethers.getContractFactory("PolymarketHandler");
    handler = await Handler.deploy(spokePoolDest.address, usdc.address, owner.address);

    const MockERC1155 = await ethers.getContractFactory("MockERC1155");
    outcome = await MockERC1155.deploy();

    await handler.connect(owner).setSolverAllowed(relayer.address, true);
    await outcome.connect(relayer).setApprovalForAll(handler.address, true);

    const tokenId = 1;
    const outcomeAmount = ethers.utils.parseUnits("10", 6);
    await outcome.mint(relayer.address, tokenId, outcomeAmount);

    const inputAmount = ethers.utils.parseUnits("1000", 18);
    const outputAmount = ethers.utils.parseUnits("20", 6);
    await setupTokensForWallet(spokePoolOrigin, depositor, [erc20Origin], undefined, 2);
    await usdc.mint(relayer.address, outputAmount);
    await usdc.connect(relayer).approve(spokePoolDest.address, outputAmount);
    expect(await usdc.balanceOf(relayer.address)).to.equal(outputAmount);
    expect(await usdc.allowance(relayer.address, spokePoolDest.address)).to.equal(outputAmount);

    await setupTokensForWallet(spokePoolOrigin, owner, [l1Token], undefined, 100);
    await l1Token.connect(owner).approve(hubPool.address, amountToLp);
    await hubPool.connect(owner).addLiquidity(l1Token.address, amountToLp);

    await Promise.all([configStoreClient.update(), hubPoolClient.update(), tokenClient.update()]);

    const polymarketClient = {
      placeFokOrder: sinon.stub().resolves({ orderId: "pm-1", status: "matched" }),
    } as unknown as PolymarketClient;
    placeFokOrderStub = (polymarketClient as unknown as { placeFokOrder: sinon.SinonStub }).placeFokOrder;

    // Build and submit polymarket intent deposit.
    const limitPrice = ethers.utils.parseUnits("0.6", 6);
    const message = encodePolymarketIntent({
      recipient: user.address,
      solver: relayer.address,
      outcomeToken: outcome.address,
      tokenId,
      outcomeAmount,
      limitPrice,
      clientOrderId: ethers.utils.formatBytes32String("pm-intent-1"),
    });

    await depositV3(spokePoolOrigin, POLYGON_CHAIN_ID, depositor, erc20Origin.address, inputAmount, usdc.address, outputAmount, {
      recipient: handler.address,
      message,
    });

    await spokePoolClientOrigin.update();
    await spokePoolClientDest.update();

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
        inventoryClient,
        acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, [ORIGIN_CHAIN_ID, POLYGON_CHAIN_ID]),
        tryMulticallClient,
        polymarketClient,
      },
      {
        relayerTokens: [],
        relayerDestinationTokens: {},
        minDepositConfirmations: {
          [ORIGIN_CHAIN_ID]: [{ usdThreshold: bnUint256Max, minConfirmations: 0 }],
          [POLYGON_CHAIN_ID]: [{ usdThreshold: bnUint256Max, minConfirmations: 0 }],
        },
        sendingRelaysEnabled: true,
        sendingMessageRelaysEnabled: { [POLYGON_CHAIN_ID]: true },
        tryMulticallChains: [],
        loggingInterval: -1,
        polymarketEnabled: true,
        polymarketHandlerAddresses: {
          [POLYGON_CHAIN_ID]: EvmAddress.from(handler.address),
        },
      } as unknown as RelayerConfig
    );
  });

  it("fills the deposit after a matched CLOB order and delivers outcome tokens", async function () {
    const beforeOutcome = await outcome.balanceOf(user.address, 1);
    const beforeUsdcRelayer = await usdc.balanceOf(relayer.address);

    const receipts = await relayerInstance.checkForUnfilledDepositsAndFill();
    await receipts[POLYGON_CHAIN_ID];

    const afterOutcome = await outcome.balanceOf(user.address, 1);
    const afterUsdcRelayer = await usdc.balanceOf(relayer.address);

    sinon.assert.calledOnce(placeFokOrderStub);
    const [intentArg] = placeFokOrderStub.firstCall.args;
    expect(intentArg.tokenId.toString()).to.equal("1");
    expect(intentArg.limitPrice.toString()).to.equal(ethers.utils.parseUnits("0.6", 6).toString());
    expect(afterOutcome.sub(beforeOutcome)).to.equal(ethers.utils.parseUnits("10", 6));
    expect(afterUsdcRelayer).to.equal(beforeUsdcRelayer);

    const events = await handler.queryFilter(handler.filters.PolymarketFill());
    expect(events.length).to.equal(1);
    expect(events[0].args?.recipient).to.equal(user.address);
  });
});
