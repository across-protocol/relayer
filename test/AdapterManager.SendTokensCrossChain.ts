import { expect, ethers, SignerWithAddress, createSpyLogger, winston } from "./utils";
import { BigNumber, deployConfigStore, FakeContract, hubPoolFixture, smock, toBN } from "./utils";
import { MockConfigStoreClient, MockHubPoolClient } from "./mocks";
import { bnToHex, getL2TokenAddresses, toBNWei } from "../src/utils";
import { SpokePoolClient } from "../src/clients";
import { AdapterManager } from "../src/clients/bridges"; // Tested
import { constants } from "@across-protocol/sdk-v2";
import { CONTRACT_ADDRESSES } from "../src/common";
import * as zksync from "zksync-web3";
const { TOKEN_SYMBOLS_MAP, CHAIN_IDs } = constants;

let hubPoolClient: MockHubPoolClient;
const mockSpokePoolClients: {
  [chainId: number]: SpokePoolClient;
} = {};
let relayer: SignerWithAddress, owner: SignerWithAddress, spyLogger: winston.Logger, amountToSend: BigNumber;
let adapterManager: AdapterManager; // tested

// Atomic depositor
let l1AtomicDepositor: FakeContract;

// Optimism contracts
let l1OptimismBridge: FakeContract, l1OptimismDaiBridge: FakeContract, l1OptimismSnxBridge: FakeContract;

// Polygon contracts
let l1PolygonRootChainManager: FakeContract;

// Arbitrum contracts
let l1ArbitrumBridge: FakeContract;

// ZkSync contracts
let l1MailboxContract: FakeContract;
let l1ZkSyncBridge: FakeContract;

const enabledChainIds = [1, 10, 137, 288, 42161, 324];

const mainnetTokens = {
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  wbtc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  snx: "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
};

describe("AdapterManager: Send tokens cross-chain", async function () {
  beforeEach(async function () {
    [relayer, owner] = await ethers.getSigners();
    ({ spyLogger } = createSpyLogger());

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
      await adapterManager.sendTokenCrossChain(relayer.address, 42069, mainnetTokens["usdc"], amountToSend);
    } catch (error) {
      thrown1 = true;
    }
    expect(thrown1).to.be.equal(true);

    // Throws if there is a misconfiguration between L1 tokens and L2 tokens. This checks that the bot will error out
    // if it tries to delete money in the bridge. configure hubpool to return the wrong token for Optimism

    hubPoolClient.setL1TokensToDestinationTokens({
      // bad config. map USDC on L1 to boba on L2. This is WRONG for chainID 10 and should error.
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": { 10: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8" },
    });
    let thrown2 = false;
    try {
      await adapterManager.sendTokenCrossChain(relayer.address, 10, mainnetTokens["usdc"], amountToSend);
    } catch (error) {
      thrown2 = true;
    }
    expect(thrown2).to.be.equal(true);
  });
  it("Correctly sends tokens to chain: Optimism", async function () {
    const chainId = 10; // Optimism ChainId
    //  ERC20 tokens:
    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["usdc"], amountToSend);
    expect(l1OptimismBridge.depositERC20).to.have.been.calledWith(
      mainnetTokens["usdc"], // l1 token
      getL2TokenAddresses(mainnetTokens["usdc"])[chainId], // l2 token
      amountToSend, // amount
      (adapterManager.adapters[chainId] as any).l2Gas, // l2Gas
      "0x" // data
    );

    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["snx"], amountToSend);
    expect(l1OptimismSnxBridge.depositTo).to.have.been.calledWith(
      relayer.address, // to
      amountToSend // amount
    );

    // Non- ERC20 tokens:
    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["dai"], amountToSend);
    // Note the target is the L1 dai optimism bridge.
    expect(l1OptimismDaiBridge.depositERC20).to.have.been.calledWith(
      mainnetTokens["dai"], // l1 token
      getL2TokenAddresses(mainnetTokens["dai"])[chainId], // l2 token
      amountToSend, // amount
      (adapterManager.adapters[chainId] as any)?.l2Gas, // l2Gas
      "0x" // data
    );

    // Weth is not directly sendable over the canonical bridge. Rather, we should see a call against the atomic depositor.
    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["weth"], amountToSend);
    expect(l1AtomicDepositor.bridgeWethToOvm).to.have.been.calledWith(
      relayer.address, // to
      amountToSend, // amount
      (adapterManager.adapters[chainId] as any).l2Gas, // l2Gas
      chainId // chainId
    );
  });

  it("Correctly sends tokens to chain: Polygon", async function () {
    const chainId = 137;
    //  ERC20 tokens:
    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["usdc"], amountToSend);
    expect(l1PolygonRootChainManager.depositFor).to.have.been.calledWith(
      relayer.address, // user
      mainnetTokens["usdc"], // root token
      bnToHex(amountToSend) // deposit data. bytes encoding of the amount to send.
    );

    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["dai"], amountToSend);
    expect(l1PolygonRootChainManager.depositFor).to.have.been.calledWith(
      relayer.address, // user
      mainnetTokens["dai"], // root token
      bnToHex(amountToSend) // deposit data. bytes encoding of the amount to send.
    );

    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["wbtc"], amountToSend);
    expect(l1PolygonRootChainManager.depositFor).to.have.been.calledWith(
      relayer.address, // user
      mainnetTokens["wbtc"], // root token
      bnToHex(amountToSend) // deposit data. bytes encoding of the amount to send.
    );

    // Weth is not directly sendable over the canonical bridge. Rather, we should see a call against the atomic depositor.
    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["weth"], amountToSend);
    expect(l1AtomicDepositor.bridgeWethToPolygon).to.have.been.calledWith(
      relayer.address, // to
      amountToSend // amount
    );
  });

  it("Correctly sends tokens to chain: Arbitrum", async function () {
    const chainId = 42161;
    //  ERC20 tokens:
    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["usdc"], amountToSend);
    expect(l1ArbitrumBridge.outboundTransfer).to.have.been.calledWith(
      mainnetTokens["usdc"], // token
      relayer.address, // to
      amountToSend, // amount
      (adapterManager.adapters[chainId] as any).l2GasLimit, // maxGas
      (adapterManager.adapters[chainId] as any).l2GasPrice, // gasPriceBid
      (adapterManager.adapters[chainId] as any).transactionSubmissionData // data
    );
    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["wbtc"], amountToSend);
    expect(l1ArbitrumBridge.outboundTransfer).to.have.been.calledWith(
      mainnetTokens["wbtc"], // token
      relayer.address, // to
      amountToSend, // amount
      (adapterManager.adapters[chainId] as any).l2GasLimit, // maxGas
      (adapterManager.adapters[chainId] as any).l2GasPrice, // gasPriceBid
      (adapterManager.adapters[chainId] as any).transactionSubmissionData // data
    );
    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["dai"], amountToSend);
    expect(l1ArbitrumBridge.outboundTransfer).to.have.been.calledWith(
      mainnetTokens["dai"], // token
      relayer.address, // to
      amountToSend, // amount
      (adapterManager.adapters[chainId] as any).l2GasLimit, // maxGas
      (adapterManager.adapters[chainId] as any).l2GasPrice, // gasPriceBid
      (adapterManager.adapters[chainId] as any).transactionSubmissionData // data
    );
    // Weth can be bridged like a standard ERC20 token to arbitrum.
    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["weth"], amountToSend);
    expect(l1ArbitrumBridge.outboundTransfer).to.have.been.calledWith(
      mainnetTokens["weth"], // token
      relayer.address, // to
      amountToSend, // amount
      (adapterManager.adapters[chainId] as any).l2GasLimit, // maxGas
      (adapterManager.adapters[chainId] as any).l2GasPrice, // gasPriceBid
      (adapterManager.adapters[chainId] as any).transactionSubmissionData // data
    );
  });

  it("Correctly sends tokens to chain: zkSync", async function () {
    const chainId = 324;
    l1MailboxContract.l2TransactionBaseCost.returns(toBNWei("0.2"));
    //  ERC20 tokens:
    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["usdc"], amountToSend);
    expect(l1ZkSyncBridge.deposit).to.have.been.calledWith(
      relayer.address, // user
      mainnetTokens["usdc"], // root token
      amountToSend, // deposit data. bytes encoding of the amount to send.
      2_000_000, // l2 gas limit, default is 2mil if on hardhat network
      zksync.utils.REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT // gasPerPubdataLimit
    );
    expect(l1ZkSyncBridge.deposit).to.have.been.calledWithValue(toBNWei("0.2"));

    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["wbtc"], amountToSend);
    expect(l1ZkSyncBridge.deposit).to.have.been.calledWith(
      relayer.address, // user
      mainnetTokens["wbtc"], // root token
      amountToSend, // deposit data. bytes encoding of the amount to send.
      2_000_000, // l2 gas limit, default is 2mil if on hardhat network
      zksync.utils.REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT // gasPerPubdataLimit
    );
    expect(l1ZkSyncBridge.deposit).to.have.been.calledWithValue(toBNWei("0.2"));

    // Weth is not directly sendable over the canonical bridge. Rather, we should see a call against the atomic depositor.
    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["weth"], amountToSend);
    expect(l1AtomicDepositor.bridgeWethToZkSync).to.have.been.calledWith(
      relayer.address,
      amountToSend,
      2_000_000,
      zksync.utils.REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT,
      relayer.address
    );
    expect(l1AtomicDepositor.bridgeWethToZkSync).to.have.been.calledWithValue(0);
  });
});

async function seedMocks() {
  const allL1Tokens = Object.values(TOKEN_SYMBOLS_MAP).map((details) => details.addresses[CHAIN_IDs.MAINNET]);
  const tokenAddressMapping = Object.fromEntries(allL1Tokens.map((address) => [address, getL2TokenAddresses(address)]));
  hubPoolClient.setL1TokensToDestinationTokens(tokenAddressMapping);

  // Construct fake spoke pool clients. All the adapters need is a signer and a provider on each chain.
  for (const chainId of enabledChainIds) {
    if (!mockSpokePoolClients[chainId]) {
      mockSpokePoolClients[chainId] = {} as unknown as SpokePoolClient;
    }
    mockSpokePoolClients[chainId] = {
      spokePool: {
        provider: ethers.provider,
        signer: (await ethers.getSigners())[0],
      },
    } as unknown as SpokePoolClient;
  }
}

async function constructChainSpecificFakes() {
  // Shared contracts.
  l1AtomicDepositor = await makeFake("atomicDepositor", CONTRACT_ADDRESSES[1].atomicDepositor.address!);

  // Optimism contracts
  l1OptimismBridge = await makeFake("ovmStandardBridge", CONTRACT_ADDRESSES[1].ovmStandardBridge.address!);
  l1OptimismDaiBridge = await makeFake("daiOptimismBridge", CONTRACT_ADDRESSES[1].daiOptimismBridge.address!);
  l1OptimismSnxBridge = await makeFake("snxOptimismBridge", CONTRACT_ADDRESSES[1].snxOptimismBridge.address!);

  // Polygon contracts
  l1PolygonRootChainManager = await makeFake(
    "polygonRootChainManager",
    CONTRACT_ADDRESSES[1].polygonRootChainManager.address!
  );

  // Arbitrum contracts
  l1ArbitrumBridge = await makeFake(
    "arbitrumErc20GatewayRouter",
    CONTRACT_ADDRESSES[1].arbitrumErc20GatewayRouter.address!
  );

  // zkSync contracts
  l1ZkSyncBridge = await makeFake("zkSyncDefaultErc20Bridge", CONTRACT_ADDRESSES[1].zkSyncDefaultErc20Bridge.address!);
  l1MailboxContract = await makeFake("zkSyncMailbox", CONTRACT_ADDRESSES[1].zkSyncMailbox.address!);
}

async function makeFake(contractName: string, address: string) {
  const _interface = CONTRACT_ADDRESSES[1][contractName]?.abi;
  if (_interface === undefined) {
    throw new Error(`${contractName} is not a valid contract name`);
  }
  return await smock.fake(_interface, { address });
}
