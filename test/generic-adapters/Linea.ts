import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { SpokePoolClient } from "../../src/clients";
import { LineaBridge, LineaWethBridge, UsdcCCTPBridge } from "../../src/adapter/bridges";
import { BaseChainAdapter } from "../../src/adapter";
import { ethers, getContractFactory, Contract, randomAddress, expect, createRandomBytes32 } from "../utils";
import { utils } from "@across-protocol/sdk";
import { ZERO_ADDRESS } from "@uma/common";
import { CONTRACT_ADDRESSES, SUPPORTED_TOKENS } from "../../src/common";
import { BlockFinder, toBN, EvmAddress } from "../../src/utils/SDKUtils";
import { getCctpDomainForChainId } from "../../src/utils";

describe("Cross Chain Adapter: Linea", async function () {
  let adapter: BaseChainAdapter;
  let monitoredEoa: string;
  let l1Token, l1USDCToken, l1WETHToken, l2Token, l2USDCToken, l2WETHToken: string;
  let hubChainId, l2ChainId;

  let wethBridgeContract: Contract;
  let cctpBridgeContract: Contract;
  let erc20BridgeContract: Contract;
  let searchConfig: utils.EventSearchConfig;

  const toAddress = (address: string): EvmAddress => {
    return EvmAddress.from(address);
  };
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
    l2USDCToken = TOKEN_SYMBOLS_MAP.USDC.addresses[l2ChainId];
    l2WETHToken = TOKEN_SYMBOLS_MAP.WETH.addresses[l2ChainId];

    const spokePool = await (await getContractFactory("MockSpokePool", deployer)).deploy(ZERO_ADDRESS);

    const l2SpokePoolClient = new SpokePoolClient(null, spokePool, null, l2ChainId, 0, {
      fromBlock: 0,
    });
    const l1SpokePoolClient = new SpokePoolClient(null, spokePool, null, hubChainId, 0, {
      fromBlock: 0,
    });

    wethBridgeContract = await (await getContractFactory("LineaWethBridge", deployer)).deploy();
    erc20BridgeContract = await (await getContractFactory("LineaERC20Bridge", deployer)).deploy();
    cctpBridgeContract = await (await getContractFactory("CctpV2TokenMessenger", deployer)).deploy();

    const bridges = {
      [l1WETHToken]: new LineaWethBridge(
        l2ChainId,
        hubChainId,
        l1SpokePoolClient.spokePool.signer,
        l2SpokePoolClient.spokePool.signer,
        l1WETHToken
      ),
      [l1USDCToken]: new UsdcCCTPBridge(
        l2ChainId,
        hubChainId,
        l1SpokePoolClient.spokePool.signer,
        l2SpokePoolClient.spokePool.signer
      ),
      [l1Token]: new LineaBridge(
        l2ChainId,
        hubChainId,
        l1SpokePoolClient.spokePool.signer,
        l2SpokePoolClient.spokePool.signer,
        l1Token
      ),
    };

    adapter = new MockBaseChainAdapter(
      {
        [l2ChainId]: l2SpokePoolClient,
        [hubChainId]: l1SpokePoolClient,
      }, // Don't need spoke pool clients for this test
      l2ChainId,
      hubChainId,
      [toAddress(monitoredEoa)],
      null,
      SUPPORTED_TOKENS[l2ChainId],
      bridges,
      1.5
    );
    adapter.setTargetL1Bridge(l1WETHToken, wethBridgeContract);
    adapter.setTargetL1Bridge(l1USDCToken, cctpBridgeContract);
    adapter.setTargetL1Bridge(l1Token, erc20BridgeContract);

    adapter.setTargetL2Bridge(l1WETHToken, wethBridgeContract);
    adapter.setTargetL2Bridge(l1USDCToken, cctpBridgeContract);
    adapter.setTargetL2Bridge(l1Token, erc20BridgeContract);

    // Required to pass checks in `BaseAdapter.getUpdatedSearchConfigs`
    l2SpokePoolClient.latestBlockSearched = searchConfig.toBlock;
    l1SpokePoolClient.latestBlockSearched = searchConfig.toBlock;
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

      const wethBridge = adapter.bridges[l1WETHToken];
      const result = await wethBridge.queryL1BridgeInitiationEvents(
        toAddress(l1WETHToken),
        undefined,
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(Object.keys(result).length).to.equal(1);
      expect(result[l2WETHToken].length).to.equal(1);
      expect(result[l2WETHToken][0].amount).to.equal(1);
    });
    it("Get L2 finalized events", async function () {
      // Function should return only finalized events that match
      // on message hash.
      const expectedMessageHash = createRandomBytes32();
      const otherMessageHash = createRandomBytes32();
      const unfinalizedMessageHash = createRandomBytes32();
      await wethBridgeContract.emitMessageSentWithMessageHash(randomAddress(), monitoredEoa, 1, expectedMessageHash);
      await wethBridgeContract.emitMessageSentWithMessageHash(randomAddress(), monitoredEoa, 2, unfinalizedMessageHash);
      await wethBridgeContract.emitMessageSentWithMessageHash(monitoredEoa, randomAddress(), 1, otherMessageHash);

      const expectedTxn = await wethBridgeContract.emitMessageClaimed(expectedMessageHash);
      await wethBridgeContract.emitMessageClaimed(otherMessageHash);

      await adapter.updateSpokePoolClients();
      searchConfig = adapter.getUpdatedSearchConfigs().l2SearchConfig;

      const wethBridge = adapter.bridges[l1WETHToken];
      wethBridge.blockFinder = new BlockFinder(wethBridgeContract.provider);
      const result = await wethBridge.queryL2BridgeFinalizationEvents(
        toAddress(l1WETHToken),
        undefined,
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(Object.keys(result).length).to.equal(1);
      expect(result[l2WETHToken][0].amount).to.equal(1);

      // The transaction hash should correspond to the L2 finalization call.
      expect(result[l2WETHToken][0].txnRef).to.equal(expectedTxn.hash);
    });
    it("Matches L1 and L2 events", async function () {
      const messageHash = createRandomBytes32();
      const otherMessageHash = createRandomBytes32();
      await wethBridgeContract.emitMessageSentWithMessageHash(randomAddress(), monitoredEoa, 1, messageHash);
      const unfinalizedTx = await wethBridgeContract.emitMessageSentWithMessageHash(
        randomAddress(),
        monitoredEoa,
        1,
        otherMessageHash
      );
      await wethBridgeContract.emitMessageClaimed(messageHash);
      await adapter.updateSpokePoolClients();
      adapter.bridges[l1WETHToken].blockFinder = new BlockFinder(wethBridgeContract.provider);
      const result = await adapter.getOutstandingCrossChainTransfers([toAddress(l1WETHToken)]);

      // There should be one outstanding transfer, since there are two deposit events and one
      // finalization event
      expect(Object.keys(result).length).to.equal(1);
      expect(Object.keys(result[monitoredEoa]).length).to.equal(1);
      expect(Object.keys(result[monitoredEoa][l1WETHToken])[0]).to.equal(l2WETHToken);
      expect(result[monitoredEoa][l1WETHToken][l2WETHToken].depositTxHashes[0]).to.equal(unfinalizedTx.hash);
    });
  });
  describe("CCTP", () => {
    it("return only relevant L1 bridge init events", async () => {
      await cctpBridgeContract.emitDepositForBurn(
        l1USDCToken,
        1,
        monitoredEoa,
        ethers.utils.hexZeroPad(monitoredEoa, 32),
        getCctpDomainForChainId(CHAIN_IDs.LINEA),
        ethers.utils.hexZeroPad(cctpBridgeContract.address, 32),
        ethers.utils.hexZeroPad(monitoredEoa, 32)
      );
      await cctpBridgeContract.emitDepositForBurn(
        l1USDCToken,
        1,
        monitoredEoa,
        ethers.utils.hexZeroPad(monitoredEoa, 32),
        getCctpDomainForChainId(CHAIN_IDs.LINEA),
        ethers.utils.hexZeroPad(cctpBridgeContract.address, 32),
        ethers.utils.hexZeroPad(monitoredEoa, 32)
      );
      await cctpBridgeContract.emitMintAndWithdraw(monitoredEoa, 1, l2USDCToken);
      const outstandingTransfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1USDCToken)]);
      expect(outstandingTransfers[monitoredEoa][l1USDCToken][l2USDCToken].totalAmount).to.equal(toBN(1));
    });
  });
  describe("ERC20", function () {
    it("Get L1 initiated events", async function () {
      await erc20BridgeContract.emitBridgingInitiated(randomAddress(), monitoredEoa, l1Token);
      await erc20BridgeContract.emitBridgingInitiated(monitoredEoa, randomAddress(), l1Token);
      await erc20BridgeContract.emitBridgingInitiated(randomAddress(), monitoredEoa, randomAddress());

      const erc20Bridge = adapter.bridges[l1Token];
      const result = await erc20Bridge.queryL1BridgeInitiationEvents(
        toAddress(l1Token),
        undefined,
        toAddress(monitoredEoa),
        searchConfig
      );

      expect(Object.keys(result).length).to.equal(1);
    });
    it("Get L2 finalized events", async function () {
      // Should return only event
      await erc20BridgeContract.emitBridgingFinalized(l1Token, monitoredEoa);
      await erc20BridgeContract.emitBridgingFinalized(randomAddress(), monitoredEoa);
      await erc20BridgeContract.emitBridgingFinalized(l1Token, randomAddress());

      const erc20Bridge = adapter.bridges[l1Token];
      const result = await erc20Bridge.queryL2BridgeFinalizationEvents(
        toAddress(l1Token),
        undefined,
        toAddress(monitoredEoa),
        searchConfig
      );

      expect(Object.keys(result).length).to.equal(1);
    });
    it("Matches L1 and L2 events", async function () {
      await erc20BridgeContract.emitBridgingInitiated(randomAddress(), monitoredEoa, l1Token);
      const unfinalizedTx = await erc20BridgeContract.emitBridgingInitiated(randomAddress(), monitoredEoa, l1Token);
      await erc20BridgeContract.emitBridgingFinalized(l1Token, monitoredEoa);

      await adapter.updateSpokePoolClients();
      const result = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);

      // There should be one outstanding transfer, since there are two deposit events and one
      // finalization event
      expect(Object.keys(result).length).to.equal(1);
      expect(Object.keys(result[monitoredEoa]).length).to.equal(1);
      expect(Object.keys(result[monitoredEoa][l1Token])[0]).to.equal(l2Token);
      expect(result[monitoredEoa][l1Token][l2Token].depositTxHashes[0]).to.equal(unfinalizedTx.hash);
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
    expect(usdcBridge.l1Bridge.address) === CONTRACT_ADDRESSES[hubChainId]["cctpV2TokenMessenger"].address;
  });
  it("getL2Bridge: USDC", async function () {
    const usdcBridge = adapter.bridges[TOKEN_SYMBOLS_MAP.USDC.addresses[hubChainId]];
    expect(usdcBridge.l2Bridge).to.not.be.undefined;
    expect(usdcBridge.l2Bridge.address) === CONTRACT_ADDRESSES[l2ChainId]["cctpV2TokenMessenger"].address;
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

class MockBaseChainAdapter extends BaseChainAdapter {
  setTargetL1Bridge(l1Token: string, l1Bridge: Contract) {
    this.bridges[l1Token].l1Bridge = l1Bridge;
  }

  setTargetL2Bridge(l1Token: string, l2Bridge: Contract) {
    this.bridges[l1Token].l2Bridge = l2Bridge;
  }

  async updateSpokePoolClients() {
    // Since we are simulating getting outstanding transfers, we need to manually overwrite the config in
    // the adapter so that getOutstandingCrossChainTransfers won't throw an error.
    const blockNumber = await this.spokePoolClients[this.hubChainId].spokePool.provider.getBlockNumber();
    this.spokePoolClients[this.hubChainId].latestBlockSearched = blockNumber;
    this.spokePoolClients[this.chainId].latestBlockSearched = blockNumber;
  }
}
