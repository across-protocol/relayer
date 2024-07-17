import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { utils } from "@across-protocol/sdk";
import { SpokePoolClient } from "../../src/clients";
import { BaseChainAdapter } from "../../src/adapter/BaseChainAdapter";
import { bnZero } from "../../src/utils";
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
import { CUSTOM_BRIDGE, CANONICAL_BRIDGE } from "../../src/common";
import * as zksync from "zksync-web3";

const { MAINNET, ZK_SYNC } = CHAIN_IDs;
const { USDC, WETH } = TOKEN_SYMBOLS_MAP;
const l1Weth = WETH.addresses[MAINNET];
const ZK_WETH = WETH.addresses[ZK_SYNC];

let l1Bridge: Contract, l2Bridge: Contract;
let l2Eth: Contract, l2Weth: Contract;
let hubPool: Contract, spokePool: Contract;

class TestBaseChainAdapter extends BaseChainAdapter {
  public setL1Bridge(address: string, bridge: Contract) {
    this.bridges[address].l1Bridge = bridge;
  }

  public setL2Bridge(address: string, bridge: Contract) {
    this.bridges[address].l2Bridge = bridge;
  }

  public setL2Eth(address: string, eth: Contract) {
    this.bridges[address].l2Eth = eth;
  }

  public setL2Weth(address: string, weth: Contract) {
    this.bridges[address].l2Weth = weth;
  }

  public setAtomicDepositor(address: string, depositor: Contract) {
    this.bridges[address].atomicDepositor = depositor;
  }
}

describe("Cross Chain Adapter: zkSync", async function () {
  const logger = createSpyLogger().spyLogger;
  const l2TxGasLimit = bnZero;
  const l2TxGasPerPubdataByte = bnZero;
  const l1Token = USDC.addresses[MAINNET];
  let atomicDepositor;

  let adapter: TestAdapter;
  let monitoredEoa: string;
  let l2Token: string;

  let searchConfig: utils.EventSearchConfig;
  let depositAmount: BigNumber;

  beforeEach(async function () {
    const [depositor] = await ethers.getSigners();
    monitoredEoa = await depositor.getAddress();

    hubPool = await (await getContractFactory("MockHubPool", depositor)).deploy();

    spokePool = await (await getContractFactory("MockSpokePool", depositor)).deploy(ZERO_ADDRESS);
    const deploymentBlock = spokePool.deployTransaction.blockNumber!;

    const hubPoolClient = null;
    const l2SpokePoolClient = new SpokePoolClient(logger, spokePool, hubPoolClient, ZK_SYNC, deploymentBlock, {
      fromBlock: deploymentBlock,
    });
    const l1SpokePoolClient = new SpokePoolClient(logger, spokePool, hubPoolClient, MAINNET, deploymentBlock, {
      fromBlock: deploymentBlock,
    });
    searchConfig = { fromBlock: deploymentBlock, toBlock: 1_000_000 };

    const bridges = {};
    const l1Signer = l1SpokePoolClient.spokePool.signer;
    const l2Signer = l2SpokePoolClient.spokePool.signer;

    ["WETH", "USDC"].map((symbol) => {
      const token = TOKEN_SYMBOLS_MAP[symbol].addresses[MAINNET];
      const bridgeConstructor = CUSTOM_BRIDGE[ZK_SYNC][token] ?? CANONICAL_BRIDGE[ZK_SYNC];

      bridges[token] = new bridgeConstructor(ZK_SYNC, MAINNET, l1Signer, l2Signer, token);
    });

    adapter = new TestBaseChainAdapter(
      {
        [MAINNET]: l1SpokePoolClient,
        [ZK_SYNC]: l2SpokePoolClient,
      },
      ZK_SYNC,
      MAINNET,
      [monitoredEoa, hubPool.address, spokePool.address],
      logger,
      ["WETH", "USDC"],
      bridges,
      1
    );

    // Point the adapter to the proper bridges.
    l1Bridge = await (await getContractFactory("zkSync_L1Bridge", depositor)).deploy();
    l2Bridge = await (await getContractFactory("zkSync_L2Bridge", depositor)).deploy();
    l2Eth = await (await getContractFactory("MockWETH9", depositor)).deploy();
    l2Weth = await (await getContractFactory("MockWETH9", depositor)).deploy();
    atomicDepositor = await (await getContractFactory("MockAtomicWethDepositor", depositor)).deploy();
    adapter.setL1Bridge(l1Token, l1Bridge);
    adapter.setL2Bridge(l1Token, l2Bridge);
    adapter.setL2Eth(l1Weth, l2Eth);
    adapter.setL2Weth(l1Weth, l2Weth);
    adapter.setAtomicDepositor(l1Weth, atomicDepositor);

    depositAmount = toBN(Math.round(Math.random() * 1e18));
    l2Token = adapter.bridges[l1Token].resolveL2TokenAddress(l1Token);
  });

  describe("WETH bridge", function () {
    it("Get L1 deposits: EOA", async function () {
      await atomicDepositor.bridgeWethToZkSync(monitoredEoa, depositAmount, 0, 0, ZERO_ADDRESS);

      const result = await adapter.bridges[l1Weth].queryL1BridgeInitiationEvents(
        l1Weth,
        monitoredEoa,
        monitoredEoa,
        searchConfig
      );
      expect(result).to.exist;
      expect(Object.keys(result).length).to.equal(1);

      const deposit = result[ZK_WETH];
      expect(deposit).to.exist;
      const { from, to, amount } = deposit[0];
      expect(from).to.equal(monitoredEoa);
      expect(to).to.equal(monitoredEoa);
      expect(amount).to.equal(amount);
    });

    it("Get L2 receipts: EOA", async function () {
      const aliasedAtomicDepositor = zksync.utils.applyL1ToL2Alias(atomicDepositor);
      await l2Eth.transfer(aliasedAtomicDepositor, monitoredEoa, depositAmount);
      await l2Weth.transfer(ZERO_ADDRESS, monitoredEoa, depositAmount);

      const result = await adapter.bridges[l1Weth].queryL2BridgeFinalizationEvents(
        l1Weth,
        monitoredEoa,
        null,
        searchConfig
      );
      expect(Object.keys(result).length).to.equal(1);

      const receipt = result[ZK_WETH];
      expect(receipt).to.exist;
      const { from, to, amount } = receipt[0];
      expect(from).to.equal(aliasedAtomicDepositor);
      expect(to).to.equal(monitoredEoa);
      expect(amount).to.equal(amount);
    });

    it("Matches L1 and L2 events: EOA", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers[monitoredEoa][l1Weth][ZK_WETH].depositTxHashes).to.deep.equal([]);
      expect(transfers[spokePool.address][l1Weth][ZK_WETH].depositTxHashes).to.deep.equal([]);
      expect(transfers[hubPool.address][l1Weth][ZK_WETH].depositTxHashes).to.deep.equal([]);

      // Make a single l1 -> l2 deposit.
      await atomicDepositor.bridgeWethToZkSync(monitoredEoa, depositAmount, 0, 0, ZERO_ADDRESS);
      const deposits = await adapter.bridges[l1Weth].queryL1BridgeInitiationEvents(
        l1Weth,
        null,
        monitoredEoa,
        searchConfig
      );
      expect(deposits).to.exist;
      expect(deposits[ZK_WETH].length).to.equal(1);

      let receipts = await adapter.bridges[l1Weth].queryL2BridgeFinalizationEvents(
        l1Weth,
        null,
        monitoredEoa,
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[ZK_WETH].length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [ZK_WETH]: {
              depositTxHashes: [deposits[ZK_WETH][0].transactionHash],
              totalAmount: deposits[ZK_WETH][0].amount,
            },
          },
        },
        [spokePool.address]: {
          [l1Weth]: {
            [ZK_WETH]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [hubPool.address]: {
          [l1Weth]: {
            [ZK_WETH]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Eth.transfer(zksync.utils.applyL1ToL2Alias(atomicDepositor), monitoredEoa, depositAmount); // Simulate ETH transfer to recipient EOA.
      await l2Weth.transfer(ZERO_ADDRESS, monitoredEoa, depositAmount); // Simulate subsequent WETH deposit.
      receipts = await adapter.bridges[l1Weth].queryL2BridgeFinalizationEvents(
        l1Weth,
        null,
        monitoredEoa,
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts.length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({ [monitoredEoa]: {}, [spokePool.address]: {} });
    });

    it("Get L1 deposits: HubPool", async function () {
      await hubPool.relayTokens(l1Weth, l2Weth.address, depositAmount, spokePool.address);

      const result = await adapter.queryL1BridgeInitiationEvents(l1Weth, null, spokePool.address, searchConfig);
      expect(result).to.exist;
      expect(result.length).to.equal(1);

      const deposit = result.at(0)!;
      expect(deposit.args).to.exist;
      const { to, amount: _amount } = deposit.args!;
      expect(to).to.equal(spokePool.address);
      expect(_amount).to.equal(depositAmount);
    });

    it("Get L2 receipts: HubPool", async function () {
      await l2Eth.transfer(adapter.getAddressAlias(hubPool.address), spokePool.address, depositAmount);

      const result = await adapter.queryL2BridgeFinalizationEvents(l1Weth, null, spokePool.address, searchConfig);
      expect(result.length).to.equal(1);

      const receipt = result.at(0)!;
      expect(receipt.args).to.exist;
      const { from, to, amount: _amount } = receipt.args!;
      expect(from).to.equal(adapter.getAddressAlias(hubPool.address));
      expect(to).to.equal(spokePool.address);
      expect(_amount).to.equal(depositAmount);
    });

    it("Matches L1 and L2 events: HubPool", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({ [monitoredEoa]: {}, [spokePool.address]: {} });

      // Make a single l1 -> l2 deposit.
      await hubPool.relayTokens(l1Weth, l2Weth.address, depositaAmount, spokePool.address);
      const deposits = await adapter.queryL1BridgeInitiationEvents(l1Weth, null, spokePool.address, searchConfig);
      expect(deposits).to.exist;
      expect(deposits.length).to.equal(1);

      let receipts = await adapter.queryL2BridgeFinalizationEvents(l1Weth, null, spokePool.address, searchConfig);
      expect(receipts).to.exist;
      expect(receipts.length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {},
        [spokePool.address]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [deposits[0].transactionHash],
              totalAmount: deposits[0].args!.amount,
            },
          },
        },
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Eth.transfer(adapter.getAddressAlias(hubPool.address), spokePool.address, depositAmount);
      receipts = await adapter.queryL2BridgeFinalizationEvents(l1Weth, null, spokePool.address, searchConfig);
      expect(receipts).to.exist;
      expect(receipts.length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({ [monitoredEoa]: {}, [spokePool.address]: {} });
    });

    it("Correctly makes l1 deposits", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({ [monitoredEoa]: {}, [spokePool.address]: {} });

      // Make a single l1 -> l2 deposit via the chaina adapter.
      await adapter.sendTokenToTargetChain(monitoredEoa, l1Weth, l2Token, depositAmount);
      const deposits = await adapter.queryL1BridgeInitiationEvents(l1Weth, null, monitoredEoa, searchConfig);
      expect(deposits).to.exist;
      expect(deposits.length).to.equal(1);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [deposits[0].transactionHash],
              totalAmount: deposits[0].args!.amount,
            },
          },
        },
        [spokePool.address]: {},
      });
    });
  });

  describe("ERC20 bridge", function () {
    let randomEoa: string;
    beforeEach(async function () {
      randomEoa = randomAddress();
      await l2Bridge.mapToken(l1Token, l2Token);
    });

    it("Get L1 deposits: EOA", async function () {
      await l1Bridge.deposit(monitoredEoa, l1Token, depositAmount, l2TxGasLimit, l2TxGasPerPubdataByte);
      await l1Bridge.deposit(randomEoa, l1Token, depositAmount, l2TxGasLimit, l2TxGasPerPubdataByte);

      const result = await adapter.queryL1BridgeInitiationEvents(l1Token, null, null, searchConfig);
      expect(result).to.exist;
      expect(result.length).to.equal(2);

      // Ensure that the recipient address filters work.
      for (const recipient of [monitoredEoa, randomEoa]) {
        const result = await adapter.queryL1BridgeInitiationEvents(l1Token, monitoredEoa, recipient, searchConfig);
        expect(result).to.exist;
        expect(result.length).to.equal(1);

        const deposit = result.at(0)!;
        expect(deposit.args).to.exist;
        const { from, to, l1Token: _l1Token } = deposit.args!;
        expect(from).to.equal(monitoredEoa);
        expect(to).to.equal(recipient);
        expect(_l1Token).to.equal(l1Token);
      }
    });

    it("Get L2 receipts: EOA", async function () {
      // Should return only event
      await l2Bridge.finalizeDeposit(monitoredEoa, monitoredEoa, l1Token, depositAmount);
      await l2Bridge.finalizeDeposit(monitoredEoa, randomEoa, l1Token, depositAmount);

      const result = await adapter.queryL2BridgeFinalizationEvents(l1Token, null, null, searchConfig);
      expect(result.length).to.equal(2);

      // Ensure that the recipient address filters work.
      for (const recipient of [monitoredEoa, randomEoa]) {
        const result = await adapter.queryL2BridgeFinalizationEvents(l1Token, monitoredEoa, recipient, searchConfig);
        expect(result).to.exist;
        expect(result.length).to.equal(1);

        const deposit = result.at(0)!;
        expect(deposit.args).to.exist;
        const { l1Sender, l2Receiver, l2Token: _l2Token } = deposit.args!;
        expect(l1Sender).to.equal(monitoredEoa);
        expect(l2Receiver).to.equal(recipient);
        expect(_l2Token).to.equal(l2Token);
      }
    });

    it("Matches l1 deposits and l2 receipts: EOA", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      expect(transfers).to.deep.equal({ [monitoredEoa]: {}, [spokePool.address]: {} });

      // Make a single l1 -> l2 deposit.
      await l1Bridge.deposit(monitoredEoa, l1Token, amount, l2TxGasLimit, l2TxGasPerPubdataByte);
      const deposits = await adapter.queryL1BridgeInitiationEvents(l1Token, null, null, searchConfig);
      expect(deposits).to.exist;
      expect(deposits.length).to.equal(1);

      let receipts = await adapter.queryL2BridgeFinalizationEvents(l1Token, monitoredEoa, monitoredEoa, searchConfig);
      expect(receipts).to.exist;
      expect(receipts.length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [deposits[0].transactionHash],
              totalAmount: deposits[0].args!.amount,
            },
          },
        },
        [spokePool.address]: {},
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Bridge.finalizeDeposit(monitoredEoa, monitoredEoa, l1Token, depositAmount);
      receipts = await adapter.queryL2BridgeFinalizationEvents(l1Token, monitoredEoa, monitoredEoa, searchConfig);
      expect(receipts).to.exist;
      expect(receipts.length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      expect(transfers).to.deep.equal({ [monitoredEoa]: {}, [spokePool.address]: {} });
    });

    it("Get L1 deposits: HubPool", async function () {
      await l1Bridge.depositFor(
        hubPool.address,
        spokePool.address,
        l1Token,
        depositAmount,
        l2TxGasLimit,
        l2TxGasPerPubdataByte
      );
      await l1Bridge.depositFor(randomEoa, monitoredEoa, l1Token, depositAmount, l2TxGasLimit, l2TxGasPerPubdataByte);

      const result = await adapter.queryL1BridgeInitiationEvents(l1Token, null, null, searchConfig);
      expect(result).to.exist;
      expect(result.length).to.equal(2);

      // Ensure that the recipient address filters work.
      for (const [sender, recipient] of [
        [hubPool.address, spokePool.address],
        [randomEoa, monitoredEoa],
      ]) {
        const result = await adapter.queryL1BridgeInitiationEvents(l1Token, sender, recipient, searchConfig);
        expect(result).to.exist;
        expect(result.length).to.equal(1);

        const deposit = result.at(0)!;
        expect(deposit.args).to.exist;
        const { from, to, l1Token: _l1Token } = deposit.args!;
        expect(from).to.equal(sender);
        expect(to).to.equal(recipient);
        expect(_l1Token).to.equal(l1Token);
      }
    });

    it("Get L2 receipts: HubPool", async function () {
      // Should return only event
      await l2Bridge.finalizeDeposit(hubPool.address, spokePool.address, l1Token, depositAmount);
      await l2Bridge.finalizeDeposit(randomEoa, monitoredEoa, l1Token, depositAmount);

      const result = await adapter.queryL2BridgeFinalizationEvents(l1Token, null, null, searchConfig);
      expect(result.length).to.equal(2);

      // Ensure that the recipient address filters work.
      for (const [sender, recipient] of [
        [hubPool.address, spokePool.address],
        [randomEoa, monitoredEoa],
      ]) {
        const result = await adapter.queryL2BridgeFinalizationEvents(l1Token, sender, recipient, searchConfig);
        expect(result).to.exist;
        expect(result.length).to.equal(1);

        const deposit = result.at(0)!;
        expect(deposit.args).to.exist;
        const { l1Sender, l2Receiver, l2Token: _l2Token } = deposit.args!;
        expect(l1Sender).to.equal(sender);
        expect(l2Receiver).to.equal(recipient);
        expect(_l2Token).to.equal(l2Token);
      }
    });

    it("Matches l1 deposits and l2 receipts: HubPool", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      expect(transfers).to.deep.equal({ [monitoredEoa]: {}, [spokePool.address]: {} });

      // Make a single l1 -> l2 deposit.
      await l1Bridge.depositFor(
        hubPool.address,
        spokePool.address,
        l1Token,
        depositAmount,
        l2TxGasLimit,
        l2TxGasPerPubdataByte
      );
      const deposits = await adapter.queryL1BridgeInitiationEvents(l1Token, null, null, searchConfig);
      expect(deposits).to.exist;
      expect(deposits.length).to.equal(1);

      let receipts = await adapter.queryL2BridgeFinalizationEvents(l1Token, null, spokePool.address, searchConfig);
      expect(receipts).to.exist;
      expect(receipts.length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {},
        [spokePool.address]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [deposits[0].transactionHash],
              totalAmount: deposits[0].args!.amount,
            },
          },
        },
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Bridge.finalizeDeposit(hubPool.address, spokePool.address, l1Token, depositAmount);
      receipts = await adapter.queryL2BridgeFinalizationEvents(l1Token, null, spokePool.address, searchConfig);
      expect(receipts).to.exist;
      expect(receipts.length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      expect(transfers).to.deep.equal({ [monitoredEoa]: {}, [spokePool.address]: {} });
    });

    it("Correctly makes l1 deposits", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      expect(transfers).to.deep.equal({ [monitoredEoa]: {}, [spokePool.address]: {} });

      // Make a single l1 -> l2 deposit via the chaina adapter.
      await adapter.sendTokenToTargetChain(monitoredEoa, l1Token, l2Token, depositAmount);
      const deposits = await adapter.queryL1BridgeInitiationEvents(l1Token, null, null, searchConfig);
      expect(deposits).to.exist;
      expect(deposits.length).to.equal(1);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [deposits[0].transactionHash],
              totalAmount: deposits[0].args!.amount,
            },
          },
        },
        [spokePool.address]: {},
      });
    });
  });
});
