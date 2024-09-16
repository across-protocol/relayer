import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { SpokePoolClient } from "../../src/clients";
import { ScrollERC20Bridge } from "../../src/adapter/bridges";
import { BaseChainAdapter } from "../../src/adapter";
import { ethers, getContractFactory, Contract, randomAddress, expect } from "../utils";
import { utils } from "@across-protocol/sdk";
import { ZERO_ADDRESS } from "@uma/common";
import { CONTRACT_ADDRESSES } from "../../src/common";

describe("Cross Chain Adapter: Scroll", async function () {
  let adapter: BaseChainAdapter;
  let monitoredEoa: string;

  let l1Usdc, l1Weth, l2Usdc, l2Weth: string;
  let hubChainId, l2ChainId;

  let scrollBridgeContract: Contract;
  let searchConfig: utils.EventSearchConfig;
  let spokeAddress, hubPoolAddress: string;

  beforeEach(async function () {
    searchConfig = {
      fromBlock: 0,
      toBlock: 1_000_000,
    };
    const [deployer] = await ethers.getSigners();

    monitoredEoa = randomAddress();
    hubChainId = CHAIN_IDs.MAINNET;
    l2ChainId = CHAIN_IDs.SCROLL;

    l1Usdc = TOKEN_SYMBOLS_MAP.USDC.addresses[hubChainId];
    l1Weth = TOKEN_SYMBOLS_MAP.WETH.addresses[hubChainId];

    l2Usdc = TOKEN_SYMBOLS_MAP.USDC.addresses[l2ChainId];
    l2Weth = TOKEN_SYMBOLS_MAP.WETH.addresses[l2ChainId];

    const spokePool = await (await getContractFactory("MockSpokePool", deployer)).deploy(ZERO_ADDRESS);

    const l2SpokePoolClient = new SpokePoolClient(null, spokePool, null, l2ChainId, 0, {
      fromBlock: 0,
    });
    const l1SpokePoolClient = new SpokePoolClient(null, spokePool, null, hubChainId, 0, {
      fromBlock: 0,
    });
    spokeAddress = l2SpokePoolClient.spokePool.address;
    // For the purposes of this test, we will treat the hub pool as an EOA.
    hubPoolAddress = CONTRACT_ADDRESSES[hubChainId].hubPool.address;

    scrollBridgeContract = await (await getContractFactory("ScrollBridge", deployer)).deploy();

    const bridges = {
      [l1Weth]: new ScrollERC20Bridge(
        l2ChainId,
        hubChainId,
        l1SpokePoolClient.spokePool.signer,
        l2SpokePoolClient.spokePool.signer,
        l1Weth
      ),
      [l1Usdc]: new ScrollERC20Bridge(
        l2ChainId,
        hubChainId,
        l1SpokePoolClient.spokePool.signer,
        l2SpokePoolClient.spokePool.signer,
        l1Usdc
      ),
    };

    adapter = new MockBaseChainAdapter(
      {
        [l2ChainId]: l2SpokePoolClient,
        [hubChainId]: l1SpokePoolClient,
      }, // Don't need spoke pool clients for this test
      l2ChainId,
      hubChainId,
      [monitoredEoa, l2SpokePoolClient.spokePool.address],
      null,
      ["WETH", "USDC"],
      bridges,
      1.5
    );
    adapter.setTargetL1Bridge(l1Weth, scrollBridgeContract);
    adapter.setTargetL1Bridge(l1Usdc, scrollBridgeContract);

    adapter.setTargetL2Bridge(l1Weth, scrollBridgeContract);
    adapter.setTargetL2Bridge(l1Usdc, scrollBridgeContract);
  });

  describe("WETH", function () {
    it("Get L1 initiated events", async function () {
      // Emit events:
      // - some with monitored address as sender
      // - some with monitored address as recipient
      // Function should return only events with recipient equal
      // to monitored address and value greater than 0
      await scrollBridgeContract.deposit(l1Weth, l2Weth, randomAddress(), monitoredEoa, 0);
      await scrollBridgeContract.deposit(l1Weth, l2Weth, monitoredEoa, randomAddress(), 0);
      await scrollBridgeContract.deposit(l1Weth, l2Weth, randomAddress(), monitoredEoa, 1);
      await scrollBridgeContract.deposit(l1Weth, l2Weth, monitoredEoa, randomAddress(), 1);

      const wethBridge = adapter.bridges[l1Weth];
      const result = await wethBridge.queryL1BridgeInitiationEvents(l1Weth, undefined, monitoredEoa, searchConfig);
      expect(Object.keys(result).length).to.equal(1);
      expect(result[l2Weth].length).to.equal(1);
      expect(result[l2Weth][0].to).to.equal(monitoredEoa);
      expect(result[l2Weth][0].amount).to.equal(1);
    });
    it("Get L2 finalized events", async function () {
      // Function should return only finalized events that match
      // on message hash.
      await scrollBridgeContract.deposit(l1Weth, l2Weth, randomAddress(), monitoredEoa, 1);
      await scrollBridgeContract.deposit(l1Weth, l2Weth, randomAddress(), monitoredEoa, 2);
      await scrollBridgeContract.deposit(l1Weth, l2Weth, monitoredEoa, randomAddress(), 1);

      await scrollBridgeContract.finalize(l1Weth, l2Weth, randomAddress(), monitoredEoa, 1);
      await scrollBridgeContract.finalize(l1Weth, l2Weth, monitoredEoa, randomAddress(), 1);

      const wethBridge = adapter.bridges[l1Weth];
      const result = await wethBridge.queryL2BridgeFinalizationEvents(l1Weth, undefined, monitoredEoa, searchConfig);

      expect(Object.keys(result).length).to.equal(1);
      expect(result[l2Weth][0].amount).to.equal(1);
    });
    it("Matches L1 and L2 events", async function () {
      await scrollBridgeContract.deposit(l1Weth, l2Weth, monitoredEoa, monitoredEoa, 1);
      const pendingTx = scrollBridgeContract.deposit(l1Weth, l2Weth, monitoredEoa, monitoredEoa, 1);
      // Only one of the deposits were finalized.
      await scrollBridgeContract.finalize(l1Weth, l2Weth, monitoredEoa, monitoredEoa, 1);
      await adapter.updateSpokePoolClients();
      const unfinalizedTx = await pendingTx;
      const result = await adapter.getOutstandingCrossChainTransfers([l1Weth]);

      // There should be one outstanding transfer, since there are two deposit events and one
      // finalization event.
      // Two keys since two monitored addresses.
      expect(Object.keys(result).length).to.equal(2);
      expect(Object.keys(result[monitoredEoa]).length).to.equal(1);
      expect(Object.keys(result[monitoredEoa][l1Weth])[0]).to.equal(l2Weth);
      expect(result[monitoredEoa][l1Weth][l2Weth].depositTxHashes[0]).to.equal(unfinalizedTx.hash);
    });
    it("Matches L1 and L2 events, Hub -> Spoke", async function () {
      await scrollBridgeContract.deposit(l1Weth, l2Weth, hubPoolAddress, spokeAddress, 1);
      const pendingTx = scrollBridgeContract.deposit(l1Weth, l2Weth, hubPoolAddress, spokeAddress, 1);
      // Only one of the deposits were finalized.
      await scrollBridgeContract.finalize(l1Weth, l2Weth, hubPoolAddress, spokeAddress, 1);
      await adapter.updateSpokePoolClients();
      const unfinalizedTx = await pendingTx;
      const result = await adapter.getOutstandingCrossChainTransfers([l1Weth]);

      // There should be one outstanding transfer, since there are two deposit events and one
      // finalization event
      // Two keys since two monitored addresses.
      expect(Object.keys(result).length).to.equal(2);
      expect(Object.keys(result[spokeAddress]).length).to.equal(1);
      expect(Object.keys(result[spokeAddress][l1Weth])[0]).to.equal(l2Weth);
      expect(result[spokeAddress][l1Weth][l2Weth].depositTxHashes[0]).to.equal(unfinalizedTx.hash);
    });
  });
  describe("USDC", function () {
    it("Get L1 initiated events", async function () {
      await scrollBridgeContract.deposit(l1Usdc, l2Usdc, randomAddress(), monitoredEoa, 1);
      await scrollBridgeContract.deposit(l1Usdc, l2Usdc, monitoredEoa, randomAddress(), 1);

      const usdcBridge = adapter.bridges[l1Usdc];
      const result = await usdcBridge.queryL1BridgeInitiationEvents(l1Usdc, undefined, monitoredEoa, searchConfig);

      expect(Object.keys(result).length).to.equal(1);
      expect(result[l2Usdc][0].to).to.equal(monitoredEoa);
    });
    it("Get L2 finalized events", async function () {
      await scrollBridgeContract.finalize(l1Usdc, l2Usdc, randomAddress(), monitoredEoa, 1);
      await scrollBridgeContract.finalize(l1Usdc, l2Usdc, monitoredEoa, randomAddress(), 1);

      const usdcBridge = adapter.bridges[l1Usdc];
      const result = await usdcBridge.queryL2BridgeFinalizationEvents(l1Usdc, undefined, monitoredEoa, searchConfig);

      expect(Object.keys(result).length).to.equal(1);
      expect(result[l2Usdc][0].to).to.equal(monitoredEoa);
    });
    it("Matches L1 and L2 events", async function () {
      await scrollBridgeContract.deposit(l1Usdc, l2Usdc, monitoredEoa, monitoredEoa, 1);
      const pendingTx = scrollBridgeContract.deposit(l1Usdc, l2Usdc, monitoredEoa, monitoredEoa, 1);
      await scrollBridgeContract.finalize(l1Usdc, l2Usdc, monitoredEoa, monitoredEoa, 1);

      await adapter.updateSpokePoolClients();
      const unfinalizedTx = await pendingTx;
      const result = await adapter.getOutstandingCrossChainTransfers([l1Usdc]);

      // There should be one outstanding transfer, since there are two deposit events and one
      // finalization event
      expect(Object.keys(result).length).to.equal(2);
      expect(Object.keys(result[monitoredEoa]).length).to.equal(1);
      expect(Object.keys(result[monitoredEoa][l1Usdc])[0]).to.equal(l2Usdc);
      expect(result[monitoredEoa][l1Usdc][l2Usdc].depositTxHashes[0]).to.equal(unfinalizedTx.hash);
    });
    it("Matches L1 and L2 events, Hub -> Spoke", async function () {
      await scrollBridgeContract.deposit(l1Usdc, l2Usdc, hubPoolAddress, spokeAddress, 1);
      const pendingTx = scrollBridgeContract.deposit(l1Usdc, l2Usdc, hubPoolAddress, spokeAddress, 1);
      // Only one of the deposits were finalized.
      await scrollBridgeContract.finalize(l1Usdc, l2Usdc, hubPoolAddress, spokeAddress, 1);
      await adapter.updateSpokePoolClients();
      const unfinalizedTx = await pendingTx;
      const result = await adapter.getOutstandingCrossChainTransfers([l1Usdc]);

      // There should be one outstanding transfer, since there are two deposit events and one
      // finalization event
      // Two keys since two monitored addresses.
      expect(Object.keys(result).length).to.equal(2);
      expect(Object.keys(result[spokeAddress]).length).to.equal(1);
      expect(Object.keys(result[spokeAddress][l1Usdc])[0]).to.equal(l2Usdc);
      expect(result[spokeAddress][l1Usdc][l2Usdc].depositTxHashes[0]).to.equal(unfinalizedTx.hash);
    });
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
