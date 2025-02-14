import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { utils } from "@across-protocol/sdk";
import { SpokePoolClient } from "../../src/clients";
import { BaseChainAdapter } from "../../src/adapter/BaseChainAdapter";
import { PolygonWethBridge, PolygonERC20Bridge, UsdcTokenSplitterBridge } from "../../src/adapter/bridges";
import {
  ethers,
  expect,
  BigNumber,
  Contract,
  createSpyLogger,
  getContractFactory,
  randomAddress,
  toBN,
} from "../utils";
import { ZERO_ADDRESS } from "../constants";
import { hashCCTPSourceAndNonce, getCctpDomainForChainId } from "../../src/utils";

const { MAINNET, POLYGON } = CHAIN_IDs;
const { USDC, WETH, WBTC } = TOKEN_SYMBOLS_MAP;
const l1Weth = WETH.addresses[MAINNET];
const l1Token = WBTC.addresses[MAINNET];
const l1Usdc = USDC.addresses[MAINNET];
const l2Usdc = USDC.addresses[POLYGON];
let l2Weth, l2UsdcE, l2Token;

let l1Bridge: Contract, l2Bridge: Contract;
let l1TokenMessenger: Contract, l2MessageTransmitter: Contract;
let hubPool: Contract, spokePool: Contract;

class TestBaseChainAdapter extends BaseChainAdapter {
  public setL1Bridge(address: string, bridge: Contract) {
    this.bridges[address].l1Bridge = bridge;
  }

  public setL2Bridge(address: string, bridge: Contract) {
    this.bridges[address].l2Bridge = bridge;
  }

  public setL1CanonicalBridge(address: string, bridge: Contract) {
    this.bridges[address].canonicalBridge.l1Bridge = bridge;
  }

  public setL2CanonicalBridge(address: string, bridge: Contract) {
    this.bridges[address].canonicalBridge.l2Bridge = bridge;
  }

  public setL1UsdcBridge(address: string, bridge: Contract) {
    this.bridges[address].cctpBridge.l1Bridge = bridge;
  }

  public setL2UsdcBridge(address: string, bridge: Contract) {
    this.bridges[address].cctpBridge.l2Bridge = bridge;
  }
}

describe("Cross Chain Adapter: Polygon", async function () {
  const logger = createSpyLogger().spyLogger;

  let adapter: TestAdapter;
  let monitoredEoa: string;
  let randomEoa: string;

  let searchConfig: utils.EventSearchConfig;
  let depositAmount: BigNumber;

  beforeEach(async function () {
    const [depositor] = await ethers.getSigners();
    monitoredEoa = await depositor.getAddress();
    randomEoa = randomAddress();

    hubPool = await (await getContractFactory("MockHubPool", depositor)).deploy();

    spokePool = await (await getContractFactory("MockSpokePool", depositor)).deploy(ZERO_ADDRESS);
    const deploymentBlock = spokePool.deployTransaction.blockNumber!;

    const hubPoolClient = null;
    const l2SpokePoolClient = new SpokePoolClient(logger, spokePool, hubPoolClient, POLYGON, deploymentBlock, {
      fromBlock: deploymentBlock,
    });
    const l1SpokePoolClient = new SpokePoolClient(logger, spokePool, hubPoolClient, MAINNET, deploymentBlock, {
      fromBlock: deploymentBlock,
    });
    searchConfig = { fromBlock: deploymentBlock, toBlock: 1_000_000 };

    const l1Signer = l1SpokePoolClient.spokePool.signer;
    const l2Signer = l2SpokePoolClient.spokePool.signer;

    const bridges = {
      [WETH.addresses[MAINNET]]: new PolygonWethBridge(POLYGON, MAINNET, l1Signer, l2Signer, l1Weth),
      [USDC.addresses[MAINNET]]: new UsdcTokenSplitterBridge(POLYGON, MAINNET, l1Signer, l2Signer, l1Usdc),
      [WBTC.addresses[MAINNET]]: new PolygonERC20Bridge(POLYGON, MAINNET, l1Signer, l2Signer, l1Token),
    };

    adapter = new TestBaseChainAdapter(
      {
        [MAINNET]: l1SpokePoolClient,
        [POLYGON]: l2SpokePoolClient,
      },
      POLYGON,
      MAINNET,
      [monitoredEoa, hubPool.address, spokePool.address],
      logger,
      ["WETH", "USDC", "WBTC"],
      bridges,
      1
    );

    // Point the adapter to the proper bridges.
    l1Bridge = await (await getContractFactory("Polygon_L1Bridge", depositor)).deploy();
    l2Bridge = await (await getContractFactory("Polygon_L2Bridge", depositor)).deploy();
    l1TokenMessenger = await (await getContractFactory("CctpTokenMessenger", depositor)).deploy();
    l2MessageTransmitter = await (await getContractFactory("CctpMessageTransmitter", depositor)).deploy();
    // WBTC
    adapter.setL1Bridge(l1Token, l1Bridge);
    adapter.setL2Bridge(l1Token, l2Bridge);
    // WETH
    adapter.setL1Bridge(l1Weth, l1Bridge);
    adapter.setL2Bridge(l1Weth, l2Bridge);
    // USDC
    adapter.setL1CanonicalBridge(l1Usdc, l1Bridge);
    adapter.setL2CanonicalBridge(l1Usdc, l2Bridge);
    adapter.setL1UsdcBridge(l1Usdc, l1TokenMessenger);
    adapter.setL2UsdcBridge(l1Usdc, l2MessageTransmitter);

    depositAmount = toBN(Math.round(Math.random() * 1e18));
    l2UsdcE = adapter.bridges[l1Usdc].resolveL2TokenAddress(l1Usdc);
    l2Token = adapter.bridges[l1Token].resolveL2TokenAddress(l1Token);
    l2Weth = adapter.bridges[l1Weth].resolveL2TokenAddress(l1Weth);
  });

  describe("WETH bridge", function () {
    it("Get L1 deposits: EOA", async function () {
      await l1Bridge.depositEtherFor(monitoredEoa, monitoredEoa, depositAmount);
      await l1Bridge.depositEtherFor(randomEoa, randomEoa, depositAmount);

      const result = await adapter.bridges[l1Weth].queryL1BridgeInitiationEvents(
        l1Weth,
        monitoredEoa,
        monitoredEoa,
        searchConfig
      );
      expect(result).to.exist;
      expect(Object.keys(result).length).to.equal(1);

      const deposit = result[l2Weth];
      expect(deposit).to.exist;
      const { from, to, amount } = deposit[0];
      expect(from).to.equal(monitoredEoa);
      expect(to).to.equal(monitoredEoa);
      expect(amount).to.equal(amount);
    });

    it("Get L2 receipts: EOA", async function () {
      await l2Bridge.transfer(ZERO_ADDRESS, monitoredEoa, depositAmount);
      await l2Bridge.transfer(ZERO_ADDRESS, randomEoa, depositAmount);

      const result = await adapter.bridges[l1Weth].queryL2BridgeFinalizationEvents(
        l1Weth,
        monitoredEoa,
        monitoredEoa,
        searchConfig
      );
      expect(Object.keys(result).length).to.equal(1);

      const receipt = result[l2Weth];
      expect(receipt).to.exist;
      const { from, to, amount } = receipt[0];
      expect(from).to.equal(ZERO_ADDRESS);
      expect(to).to.equal(monitoredEoa);
      expect(amount).to.equal(amount);
    });

    it("Matches L1 and L2 events: EOA", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [hubPool.address]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });

      // Make a single l1 -> l2 deposit.
      await l1Bridge.depositEtherFor(monitoredEoa, monitoredEoa, depositAmount);
      const deposits = await adapter.bridges[l1Weth].queryL1BridgeInitiationEvents(
        l1Weth,
        monitoredEoa,
        monitoredEoa,
        searchConfig
      );
      expect(deposits).to.exist;
      expect(deposits[l2Weth].length).to.equal(1);

      let receipts = await adapter.bridges[l1Weth].queryL2BridgeFinalizationEvents(
        l1Weth,
        monitoredEoa,
        monitoredEoa,
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Weth].length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [deposits[l2Weth][0].transactionHash],
              totalAmount: deposits[l2Weth][0].amount,
            },
          },
        },
        [spokePool.address]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [hubPool.address]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Bridge.transfer(ZERO_ADDRESS, monitoredEoa, depositAmount); // Simulate WETH transfer to recipient EOA.
      receipts = await adapter.bridges[l1Weth].queryL2BridgeFinalizationEvents(
        l1Weth,
        monitoredEoa,
        monitoredEoa,
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Weth].length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [hubPool.address]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });
    });

    it("Get L1 deposits: HubPool", async function () {
      await l1Bridge.depositEtherFor(hubPool.address, spokePool.address, depositAmount);

      const result = await adapter.bridges[l1Weth].queryL1BridgeInitiationEvents(
        l1Weth,
        spokePool.address,
        spokePool.address,
        searchConfig
      );
      expect(result).to.exist;
      expect(result[l2Weth].length).to.equal(1);

      const deposit = result[l2Weth];
      expect(deposit[0]).to.exist;
      const { to, amount, from } = deposit[0];
      expect(from).to.equal(hubPool.address);
      expect(to).to.equal(spokePool.address);
      expect(amount).to.equal(depositAmount);
    });

    it("Get L2 receipts: HubPool", async function () {
      await l2Bridge.transfer(ZERO_ADDRESS, spokePool.address, depositAmount);

      const result = await adapter.bridges[l1Weth].queryL2BridgeFinalizationEvents(
        l1Weth,
        spokePool.address,
        spokePool.address,
        searchConfig
      );
      expect(result[l2Weth].length).to.equal(1);

      const receipt = result[l2Weth];
      expect(receipt).to.exist;
      const { from, to, amount } = receipt[0];
      expect(from).to.equal(ZERO_ADDRESS);
      expect(to).to.equal(spokePool.address);
      expect(amount).to.equal(depositAmount);
    });

    it("Matches L1 and L2 events: HubPool", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [hubPool.address]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });

      // Make a single l1 -> l2 deposit.
      await l1Bridge.depositEtherFor(hubPool.address, spokePool.address, depositAmount);
      const deposits = await adapter.bridges[l1Weth].queryL1BridgeInitiationEvents(
        l1Weth,
        spokePool.address,
        spokePool.address,
        searchConfig
      );
      expect(deposits).to.exist;
      expect(deposits[l2Weth].length).to.equal(1);

      let receipts = await adapter.bridges[l1Weth].queryL2BridgeFinalizationEvents(
        l1Weth,
        spokePool.address,
        spokePool.address,
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Weth].length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [deposits[l2Weth][0].transactionHash],
              totalAmount: deposits[l2Weth][0].amount,
            },
          },
        },
        [hubPool.address]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Bridge.transfer(ZERO_ADDRESS, spokePool.address, depositAmount);
      receipts = await adapter.bridges[l1Weth].queryL2BridgeFinalizationEvents(
        l1Weth,
        spokePool.address,
        spokePool.address,
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Weth].length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [hubPool.address]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });
    });
  });

  describe("ERC20 bridge", function () {
    it("Get L1 deposits: EOA", async function () {
      await l1Bridge.depositFor(monitoredEoa, monitoredEoa, l1Token, depositAmount);
      await l1Bridge.depositFor(monitoredEoa, randomEoa, l1Token, depositAmount);

      const result = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(l1Token, null, null, searchConfig);
      expect(result).to.exist;
      expect(result[l2Token].length).to.equal(2);

      // Ensure that the recipient address filters work.
      for (const recipient of [monitoredEoa, randomEoa]) {
        const result = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
          l1Token,
          monitoredEoa,
          recipient,
          searchConfig
        );
        expect(result).to.exist;
        expect(result[l2Token].length).to.equal(1);

        const deposit = result[l2Token];
        expect(deposit[0]).to.exist;
        const { from, to, rootToken } = deposit[0];
        expect(from).to.equal(monitoredEoa);
        expect(to).to.equal(recipient);
        expect(rootToken).to.equal(l1Token);
      }
    });

    it("Get L2 receipts: EOA", async function () {
      // Should return only event
      await l2Bridge.transfer(ZERO_ADDRESS, monitoredEoa, depositAmount);
      await l2Bridge.transfer(ZERO_ADDRESS, randomEoa, depositAmount);

      const result = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(l1Token, null, null, searchConfig);
      expect(result[l2Token].length).to.equal(2);

      // Ensure that the recipient address filters work.
      for (const recipient of [monitoredEoa, randomEoa]) {
        const result = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
          l1Token,
          monitoredEoa,
          recipient,
          searchConfig
        );
        expect(result).to.exist;
        expect(result[l2Token].length).to.equal(1);

        const deposit = result[l2Token];
        expect(deposit[0]).to.exist;
        const { from, to } = deposit[0];
        expect(from).to.equal(ZERO_ADDRESS);
        expect(to).to.equal(recipient);
      }
    });

    it("Matches l1 deposits and l2 receipts: EOA", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [hubPool.address]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });

      // Make a single l1 -> l2 deposit.
      await l1Bridge.depositFor(monitoredEoa, monitoredEoa, l1Token, depositAmount);
      const deposits = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(l1Token, null, null, searchConfig);
      expect(deposits).to.exist;
      expect(deposits[l2Token].length).to.equal(1);

      let receipts = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        l1Token,
        monitoredEoa,
        monitoredEoa,
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Token].length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [deposits[l2Token][0].transactionHash],
              totalAmount: deposits[l2Token][0].amount,
            },
          },
        },
        [spokePool.address]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [hubPool.address]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Bridge.transfer(ZERO_ADDRESS, monitoredEoa, depositAmount);
      receipts = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        l1Token,
        monitoredEoa,
        monitoredEoa,
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Token].length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [hubPool.address]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });
    });

    it("Get L1 deposits: HubPool", async function () {
      await l1Bridge.depositFor(hubPool.address, spokePool.address, l1Token, depositAmount);
      await l1Bridge.depositFor(randomEoa, monitoredEoa, l1Token, depositAmount);

      const result = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(l1Token, null, null, searchConfig);
      expect(result).to.exist;
      expect(result[l2Token].length).to.equal(2);

      // Ensure that the recipient address filters work.
      for (const [sender, recipient] of [
        [hubPool.address, spokePool.address],
        [randomEoa, monitoredEoa],
      ]) {
        const result = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
          l1Token,
          sender,
          recipient,
          searchConfig
        );
        expect(result).to.exist;
        expect(result[l2Token].length).to.equal(1);

        const deposit = result[l2Token];
        expect(deposit[0]).to.exist;
        const { from, to, rootToken } = deposit[0];
        expect(from).to.equal(sender);
        expect(to).to.equal(recipient);
        expect(rootToken).to.equal(l1Token);
      }
    });

    it("Get L2 receipts: HubPool", async function () {
      // Should return only event
      await l2Bridge.transfer(ZERO_ADDRESS, spokePool.address, depositAmount);
      await l2Bridge.transfer(ZERO_ADDRESS, monitoredEoa, depositAmount);

      const result = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(l1Token, null, null, searchConfig);
      expect(result[l2Token].length).to.equal(2);

      // Ensure that the recipient address filters work.
      // Note: for Polygon, bridge finalization events are always mints from the ERC20 token.
      for (const [sender, recipient] of [
        [ZERO_ADDRESS, spokePool.address],
        [ZERO_ADDRESS, monitoredEoa],
      ]) {
        const result = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
          l1Token,
          sender,
          recipient,
          searchConfig
        );
        expect(result).to.exist;
        expect(result[l2Token].length).to.equal(1);

        const deposit = result[l2Token];
        expect(deposit[0]).to.exist;
        const { from, to } = deposit[0];
        expect(from).to.equal(sender);
        expect(to).to.equal(recipient);
      }
    });

    it("Matches l1 deposits and l2 receipts: HubPool", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [hubPool.address]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });

      // Make a single l1 -> l2 deposit.
      await l1Bridge.depositFor(hubPool.address, spokePool.address, l1Token, depositAmount);
      const deposits = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(l1Token, null, null, searchConfig);
      expect(deposits).to.exist;
      expect(deposits[l2Token].length).to.equal(1);

      let receipts = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        l1Token,
        null,
        spokePool.address,
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Token].length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [deposits[l2Token][0].transactionHash],
              totalAmount: deposits[l2Token][0].amount,
            },
          },
        },
        [hubPool.address]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Bridge.transfer(ZERO_ADDRESS, spokePool.address, depositAmount);
      receipts = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        l1Token,
        null,
        spokePool.address,
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Token].length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [hubPool.address]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });
    });
  });

  describe("USDC Token Splitter Bridge", () => {
    it("Queries L1 Events: CCTP Bridge", async () => {
      const usdcTokenSplitterBridge = adapter.bridges[l1Usdc];
      const processedNonce = 1;
      const unprocessedNonce = 2;
      await l1TokenMessenger.emitDepositForBurn(
        processedNonce,
        l1Usdc,
        1,
        monitoredEoa,
        ethers.utils.hexZeroPad(monitoredEoa, 32),
        getCctpDomainForChainId(POLYGON),
        ethers.utils.hexZeroPad(l2MessageTransmitter.address, 32),
        ethers.utils.hexZeroPad(monitoredEoa, 32)
      );
      await l1TokenMessenger.emitDepositForBurn(
        unprocessedNonce,
        l1Usdc,
        1,
        monitoredEoa,
        ethers.utils.hexZeroPad(monitoredEoa, 32),
        getCctpDomainForChainId(POLYGON),
        ethers.utils.hexZeroPad(l2MessageTransmitter.address, 32),
        ethers.utils.hexZeroPad(monitoredEoa, 32)
      );
      await l2MessageTransmitter.setUsedNonce(
        hashCCTPSourceAndNonce(getCctpDomainForChainId(MAINNET), processedNonce),
        processedNonce
      );

      const events = await usdcTokenSplitterBridge.queryL1BridgeInitiationEvents(
        l1Usdc,
        monitoredEoa,
        monitoredEoa,
        searchConfig
      );
      expect(events[l2Usdc].length).to.equal(1);
      expect(events[l2UsdcE].length).to.equal(0);
      expect(events[l2Usdc][0].nonce.toString()).to.equal(unprocessedNonce.toString());
    });
    it("Queries L1 Events: Canonical Bridge", async () => {
      const usdcTokenSplitterBridge = adapter.bridges[l1Usdc];
      await l1Bridge.depositFor(monitoredEoa, monitoredEoa, l1Usdc, depositAmount);

      const events = await usdcTokenSplitterBridge.queryL1BridgeInitiationEvents(
        l1Usdc,
        monitoredEoa,
        monitoredEoa,
        searchConfig
      );
      expect(events[l2Usdc].length).to.equal(0);
      expect(events[l2UsdcE].length).to.equal(1);
      const { from, to, amount } = events[l2UsdcE][0];
      expect(from).to.equal(monitoredEoa);
      expect(to).to.equal(monitoredEoa);
      expect(amount).to.equal(depositAmount);
    });

    // L2 Query events for the UsdcCCTPBridge does not exist.
    it("Queries L2 Events: Canonical Bridge", async () => {
      const usdcTokenSplitterBridge = adapter.bridges[l1Usdc];
      await l2Bridge.transfer(ZERO_ADDRESS, monitoredEoa, depositAmount);

      const events = await usdcTokenSplitterBridge.queryL2BridgeFinalizationEvents(
        l1Usdc,
        monitoredEoa,
        monitoredEoa,
        searchConfig
      );
      expect(events[l2Usdc]).to.be.undefined;
      expect(events[l2UsdcE].length).to.equal(1);
      const { from, to, amount } = events[l2UsdcE][0];
      expect(from).to.equal(ZERO_ADDRESS);
      expect(to).to.equal(monitoredEoa);
      expect(amount).to.equal(depositAmount);
    });

    it("Determines outstanding transfers", async () => {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([l1Usdc]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Usdc]: {
            [l2Usdc]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
            [l2UsdcE]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Usdc]: {
            [l2Usdc]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
            [l2UsdcE]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [hubPool.address]: {
          [l1Usdc]: {
            [l2Usdc]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
            [l2UsdcE]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });

      // Make a single l1 -> l2 deposit via canonical bridge and via CCTP Bridge.
      const unprocessedNonce = 2;
      await l1TokenMessenger.emitDepositForBurn(
        unprocessedNonce,
        l1Usdc,
        1,
        monitoredEoa,
        ethers.utils.hexZeroPad(monitoredEoa, 32),
        getCctpDomainForChainId(POLYGON),
        ethers.utils.hexZeroPad(l2MessageTransmitter.address, 32),
        ethers.utils.hexZeroPad(monitoredEoa, 32)
      );
      await l1Bridge.depositFor(monitoredEoa, monitoredEoa, l1Usdc, depositAmount);
      const deposits = await adapter.bridges[l1Usdc].queryL1BridgeInitiationEvents(l1Usdc, null, null, searchConfig);
      expect(deposits).to.exist;
      expect(deposits[l2Usdc].length).to.equal(1);
      expect(deposits[l2UsdcE].length).to.equal(1);

      let receipts = await adapter.bridges[l1Usdc].queryL2BridgeFinalizationEvents(
        l1Usdc,
        monitoredEoa,
        monitoredEoa,
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2UsdcE].length).to.equal(0);
      expect(receipts[l2Usdc]).to.be.undefined;

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Usdc]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Usdc]: {
            [l2Usdc]: {
              depositTxHashes: [deposits[l2Usdc][0].transactionHash],
              totalAmount: deposits[l2Usdc][0].amount,
            },
            [l2UsdcE]: {
              depositTxHashes: [deposits[l2UsdcE][0].transactionHash],
              totalAmount: deposits[l2UsdcE][0].amount,
            },
          },
        },
        [spokePool.address]: {
          [l1Usdc]: {
            [l2Usdc]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
            [l2UsdcE]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [hubPool.address]: {
          [l1Usdc]: {
            [l2Usdc]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
            [l2UsdcE]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Bridge.transfer(ZERO_ADDRESS, monitoredEoa, depositAmount);
      await l2MessageTransmitter.setUsedNonce(
        hashCCTPSourceAndNonce(getCctpDomainForChainId(MAINNET), unprocessedNonce),
        unprocessedNonce
      );
      receipts = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        l1Usdc,
        monitoredEoa,
        monitoredEoa,
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2UsdcE].length).to.equal(1);
      expect(receipts[l2Usdc]).to.be.undefined;

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Usdc]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Usdc]: {
            [l2Usdc]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
            [l2UsdcE]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Usdc]: {
            [l2Usdc]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
            [l2UsdcE]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [hubPool.address]: {
          [l1Usdc]: {
            [l2Usdc]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
            [l2UsdcE]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });
    });
  });
});
