import { EVMSpokePoolClient } from "../../src/clients";
import { AdapterManager } from "../../src/clients/bridges";
import { CONTRACT_ADDRESSES } from "../../src/common";
import {
  bnToHex,
  getL2TokenAddresses,
  toBNWei,
  CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
  bnZero,
  getCctpDomainForChainId,
  EvmAddress,
  ZERO_ADDRESS,
  toAddressType,
} from "../../src/utils";
import { MockConfigStoreClient, MockHubPoolClient } from "../mocks";
import {
  BigNumber,
  FakeContract,
  SignerWithAddress,
  createSpyLogger,
  deployConfigStore,
  ethers,
  expect,
  hubPoolFixture,
  smock,
  toBN,
  winston,
} from "../utils";

let hubPoolClient: MockHubPoolClient;
const mockSpokePoolClients: {
  [chainId: number]: EVMSpokePoolClient;
} = {};
let logger;
let relayer: SignerWithAddress, owner: SignerWithAddress, spyLogger: winston.Logger, amountToSend: BigNumber;
let adapterManager: AdapterManager;

// Atomic depositor
let l1AtomicDepositor: FakeContract;

// Optimism contracts
let l1OptimismBridge: FakeContract, l1OptimismDaiBridge: FakeContract, l1OptimismSnxBridge: FakeContract;

// Polygon contracts
let l1PolygonRootChainManager: FakeContract;

// Arbitrum contracts
let l1ArbitrumBridge: FakeContract;

// ZkSync contracts
let l1BridgeHub: FakeContract;

// Base contracts
let l1BaseBridge: FakeContract;

// CCTP L1 Contracts
let l1CCTPTokenMessager: FakeContract;

const enabledChainIds = [1, 10, 137, 288, 42161, 324, 8453];

const mainnetTokens = {
  usdc: TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET],
  weth: TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET],
  dai: TOKEN_SYMBOLS_MAP.DAI.addresses[CHAIN_IDs.MAINNET],
  wbtc: TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.MAINNET],
  snx: TOKEN_SYMBOLS_MAP.SNX.addresses[CHAIN_IDs.MAINNET],
  bal: TOKEN_SYMBOLS_MAP.BAL.addresses[CHAIN_IDs.MAINNET],
} as const;

describe("AdapterManager: Send tokens cross-chain", async function () {
  beforeEach(async function () {
    [relayer, owner] = await ethers.getSigners();
    ({ spyLogger } = createSpyLogger());
    logger = spyLogger;

    const { configStore } = await deployConfigStore(owner, []);
    const configStoreClient = new MockConfigStoreClient(spyLogger, configStore);

    await configStoreClient.update();

    const { hubPool } = await hubPoolFixture();
    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);
    await seedMocks();
    adapterManager = new AdapterManager(spyLogger, mockSpokePoolClients, hubPoolClient, [relayer.address]);

    await constructChainSpecificFakes();

    amountToSend = toBN(42069);
  });

  it("Errors on misparameterization", async function () {
    // Throws error if the chainID is wrong
    // (note I could not mocha and chai to assert on throws for async methods).
    let thrown1 = false;
    try {
      await adapterManager.sendTokenCrossChain(
        toAddressType(relayer.address, CHAIN_IDs.MAINNET),
        42069,
        toAddressType(mainnetTokens.usdc, CHAIN_IDs.MAINNET),
        amountToSend
      );
    } catch (error) {
      thrown1 = true;
    }
    expect(thrown1).to.be.equal(true);
  });
  it("Correctly sends tokens to chain: Optimism", async function () {
    const chainId = CHAIN_IDs.OPTIMISM;
    const l2Gas = 200000; // This is hardcoded in all OVM Bridges

    //  ERC20 tokens:
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.bal, CHAIN_IDs.MAINNET),
      amountToSend
    );
    expect(l1OptimismBridge.depositERC20).to.have.been.calledWith(
      mainnetTokens.bal, // l1 token
      getL2TokenAddresses(mainnetTokens.bal)[chainId], // l2 token
      amountToSend, // amount
      l2Gas, // l2Gas
      "0x" // data
    );

    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.usdc, CHAIN_IDs.MAINNET),
      amountToSend,
      undefined,
      toAddressType(TOKEN_SYMBOLS_MAP["USDC.e"].addresses[chainId], CHAIN_IDs.MAINNET)
    );
    expect(l1OptimismBridge.depositERC20).to.have.been.calledWith(
      mainnetTokens.usdc, // l1 token
      TOKEN_SYMBOLS_MAP["USDC.e"].addresses[chainId], // l2 token
      amountToSend, // amount
      l2Gas, // l2Gas
      "0x" // data
    );

    //  CCTP tokens:
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.usdc, CHAIN_IDs.MAINNET),
      amountToSend,
      undefined,
      toAddressType(TOKEN_SYMBOLS_MAP.USDC.addresses[chainId], CHAIN_IDs.MAINNET)
    );
    expect(l1CCTPTokenMessager.depositForBurn).to.have.been.calledWith(
      amountToSend, // amount
      getCctpDomainForChainId(chainId), // destinationDomain
      EvmAddress.from(relayer.address).toBytes32(), // recipient
      mainnetTokens.usdc // token
    );

    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.snx, CHAIN_IDs.MAINNET),
      amountToSend
    );
    expect(l1OptimismSnxBridge.depositTo).to.have.been.calledWith(
      relayer.address, // to
      amountToSend // amount
    );

    // Non- ERC20 tokens:
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.dai, CHAIN_IDs.MAINNET),
      amountToSend
    );
    // Note the target is the L1 dai optimism bridge.
    expect(l1OptimismDaiBridge.depositERC20).to.have.been.calledWith(
      mainnetTokens.dai, // l1 token
      getL2TokenAddresses(mainnetTokens.dai)[chainId], // l2 token
      amountToSend, // amount
      l2Gas, // l2Gas
      "0x" // data
    );

    // Weth is not directly sendable over the canonical bridge. Rather, we should see a call against the atomic depositor.
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.weth, CHAIN_IDs.MAINNET),
      amountToSend
    );
    const bridgeCalldata = l1OptimismBridge.interface.encodeFunctionData("depositETHTo", [
      relayer.address,
      l2Gas,
      "0x",
    ]);
    expect(l1AtomicDepositor.bridgeWeth).to.have.been.calledWith(
      chainId, // chainId
      amountToSend, // amount
      amountToSend,
      bnZero,
      bridgeCalldata
    );
  });

  it("Correctly sends tokens to chain: Polygon", async function () {
    const chainId = CHAIN_IDs.POLYGON;

    //  CCTP tokens:
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.usdc, CHAIN_IDs.MAINNET),
      amountToSend,
      false,
      toAddressType(TOKEN_SYMBOLS_MAP.USDC.addresses[chainId], CHAIN_IDs.MAINNET)
    );
    expect(l1CCTPTokenMessager.depositForBurn).to.have.been.calledWith(
      amountToSend, // amount
      getCctpDomainForChainId(chainId), // destinationDomain
      EvmAddress.from(relayer.address).toBytes32(), // recipient
      mainnetTokens.usdc // token
    );

    //  ERC20 tokens:
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.dai, CHAIN_IDs.MAINNET),
      amountToSend
    );
    expect(l1PolygonRootChainManager.depositFor).to.have.been.calledWith(
      relayer.address, // user
      mainnetTokens.dai, // root token
      bnToHex(amountToSend) // deposit data. bytes encoding of the amount to send.
    );

    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.wbtc, CHAIN_IDs.MAINNET),
      amountToSend
    );
    expect(l1PolygonRootChainManager.depositFor).to.have.been.calledWith(
      relayer.address, // user
      mainnetTokens.wbtc, // root token
      bnToHex(amountToSend) // deposit data. bytes encoding of the amount to send.
    );

    // Weth is not directly sendable over the canonical bridge. Rather, we should see a call against the atomic depositor.
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.weth, CHAIN_IDs.MAINNET),
      amountToSend
    );
    const bridgeCalldata = l1PolygonRootChainManager.interface.encodeFunctionData("depositEtherFor", [relayer.address]);
    expect(l1AtomicDepositor.bridgeWeth).to.have.been.calledWith(
      chainId,
      amountToSend, // amount
      amountToSend,
      bnZero,
      bridgeCalldata
    );
  });

  it("Correctly sends tokens to chain: Arbitrum", async function () {
    const chainId = CHAIN_IDs.ARBITRUM;

    // These values are hardcoded into the Arbitrum bridge contract
    const transactionSubmissionData =
      "0x000000000000000000000000000000000000000000000000002386f26fc1000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000";
    const l2GasLimit = toBN(150000);
    const l2GasPrice = toBN(20e9);

    //  CCTP tokens:
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.usdc, CHAIN_IDs.MAINNET),
      amountToSend,
      false,
      toAddressType(TOKEN_SYMBOLS_MAP.USDC.addresses[chainId], CHAIN_IDs.MAINNET)
    );
    expect(l1CCTPTokenMessager.depositForBurn).to.have.been.calledWith(
      amountToSend, // amount
      getCctpDomainForChainId(chainId), // destinationDomain
      EvmAddress.from(relayer.address).toBytes32(), // recipient
      mainnetTokens.usdc // token
    );

    //  ERC20 tokens:
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.wbtc, CHAIN_IDs.MAINNET),
      amountToSend
    );
    expect(l1ArbitrumBridge.outboundTransfer).to.have.been.calledWith(
      mainnetTokens.wbtc, // token
      relayer.address, // to
      amountToSend, // amount
      l2GasLimit, // maxGas
      l2GasPrice, // gasPriceBid
      transactionSubmissionData // data
    );
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.dai, CHAIN_IDs.MAINNET),
      amountToSend
    );
    expect(l1ArbitrumBridge.outboundTransfer).to.have.been.calledWith(
      mainnetTokens.dai, // token
      relayer.address, // to
      amountToSend, // amount
      l2GasLimit, // maxGas
      l2GasPrice, // gasPriceBid
      transactionSubmissionData // data
    );
    // Weth can be bridged like a standard ERC20 token to arbitrum.
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.weth, CHAIN_IDs.MAINNET),
      amountToSend
    );
    expect(l1ArbitrumBridge.outboundTransfer).to.have.been.calledWith(
      mainnetTokens.weth, // token
      relayer.address, // to
      amountToSend, // amount
      l2GasLimit, // maxGas
      l2GasPrice, // gasPriceBid
      transactionSubmissionData // data
    );
  });

  it("Correctly sends tokens to chain: zkSync", async function () {
    const chainId = CHAIN_IDs.ZK_SYNC;
    const bridgeParams = {
      chainId: toBN(324),
      mintValue: bnZero,
      l2Value: bnZero,
      l2GasLimit: toBN(2000000),
      l2GasPerPubdataByteLimit: toBN(800),
      refundRecipient: relayer.address,
      secondBridgeAddress: CONTRACT_ADDRESSES[CHAIN_IDs.MAINNET].zkStackSharedBridge.address, // Shared bridge address
      secondBridgeValue: bnZero,
    };
    //  ERC20 tokens:
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.usdc, CHAIN_IDs.MAINNET),
      amountToSend,
      false,
      toAddressType(TOKEN_SYMBOLS_MAP["USDC.e"].addresses[chainId], CHAIN_IDs.MAINNET)
    );
    expect(l1BridgeHub.requestL2TransactionTwoBridges).to.have.been.calledWith({
      ...bridgeParams,
      secondBridgeCalldata: ethers.utils.defaultAbiCoder.encode(
        ["address", "uint256", "address"],
        [mainnetTokens.usdc, amountToSend, relayer.address]
      ),
    });

    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.wbtc, CHAIN_IDs.MAINNET),
      amountToSend
    );
    expect(l1BridgeHub.requestL2TransactionTwoBridges).to.have.been.calledWith({
      ...bridgeParams,
      secondBridgeCalldata: ethers.utils.defaultAbiCoder.encode(
        ["address", "uint256", "address"],
        [mainnetTokens.wbtc, amountToSend, relayer.address]
      ),
    });

    // Check that value is sent when the bridge hub returns a base cost.
    l1BridgeHub.l2TransactionBaseCost.returns(toBNWei("0.2"));
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.wbtc, CHAIN_IDs.MAINNET),
      amountToSend
    );
    expect(l1BridgeHub.requestL2TransactionTwoBridges).to.have.been.calledWithValue(toBNWei("0.2"));

    // Weth is not directly sendable over the canonical bridge. Rather, we should see a call against the atomic depositor.
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.weth, CHAIN_IDs.MAINNET),
      amountToSend
    );
    const fee = toBNWei("0.2");
    const bridgeCalldata = l1BridgeHub.interface.encodeFunctionData("requestL2TransactionDirect", [
      [chainId, amountToSend.add(fee), relayer.address, amountToSend, "0x", 2_000_000, 800, [], relayer.address],
    ]);
    expect(l1AtomicDepositor.bridgeWeth).to.have.been.calledWith(
      chainId,
      amountToSend.add(fee),
      amountToSend,
      bnZero,
      bridgeCalldata
    );
    expect(l1AtomicDepositor.bridgeWeth).to.have.been.calledWithValue(toBN(0));
  });
  it("Correctly sends tokens to chain: Base", async function () {
    const chainId = CHAIN_IDs.BASE;
    const l2Gas = 200000; // This is hardcoded in all OVM Bridges
    //  CCTP tokens:
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.usdc, CHAIN_IDs.MAINNET),
      amountToSend,
      undefined,
      toAddressType(TOKEN_SYMBOLS_MAP.USDC.addresses[chainId], CHAIN_IDs.MAINNET)
    );
    expect(l1CCTPTokenMessager.depositForBurn).to.have.been.calledWith(
      amountToSend, // amount
      getCctpDomainForChainId(chainId), // destinationDomain
      EvmAddress.from(relayer.address).toBytes32(), // recipient
      mainnetTokens.usdc // token
    );

    //  ERC20 tokens:
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.usdc, CHAIN_IDs.MAINNET),
      amountToSend,
      undefined,
      toAddressType(TOKEN_SYMBOLS_MAP.USDbC.addresses[chainId], CHAIN_IDs.MAINNET)
    );
    expect(l1BaseBridge.depositERC20).to.have.been.calledWith(
      mainnetTokens.usdc, // l1 token
      TOKEN_SYMBOLS_MAP.USDbC.addresses[chainId], // l2 token
      amountToSend, // amount
      l2Gas, // l2Gas
      "0x" // data
    );

    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.bal, CHAIN_IDs.MAINNET),
      amountToSend
    );
    expect(l1BaseBridge.depositERC20).to.have.been.calledWith(
      mainnetTokens.bal, // l1 token
      getL2TokenAddresses(mainnetTokens.bal)[chainId], // l2 token
      amountToSend, // amount
      l2Gas, // l2Gas
      "0x" // data
    );

    // DAI should not be a custom token on base.
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.dai, CHAIN_IDs.MAINNET),
      amountToSend
    );
    expect(l1BaseBridge.depositERC20).to.have.been.calledWith(
      mainnetTokens.dai, // l1 token
      getL2TokenAddresses(mainnetTokens.dai)[chainId], // l2 token
      amountToSend, // amount
      l2Gas, // l2Gas
      "0x" // data
    );

    // Weth is not directly sendable over the canonical bridge. Rather, we should see a call against the atomic depositor.
    await adapterManager.sendTokenCrossChain(
      toAddressType(relayer.address, CHAIN_IDs.MAINNET),
      chainId,
      toAddressType(mainnetTokens.weth, CHAIN_IDs.MAINNET),
      amountToSend
    );
    const bridgeCalldata = l1BaseBridge.interface.encodeFunctionData("depositETHTo", [
      relayer.address,
      adapterManager.adapters[chainId].bridges[mainnetTokens.weth].l2Gas,
      "0x",
    ]);
    expect(l1AtomicDepositor.bridgeWeth).to.have.been.calledWith(
      chainId, // chainId
      amountToSend, // amount
      amountToSend,
      bnZero,
      bridgeCalldata
    );
  });
});

async function seedMocks() {
  const allL1Tokens = Object.values(TOKEN_SYMBOLS_MAP).map((details) => details.addresses[CHAIN_IDs.MAINNET]);
  allL1Tokens.forEach((address) =>
    Object.entries(getL2TokenAddresses(address)).forEach(([chainId, l2Addr]) =>
      hubPoolClient.setTokenMapping(address, Number(chainId), l2Addr)
    )
  );

  // Construct fake spoke pool clients. All the adapters need is a signer and a provider on each chain.
  for (const chainId of enabledChainIds) {
    if (!mockSpokePoolClients[chainId]) {
      mockSpokePoolClients[chainId] = {} as unknown as EVMSpokePoolClient;
    }
    mockSpokePoolClients[chainId] = new EVMSpokePoolClient(
      logger,
      { address: ZERO_ADDRESS, provider: ethers.provider, signer: (await ethers.getSigners())[0] } as Contract,
      undefined,
      chainId,
      0,
      {}
    );
  }
}

async function constructChainSpecificFakes() {
  // Shared contracts.
  l1AtomicDepositor = await makeFake("atomicDepositor", CONTRACT_ADDRESSES[1].atomicDepositor.address);

  // Optimism contracts
  l1OptimismBridge = await makeFake("ovmStandardBridge_10", CONTRACT_ADDRESSES[1].ovmStandardBridge_10.address);
  l1OptimismDaiBridge = await makeFake("daiOptimismBridge", CONTRACT_ADDRESSES[1].daiOptimismBridge.address);
  l1OptimismSnxBridge = await makeFake("snxOptimismBridge", CONTRACT_ADDRESSES[1].snxOptimismBridge.address);

  // Polygon contracts
  l1PolygonRootChainManager = await makeFake(
    "polygonRootChainManager",
    CONTRACT_ADDRESSES[1].polygonRootChainManager.address
  );

  // Arbitrum contracts
  l1ArbitrumBridge = await makeFake(
    "orbitErc20GatewayRouter_42161",
    CONTRACT_ADDRESSES[1].orbitErc20GatewayRouter_42161.address
  );

  // zkSync contracts
  l1BridgeHub = await makeFake("zkStackBridgeHub", CONTRACT_ADDRESSES[1].zkStackBridgeHub.address);

  // Base contracts
  l1BaseBridge = await makeFake("ovmStandardBridge_8453", CONTRACT_ADDRESSES[1].ovmStandardBridge_8453.address);

  // CCTP contracts
  l1CCTPTokenMessager = await makeFake("cctpTokenMessenger", CONTRACT_ADDRESSES[1].cctpTokenMessenger.address);
}

async function makeFake(contractName: string, address: string) {
  const _interface = CONTRACT_ADDRESSES[1][contractName]?.abi;
  if (_interface === undefined) {
    throw new Error(`${contractName} is not a valid contract name`);
  }
  return await smock.fake(_interface, { address });
}
