import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { SpokePoolClient } from "../../src/clients";
import { LineaBridge, LineaUSDCBridge, LineaWethBridge } from "../../src/adapter/bridges";
import { BaseChainAdapter } from "../../src/adapter";
import { ethers, getContractFactory, Contract, randomAddress, expect, createRandomBytes32, toBN } from "../utils";
import { utils } from "@across-protocol/sdk";
import { ZERO_ADDRESS } from "@uma/common";
import { CONTRACT_ADDRESSES, SUPPORTED_TOKENS } from "../../src/common";

describe("Cross Chain Adapter: Linea", async function () {
  let adapter: BaseChainAdapter;
  let monitoredEoa: string;
  let l1Token, l1USDCToken, l1WETHToken, l2Token, l2USDCToken, l2WETHToken: string;
  let hubChainId, l2ChainId;

  let wethBridgeContract: Contract;
  let usdcBridgeContract: Contract;
  let erc20BridgeContract: Contract;
  let searchConfig: utils.EventSearchConfig;

  beforeEach(async function () {
    searchConfig = {
      fromBlock: 0,
      toBlock: 1_000_000,
    };
    const [deployer] = await ethers.getSigners();

    monitoredEoa = randomAddress();
    hubChainId = CHAIN_IDs.MAINNET;
    l2ChainId = CHAIN_IDs.LINEA;

    l1Token = TOKEN_SYMBOLS_MAP.WBTC.addresses[hubChainId];
    l1USDCToken = TOKEN_SYMBOLS_MAP.USDC.addresses[hubChainId];
    l1WETHToken = TOKEN_SYMBOLS_MAP.WETH.addresses[hubChainId];

    l2Token = TOKEN_SYMBOLS_MAP.WBTC.addresses[l2ChainId];
    l2USDCToken = TOKEN_SYMBOLS_MAP["USDC.e"].addresses[l2ChainId];
    l2WETHToken = TOKEN_SYMBOLS_MAP.WETH.addresses[l2ChainId];

    const spokePool = await (await getContractFactory("MockSpokePool", deployer)).deploy(ZERO_ADDRESS);

    const l2SpokePoolClient = new SpokePoolClient(null, spokePool, null, l2ChainId, 0, {
      fromBlock: 0,
    });
    const l1SpokePoolClient = new SpokePoolClient(null, spokePool, null, hubChainId, 0, {
      fromBlock: 0,
    });

    wethBridgeContract = await (await getContractFactory("LineaWethBridge", deployer)).deploy();
    usdcBridgeContract = await (await getContractFactory("LineaUsdcBridge", deployer)).deploy();
    erc20BridgeContract = await (await getContractFactory("LineaERC20Bridge", deployer)).deploy();

    const bridges = {
      [l1WETHToken]: new LineaWethBridge(
        l2ChainId,
        hubChainId,
        l1SpokePoolClient.spokePool.signer,
        l2SpokePoolClient.spokePool.signer
      ),
      [l1USDCToken]: new LineaUSDCBridge(
        l2ChainId,
        hubChainId,
        l1SpokePoolClient.spokePool.signer,
        l2SpokePoolClient.spokePool.signer
      ),
      [l1Token]: new LineaBridge(
        l2ChainId,
        hubChainId,
        l1SpokePoolClient.spokePool.signer,
        l2SpokePoolClient.spokePool.signer
      ),
    };

    adapter = new BaseChainAdapter(
      {
        [l2ChainId]: l2SpokePoolClient,
        [hubChainId]: l1SpokePoolClient,
      }, // Don't need spoke pool clients for this test
      l2ChainId,
      hubChainId,
      [], // monitored address doesn't matter for this test since we inject it into the function
      null,
      SUPPORTED_TOKENS[l2ChainId],
      bridges,
      1.5
    );
  });

  describe("WETH", function () {
    it("Get L1 initiated events", async function () {
      // Emit events:
      // - some with monitored address as sender
      // - some with monitored address as recipient
      // Function should return only events with recipient equal
      // to monitored address and value greater than 0
      await wethBridgeContract.emitMessageSent(randomAddress(), monitoredEoa, 0);
      await wethBridgeContract.emitMessageSent(monitoredEoa, randomAddress(), 0);
      await wethBridgeContract.emitMessageSent(randomAddress(), monitoredEoa, 1);
      await wethBridgeContract.emitMessageSent(monitoredEoa, randomAddress(), 1);

      // Our LineaWethBridge will have its l1Bridge contract automatically be set to the mainnet deployment
      // (0x051...3391). This means that it will NOT pick up the emitted events of the mock deployment contract
      // unless we overwrite the l1Bridge attribute.
      adapter.bridges[l1WETHToken].l1Bridge = wethBridgeContract;

      const wethBridge = adapter.bridges[l1WETHToken];
      const result = await wethBridge.queryL1BridgeInitiationEvents(l1WETHToken, monitoredEoa, searchConfig);
      expect(Object.keys(result).length).to.equal(1);
      expect(result[l2WETHToken].length).to.equal(1);
      expect(result[l2WETHToken][0].to).to.equal(monitoredEoa);
      expect(result[l2WETHToken][0].amount).to.equal(1);
    });
    it("Get L2 finalized events", async function () {
      // Function should return only finalized events that match
      // on message hash.

      await wethBridgeContract.emitMessageSent(randomAddress(), monitoredEoa, 1);
      await wethBridgeContract.emitMessageSent(monitoredEoa, randomAddress(), 1);

      // The mocked Linea bridge has no logic to construct a message hash so its expected value is
      // the default bytes32.
      const messageHash = "0x0000000000000000000000000000000000000000000000000000000000000000";
      const otherMessageHash = createRandomBytes32();
      await wethBridgeContract.emitMessageClaimed(messageHash);
      await wethBridgeContract.emitMessageClaimed(otherMessageHash);

      adapter.bridges[l1WETHToken].l2Bridge = wethBridgeContract;

      const wethBridge = adapter.bridges[l1WETHToken];
      const result = await wethBridge.queryL2BridgeFinalizationEvents(l1WETHToken, monitoredEoa, searchConfig);

      expect(Object.keys(result).length).to.equal(1);
      expect(result[0].args._messageHash).to.equal(messageHash);
    });
    it("Matches L1 and L2 events", async function () {
      const messageHash = createRandomBytes32();
      await wethBridgeContract.emitMessageSentWithMessageHash(randomAddress(), monitoredEoa, 1, messageHash);
      await wethBridgeContract.emitMessageClaimed(messageHash);
      const l1Events = await adapter.getWethDepositInitiatedEvents(wethBridgeContract, monitoredEoa, searchConfig);
      const l2Events = await adapter.getWethDepositFinalizedEvents(wethBridgeContract, [messageHash], searchConfig);

      let outstandingTransfers = {};

      // 1. If l1 and l2 events pair off, outstanding transfers will be empty
      adapter.matchWethDepositEvents(l1Events, l2Events, outstandingTransfers, monitoredEoa, l1WETHToken);
      expect(outstandingTransfers).to.deep.equal({});

      // 2. If finalized event is missing, there will be an outstanding transfer.
      outstandingTransfers = {};
      adapter.matchWethDepositEvents(l1Events, [], outstandingTransfers, monitoredEoa, l1WETHToken);
      expect(
        outstandingTransfers[monitoredEoa][l1WETHToken][TOKEN_SYMBOLS_MAP.WETH.addresses[l2ChainId]]
      ).to.deep.equal({
        totalAmount: toBN(1),
        depositTxHashes: l1Events.map((e) => e.transactionHash),
      });
    });
  });
  describe("USDC", function () {
    it("Get L1 initiated events", async function () {
      await usdcBridgeContract.emitDeposited(randomAddress(), monitoredEoa);
      await usdcBridgeContract.emitDeposited(monitoredEoa, randomAddress());

      adapter.bridges[l1USDCToken].l1Bridge = usdcBridgeContract;
      const usdcBridge = adapter.bridges[l1USDCToken];

      const result = await usdcBridge.queryL1BridgeInitiationEvents(l1USDCToken, monitoredEoa, searchConfig);
      expect(Object.keys(result).length).to.equal(1);
      expect(result[l2USDCToken][0].to).to.equal(monitoredEoa);
    });
    it("Get L2 finalized events", async function () {
      await usdcBridgeContract.emitReceivedFromOtherLayer(randomAddress());
      await usdcBridgeContract.emitReceivedFromOtherLayer(monitoredEoa);
      const result = await adapter.getUsdcDepositFinalizedEvents(usdcBridgeContract, monitoredEoa, searchConfig);
      expect(result.length).to.equal(1);
      expect(result[0].args.recipient).to.equal(monitoredEoa);
    });
    it("Matches L1 and L2 events", async function () {
      await usdcBridgeContract.emitDeposited(randomAddress(), monitoredEoa);
      await usdcBridgeContract.emitReceivedFromOtherLayer(monitoredEoa);
      const l1Events = await adapter.getUsdcDepositInitiatedEvents(usdcBridgeContract, monitoredEoa, searchConfig);
      const l2Events = await adapter.getUsdcDepositFinalizedEvents(usdcBridgeContract, monitoredEoa, searchConfig);

      let outstandingTransfers = {};

      // 1. If l1 and l2 events pair off, outstanding transfers will be empty
      adapter.matchUsdcDepositEvents(l1Events, l2Events, outstandingTransfers, monitoredEoa, l1USDCToken);
      expect(outstandingTransfers).to.deep.equal({});

      // 2. If finalized event is missing, there will be an outstanding transfer.
      outstandingTransfers = {};
      adapter.matchUsdcDepositEvents(l1Events, [], outstandingTransfers, monitoredEoa, l1USDCToken);
      expect(
        outstandingTransfers[monitoredEoa][l1USDCToken][TOKEN_SYMBOLS_MAP["USDC.e"].addresses[l2ChainId]]
      ).to.deep.equal({
        totalAmount: toBN(0),
        depositTxHashes: l1Events.map((e) => e.transactionHash),
      });
    });
  });
  describe("ERC20", function () {
    it("Get L1 initiated events", async function () {
      await erc20BridgeContract.emitBridgingInitiated(randomAddress(), monitoredEoa, l1Token);
      await erc20BridgeContract.emitBridgingInitiated(monitoredEoa, randomAddress(), l1Token);
      await erc20BridgeContract.emitBridgingInitiated(randomAddress(), monitoredEoa, randomAddress());

      adapter.bridges[l1Token].l1Bridge = erc20BridgeContract;
      const erc20Bridge = adapter.bridges[l1Token];

      const result = await erc20Bridge.queryL1BridgeInitiationEvents(l1Token, monitoredEoa, searchConfig);
      expect(Object.keys(result).length).to.equal(1);
      expect(result[l2Token][0].to).to.equal(monitoredEoa);
    });
    it("Get L2 finalized events", async function () {
      // Should return only event
      await erc20BridgeContract.emitBridgingFinalized(l1Token, monitoredEoa);
      await erc20BridgeContract.emitBridgingFinalized(randomAddress(), monitoredEoa);
      await erc20BridgeContract.emitBridgingFinalized(l1Token, randomAddress());
      const result = await adapter.getErc20DepositFinalizedEvents(
        erc20BridgeContract,
        monitoredEoa,
        l1Token,
        searchConfig
      );
      expect(result.length).to.equal(1);
      expect(result[0].args.recipient).to.equal(monitoredEoa);
      expect(result[0].args.nativeToken).to.equal(l1Token);
    });
    it("Matches L1 and L2 events", async function () {
      await erc20BridgeContract.emitBridgingInitiated(randomAddress(), monitoredEoa, l1Token);
      await erc20BridgeContract.emitBridgingFinalized(l1Token, monitoredEoa);
      const l1Events = await adapter.getErc20DepositInitiatedEvents(
        erc20BridgeContract,
        monitoredEoa,
        l1Token,
        searchConfig
      );
      const l2Events = await adapter.getErc20DepositFinalizedEvents(
        erc20BridgeContract,
        monitoredEoa,
        l1Token,
        searchConfig
      );

      let outstandingTransfers = {};

      // 1. If l1 and l2 events pair off, outstanding transfers will be empty
      adapter.matchErc20DepositEvents(l1Events, l2Events, outstandingTransfers, monitoredEoa, l1Token);
      expect(outstandingTransfers).to.deep.equal({});

      // 2. If finalized event is missing, there will be an outstanding transfer.
      outstandingTransfers = {};
      adapter.matchErc20DepositEvents(l1Events, [], outstandingTransfers, monitoredEoa, l1Token);
      expect(outstandingTransfers[monitoredEoa][l1Token][TOKEN_SYMBOLS_MAP.WBTC.addresses[l2ChainId]]).to.deep.equal({
        totalAmount: toBN(0),
        depositTxHashes: l1Events.map((e) => e.transactionHash),
      });
    });
  });

  it("getL1MessageService", async function () {
    const wethBridge = adapter.bridges[TOKEN_SYMBOLS_MAP.WETH.addresses[hubChainId]];
    expect(wethBridge.l1Bridge).to.not.be.undefined;
    expect(wethBridge.l1Bridge.address) === CONTRACT_ADDRESSES[hubChainId]["lineaMessageService"].address;
  });
  it("getL2MessageService", async function () {
    const wethBridge = adapter.bridges[TOKEN_SYMBOLS_MAP.WETH.addresses[hubChainId]];
    expect(wethBridge.l2Bridge).to.not.be.undefined;
    expect(wethBridge.l2Bridge.address) === CONTRACT_ADDRESSES[l2ChainId]["l2MessageService"].address;
  });
  it("getL1Bridge: USDC", async function () {
    const usdcBridge = adapter.bridges[TOKEN_SYMBOLS_MAP.USDC.addresses[hubChainId]];
    expect(usdcBridge.l1Bridge).to.not.be.undefined;
    expect(usdcBridge.l1Bridge.address) === CONTRACT_ADDRESSES[hubChainId]["lineaL1UsdcBridge"].address;
  });
  it("getL2Bridge: USDC", async function () {
    const usdcBridge = adapter.bridges[TOKEN_SYMBOLS_MAP.USDC.addresses[hubChainId]];
    expect(usdcBridge.l2Bridge).to.not.be.undefined;
    expect(usdcBridge.l2Bridge.address) === CONTRACT_ADDRESSES[l2ChainId]["lineaL2UsdcBridge"].address;
  });
  it("getL1Bridge: ERC20", async function () {
    const erc20Bridge = adapter.bridges[TOKEN_SYMBOLS_MAP.WBTC.addresses[hubChainId]];
    expect(erc20Bridge.l1Bridge).to.not.be.undefined;
    expect(erc20Bridge.l1Bridge.address) === CONTRACT_ADDRESSES[hubChainId]["lineaL1TokenBridge"].address;
  });
  it("getL2Bridge: ERC20", async function () {
    const erc20Bridge = adapter.bridges[TOKEN_SYMBOLS_MAP.WBTC.addresses[hubChainId]];
    expect(erc20Bridge.l2Bridge).to.not.be.undefined;
    expect(erc20Bridge.l2Bridge.address) === CONTRACT_ADDRESSES[l2ChainId]["lineaL2TokenBridge"].address;
  });
});
