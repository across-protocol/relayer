import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { SpokePoolClient } from "../../src/clients";
import { BaseChainAdapter } from "../../src/clients/bridges/BaseChainAdapter";
import { ethers, getContractFactory, Contract, randomAddress, expect, createRandomBytes32, toBN } from "../utils";
import { utils } from "@across-protocol/sdk";
import { ZERO_ADDRESS } from "@uma/common";
import { CONTRACT_ADDRESSES, SUPPORTED_TOKENS } from "../../src/common";

describe("Cross Chain Adapter: Linea", async function () {
  let adapter: BaseChainAdapter;
  let monitoredEoa: string;
  let l1Token, l1USDCToken, l1WETHToken: string;

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
    l1Token = TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.MAINNET];
    l1USDCToken = TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET];
    l1WETHToken = TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET];

    const spokePool = await (await getContractFactory("MockSpokePool", deployer)).deploy(ZERO_ADDRESS);

    const l2SpokePoolClient = new SpokePoolClient(null, spokePool, null, CHAIN_IDs.LINEA, 0, {
      fromBlock: 0,
    });
    const l1SpokePoolClient = new SpokePoolClient(null, spokePool, null, CHAIN_IDs.MAINNET, 0, {
      fromBlock: 0,
    });

    wethBridgeContract = await (await getContractFactory("LineaWethBridge", deployer)).deploy();
    usdcBridgeContract = await (await getContractFactory("LineaUsdcBridge", deployer)).deploy();
    erc20BridgeContract = await (await getContractFactory("LineaERC20Bridge", deployer)).deploy();

    const bridges = {
      [wethBridgeContract.address]: new BaseBridgeAdapter(
        CHAIN_IDs.LINEA,
        CHAIN_IDs.MAINNET,
        l1SpokePoolClient.spokePool.signer,
        l2SpokePoolClient.spokePool.signer,
        wethBridgeContract.address
      ),
      [usdcBridgeContract.address]: new BaseBridgeAdapter(
        CHAIN_IDs.LINEA,
        CHAIN_IDs.MAINNET,
        l1SpokePoolClient.spokePool.signer,
        l2SpokePoolClient.spokePool.signer,
        usdcBridgeContract.address
      ),
      [erc20BridgeContract.address]: new BaseBridgeAdapter(
        CHAIN_IDs.LINEA,
        CHAIN_IDs.MAINNET,
        l1SpokePoolClient.spokePool.signer,
        l2SpokePoolClient.spokePool.signer,
        erc20BridgeContract.address
      ),
    };

    adapter = new BaseChainAdapter(
      {
        [CHAIN_IDs.LINEA]: l2SpokePoolClient,
        [CHAIN_IDs.MAINNET]: l1SpokePoolClient,
      }, // Don't need spoke pool clients for this test
      CHAIN_IDs.LINEA,
      CHAIN_IDs.MAINNET,
      [], // monitored address doesn't matter for this test since we inject it into the function
      null,
      SUPPORTED_TOKENS[CHAIN_IDs.LINEA],
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
      const result = await adapter.getWethDepositInitiatedEvents(wethBridgeContract, monitoredEoa, searchConfig);
      expect(result.length).to.equal(1);
      expect(result[0].args._to).to.equal(monitoredEoa);
      expect(result[0].args._value).to.equal(1);
    });
    it("Get L2 finalized events", async function () {
      // Function should return only finalized events that match
      // on message hash.
      const messageHash = createRandomBytes32();
      const otherMessageHash = createRandomBytes32();
      await wethBridgeContract.emitMessageClaimed(messageHash);
      await wethBridgeContract.emitMessageClaimed(otherMessageHash);
      const result = await adapter.getWethDepositFinalizedEvents(wethBridgeContract, [messageHash], searchConfig);
      expect(result.length).to.equal(1);
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
        outstandingTransfers[monitoredEoa][l1WETHToken][TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.LINEA]]
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
      const result = await adapter.getUsdcDepositInitiatedEvents(usdcBridgeContract, monitoredEoa, searchConfig);
      expect(result.length).to.equal(1);
      expect(result[0].args.to).to.equal(monitoredEoa);
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
        outstandingTransfers[monitoredEoa][l1USDCToken][TOKEN_SYMBOLS_MAP["USDC.e"].addresses[CHAIN_IDs.LINEA]]
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
      const result = await adapter.getErc20DepositInitiatedEvents(
        erc20BridgeContract,
        monitoredEoa,
        l1Token,
        searchConfig
      );
      expect(result.length).to.equal(1);
      expect(result[0].args.recipient).to.equal(monitoredEoa);
      expect(result[0].args.token).to.equal(l1Token);
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
      expect(
        outstandingTransfers[monitoredEoa][l1Token][TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.LINEA]]
      ).to.deep.equal({
        totalAmount: toBN(0),
        depositTxHashes: l1Events.map((e) => e.transactionHash),
      });
    });
  });

  it("getL1MessageService", async function () {
    const l1MessageService = adapter.getL1MessageService();
    expect(l1MessageService).to.not.be.undefined;
    expect(l1MessageService.address) === CONTRACT_ADDRESSES[CHAIN_IDs.MAINNET]["lineaMessageService"].address;
  });
  it("getL2MessageService", async function () {
    const l2MessageService = adapter.getL2MessageService();
    expect(l2MessageService).to.not.be.undefined;
    expect(l2MessageService.address) === CONTRACT_ADDRESSES[CHAIN_IDs.LINEA]["l2MessageService"].address;
  });
  it("getL1Bridge: USDC", async function () {
    const bridge = adapter.getL1Bridge(TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]);
    expect(bridge).to.not.be.undefined;
    expect(bridge.address) === CONTRACT_ADDRESSES[CHAIN_IDs.MAINNET]["lineaL1UsdcBridge"].address;
  });
  it("getL2Bridge: USDC", async function () {
    const bridge = adapter.getL2Bridge(TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]);
    expect(bridge).to.not.be.undefined;
    expect(bridge.address) === CONTRACT_ADDRESSES[CHAIN_IDs.LINEA]["lineaL2UsdcBridge"].address;
  });
  it("getL1Bridge: ERC20", async function () {
    const bridge = adapter.getL1Bridge(TOKEN_SYMBOLS_MAP.WBTC.addresses[this.hubChainId]);
    expect(bridge).to.not.be.undefined;
    expect(bridge.address) === CONTRACT_ADDRESSES[CHAIN_IDs.MAINNET]["lineaL1TokenBridge"].address;
  });
  it("getL2Bridge: ERC20", async function () {
    const bridge = adapter.getL2Bridge(TOKEN_SYMBOLS_MAP.WBTC.addresses[this.hubChainId]);
    expect(bridge).to.not.be.undefined;
    expect(bridge.address) === CONTRACT_ADDRESSES[CHAIN_IDs.LINEA]["lineaL2TokenBridge"].address;
  });
});
