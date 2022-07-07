import { expect, ethers, SignerWithAddress, createSpyLogger, winston } from "./utils";
import { BigNumber, FakeContract, smock, toBN } from "./utils";
import { MockHubPoolClient } from "./mocks";
import { bnToHex } from "../src/utils";
import { SpokePoolClient } from "../src/clients";
import { AdapterManager } from "../src/clients/bridges"; // Tested
import { l2TokensToL1TokenValidation } from "../src/common";
import * as interfaces from "../src/clients/bridges/ContractInterfaces";

let hubPoolClient: MockHubPoolClient,
  mockSpokePoolClients: {
    [chainId: number]: SpokePoolClient;
  } = {};
let relayer: SignerWithAddress, spy: sinon.SinonSpy, spyLogger: winston.Logger, amountToSend: BigNumber;
let adapterManager: AdapterManager; // tested

// Atomic depositor
let l1AtomicDepositor: FakeContract;

// Optimism contracts
let l1OptimismBridge: FakeContract, l1OptimismDaiBridge: FakeContract;

// Polygon contracts
let l1PolygonRootChainManager: FakeContract;

// Boba contracts
let l1BobaBridge: FakeContract;

// Arbitrum contracts
let l1ArbitrumBridge: FakeContract;

const enabledChainIds = [1, 10, 137, 288, 42161];

const mainnetTokens = {
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  wbtc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
};

describe("AdapterManager: Send tokens cross-chain", async function () {
  beforeEach(async function () {
    [relayer] = await ethers.getSigners();
    ({ spy, spyLogger } = createSpyLogger());

    hubPoolClient = new MockHubPoolClient(null, null);
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
      l2TokensToL1TokenValidation[mainnetTokens["usdc"]][chainId], // l2 token
      amountToSend, // amount
      (adapterManager.adapters[chainId] as any).l2Gas, // l2Gas
      "0x" // data
    );

    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["wbtc"], amountToSend);
    expect(l1OptimismBridge.depositERC20).to.have.been.calledWith(
      mainnetTokens["wbtc"], // l1 token
      l2TokensToL1TokenValidation[mainnetTokens["wbtc"]][chainId], // l2 token
      amountToSend, // amount
      (adapterManager.adapters[chainId] as any).l2Gas, // l2Gas
      "0x" // data
    );

    // Non- ERC20 tokens:
    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["dai"], amountToSend);
    // Note the target is the L1 dai optimism bridge.
    expect(l1OptimismDaiBridge.depositERC20).to.have.been.calledWith(
      mainnetTokens["dai"], // l1 token
      l2TokensToL1TokenValidation[mainnetTokens["dai"]][chainId], // l2 token
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
    const chainId = 137; // Boba ChainId
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
  it("Correctly sends tokens to chain: Boba", async function () {
    const chainId = 288; // Boba ChainId
    //  ERC20 tokens:
    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["usdc"], amountToSend);
    expect(l1BobaBridge.depositERC20).to.have.been.calledWith(
      mainnetTokens["usdc"], // l1 token
      l2TokensToL1TokenValidation[mainnetTokens["usdc"]][chainId], // l2 token
      amountToSend, // amount
      (adapterManager.adapters[chainId] as any).l2Gas, // l2Gas
      "0x" // data
    );

    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["wbtc"], amountToSend);
    expect(l1BobaBridge.depositERC20).to.have.been.calledWith(
      mainnetTokens["wbtc"], // l1 token
      l2TokensToL1TokenValidation[mainnetTokens["wbtc"]][chainId], // l2 token
      amountToSend, // amount
      (adapterManager.adapters[chainId] as any).l2Gas, // l2Gas
      "0x" // data
    );

    // Note that on boba Dai is a  ERC20
    await adapterManager.sendTokenCrossChain(relayer.address, chainId, mainnetTokens["dai"], amountToSend);
    expect(l1BobaBridge.depositERC20).to.have.been.calledWith(
      mainnetTokens["dai"], // l1 token
      l2TokensToL1TokenValidation[mainnetTokens["dai"]][chainId], // l2 token
      amountToSend, // amount
      (adapterManager.adapters[chainId] as any).l2Gas, // l2Gas
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

  it("Correctly sends tokens to chain: Arbitrum", async function () {
    const chainId = 42161; // Boba ChainId
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
});

async function seedMocks() {
  hubPoolClient.setL1TokensToDestinationTokens(l2TokensToL1TokenValidation);

  // Construct fake spoke pool clients. All the adapters need is a signer and a provider on each chain.
  for (const chainId of enabledChainIds) {
    if (!mockSpokePoolClients[chainId]) mockSpokePoolClients[chainId] = {} as unknown as SpokePoolClient;
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
  l1AtomicDepositor = await makeFake("atomicDepositor", "0x26eaf37ee5daf49174637bdcd2f7759a25206c34");

  // Optimism contracts
  l1OptimismBridge = await makeFake("ovmL1Bridge", "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1");
  l1OptimismDaiBridge = await makeFake("ovmL1Bridge", "0x10e6593cdda8c58a1d0f14c5164b376352a55f2f");

  // Polygon contracts
  l1PolygonRootChainManager = await makeFake("polygonL1RootChainManager", "0xA0c68C638235ee32657e8f720a23ceC1bFc77C77");

  // Boba contracts
  l1BobaBridge = await makeFake("ovmL1Bridge", "0xdc1664458d2f0B6090bEa60A8793A4E66c2F1c00");

  // Arbitrum contracts
  l1ArbitrumBridge = await makeFake("arbitrumL1Erc20Gateway", "0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef");
}

async function makeFake(contractName: string, address: string) {
  contractName = contractName + "Interface";
  if (!interfaces[contractName]) throw new Error(`${contractName} is not a valid contract name`);
  return await smock.fake(interfaces[contractName], { address });
}
