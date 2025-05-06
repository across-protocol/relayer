import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { utils } from "@across-protocol/sdk";
import { SpokePoolClient } from "../../src/clients";
import { BaseChainAdapter } from "../../src/adapter/BaseChainAdapter";
import { ZKStackUSDCBridge, ZKStackWethBridge, ZKStackBridge } from "../../src/adapter/bridges";
import { bnZero, EvmAddress } from "../../src/utils";
import {
  ethers,
  expect,
  BigNumber,
  createSpyLogger,
  getContractFactory,
  randomAddress,
  toBN,
  Contract,
} from "../utils";
import { ZERO_ADDRESS } from "../constants";
import * as zksync from "zksync-ethers";

const { LENS, MAINNET, ZK_SYNC } = CHAIN_IDs;
const { DAI, USDC, WETH } = TOKEN_SYMBOLS_MAP;
const l1Weth = WETH.addresses[MAINNET];

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

  public setL1USDCBridge(address: string, bridge: Contract) {
    this.bridges[address].usdcBridge = bridge;
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

  public setHubPool(address: string, hubPool: Contract) {
    this.bridges[address].hubPool = hubPool;
  }

  public setSharedBridge(address: string, bridge: Contract) {
    this.bridges[address].sharedBridge = bridge;
  }

  public setNativeTokenVault(address: string, bridge: Contract) {
    this.bridges[address].nativeTokenVault = bridge;
  }
}

class TestZkSyncWethBridge extends ZKStackWethBridge {
  private hubPool;

  override getHubPool() {
    return this.hubPool;
  }

  override resolveL2TokenAddress(l1Token: EvmAddress) {
    return l1Token.toAddress() === l1Weth ? l2Weth.address : super.resolveL2TokenAddress(l1Token);
  }

  public setHubPool(hubPool: Contract) {
    this.hubPool = hubPool;
  }

  protected override _txBaseCost(provider: Provider, l2GasLimit: BigNumber, gasPerPubdataLimit: number) {
    // None of these are used; just satisfy the linter.
    provider;
    l2GasLimit;
    gasPerPubdataLimit;
    return BigNumber.from(2000000);
  }
}

class TestZkSyncBridge extends ZKStackBridge {
  protected override _txBaseCost(provider: Provider, l2GasLimit: BigNumber, gasPerPubdataLimit: number) {
    // None of these are used; just satisfy the linter.
    provider;
    l2GasLimit;
    gasPerPubdataLimit;
    return BigNumber.from(2000000);
  }
}

class TestZkSyncUSDCBridge extends ZKStackUSDCBridge {
  protected override _txBaseCost(provider: Provider, l2GasLimit: BigNumber, gasPerPubdataLimit: number) {
    // None of these are used; just satisfy the linter.
    provider;
    l2GasLimit;
    gasPerPubdataLimit;
    return BigNumber.from(2000000);
  }
}

describe("Cross Chain Adapter: zkSync", async function () {
  const logger = createSpyLogger().spyLogger;
  const l2TxGasLimit = bnZero;
  const l2TxGasPerPubdataByte = bnZero;
  const l1Token = DAI.addresses[MAINNET];
  let atomicDepositor;

  let adapter: TestBaseChainAdapter;
  let monitoredEoa: string;
  let l2Token: string;

  let searchConfig: utils.EventSearchConfig;
  let depositAmount: BigNumber;

  const toAddress = (address: string): EvmAddress => {
    return EvmAddress.from(address);
  };
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

    const l1Signer = l1SpokePoolClient.spokePool.signer;
    const l2Signer = l2SpokePoolClient.spokePool.signer;

    const bridges = {
      [WETH.addresses[MAINNET]]: new TestZkSyncWethBridge(ZK_SYNC, MAINNET, l1Signer, l2Signer, undefined),
      [DAI.addresses[MAINNET]]: new TestZkSyncBridge(ZK_SYNC, MAINNET, l1Signer, l2Signer, undefined),
    };
    bridges[WETH.addresses[MAINNET]].setHubPool(hubPool);

    adapter = new TestBaseChainAdapter(
      {
        [MAINNET]: l1SpokePoolClient,
        [ZK_SYNC]: l2SpokePoolClient,
      },
      ZK_SYNC,
      MAINNET,
      [toAddress(monitoredEoa), toAddress(hubPool.address), toAddress(spokePool.address)],
      logger,
      ["DAI", "WETH"],
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
    adapter.setSharedBridge(l1Token, l1Bridge);
    adapter.setNativeTokenVault(l1Token, l1Bridge);
    adapter.setL2Bridge(l1Token, l2Bridge);
    adapter.setL2Eth(l1Weth, l2Eth);
    adapter.setL2Weth(l1Weth, l2Weth);
    adapter.setAtomicDepositor(l1Weth, atomicDepositor);
    adapter.setHubPool(l1Token, hubPool);

    depositAmount = toBN(Math.round(Math.random() * 1e18));
    l2Token = adapter.bridges[l1Token].resolveL2TokenAddress(toAddress(l1Token));
  });

  describe("WETH bridge", function () {
    it("Get L1 deposits: EOA", async function () {
      // await adapter.sendTokenToTargetChain(monitoredEoa, WETH.addresses[MAINNET], l2Weth.address, depositAmount, false);
      await atomicDepositor.bridgeWeth(ZK_SYNC, depositAmount, depositAmount, bnZero, "0x");

      const result = await adapter.bridges[l1Weth].queryL1BridgeInitiationEvents(
        toAddress(l1Weth),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(result).to.exist;
      expect(Object.keys(result).length).to.equal(1);

      const deposit = result[l2Weth.address];
      expect(deposit).to.exist;
      const { amount } = deposit[0];
      expect(amount).to.equal(amount);
    });

    it("Get L2 receipts: EOA", async function () {
      const aliasedAtomicDepositor = ethers.utils.getAddress(zksync.utils.applyL1ToL2Alias(atomicDepositor.address));
      await l2Eth.transfer(aliasedAtomicDepositor, monitoredEoa, depositAmount);
      await l2Weth.transfer(ZERO_ADDRESS, monitoredEoa, depositAmount);

      const result = await adapter.bridges[l1Weth].queryL2BridgeFinalizationEvents(
        toAddress(l1Weth),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(Object.keys(result).length).to.equal(1);

      const receipt = result[l2Weth.address];
      expect(receipt).to.exist;
      const { amount } = receipt[0];
      expect(amount).to.equal(amount);
    });

    // We only require two values in `transfers` for this test **because we do not trigger any hub pool events**
    // See https://github.com/across-protocol/relayer/blob/f42853e28747010111941073e54d3d9d8a3f3a09/src/clients/bridges/ZKSyncAdapter.ts#L72
    it("Matches L1 and L2 events: EOA", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Weth)]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });

      // Make a single l1 -> l2 deposit.
      await atomicDepositor.bridgeWeth(ZK_SYNC, depositAmount, depositAmount, bnZero, "0x");
      const deposits = await adapter.bridges[l1Weth].queryL1BridgeInitiationEvents(
        toAddress(l1Weth),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(deposits).to.exist;
      expect(deposits[l2Weth.address].length).to.equal(1);

      let receipts = await adapter.bridges[l1Weth].queryL2BridgeFinalizationEvents(
        toAddress(l1Weth),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Weth.address].length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Weth)]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [deposits[l2Weth.address][0].txnRef],
              totalAmount: deposits[l2Weth.address][0].amount,
            },
          },
        },
        [spokePool.address]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Eth.transfer(zksync.utils.applyL1ToL2Alias(atomicDepositor.address), monitoredEoa, depositAmount); // Simulate ETH transfer to recipient EOA.
      await l2Weth.transfer(ZERO_ADDRESS, monitoredEoa, depositAmount); // Simulate subsequent WETH deposit.
      receipts = await adapter.bridges[l1Weth].queryL2BridgeFinalizationEvents(
        toAddress(l1Weth),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Weth.address].length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Weth)]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });
    });

    it("Get L1 deposits: HubPool", async function () {
      await hubPool.relayTokens(l1Weth, l2Weth.address, depositAmount, spokePool.address);

      const result = await adapter.bridges[l1Weth].queryL1BridgeInitiationEvents(
        toAddress(l1Weth),
        toAddress(spokePool.address),
        toAddress(spokePool.address),
        searchConfig
      );
      expect(result).to.exist;
      expect(result[l2Weth.address].length).to.equal(1);

      const deposit = result[l2Weth.address];
      expect(deposit[0]).to.exist;
      const { amount } = deposit[0];
      expect(amount).to.equal(depositAmount);
    });

    it("Get L2 receipts: HubPool", async function () {
      const aliasedHubPool = ethers.utils.getAddress(zksync.utils.applyL1ToL2Alias(hubPool.address));
      await l2Eth.transfer(aliasedHubPool, spokePool.address, depositAmount);

      const result = await adapter.bridges[l1Weth].queryL2BridgeFinalizationEvents(
        toAddress(l1Weth),
        toAddress(spokePool.address),
        toAddress(spokePool.address),
        searchConfig
      );
      expect(result[l2Weth.address].length).to.equal(1);

      const receipt = result[l2Weth.address];
      expect(receipt).to.exist;
      const { amount } = receipt[0];
      expect(amount).to.equal(depositAmount);
    });

    it("Matches L1 and L2 events: HubPool", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Weth)]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });

      // Make a single l1 -> l2 deposit.
      await hubPool.relayTokens(l1Weth, l2Weth.address, depositAmount, spokePool.address);
      const deposits = await adapter.bridges[l1Weth].queryL1BridgeInitiationEvents(
        toAddress(l1Weth),
        toAddress(spokePool.address),
        toAddress(spokePool.address),
        searchConfig
      );
      expect(deposits).to.exist;
      expect(deposits[l2Weth.address].length).to.equal(1);

      let receipts = await adapter.bridges[l1Weth].queryL2BridgeFinalizationEvents(
        toAddress(l1Weth),
        toAddress(spokePool.address),
        toAddress(spokePool.address),
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Weth.address].length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Weth)]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [deposits[l2Weth.address][0].txnRef],
              totalAmount: deposits[l2Weth.address][0].amount,
            },
          },
        },
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Eth.transfer(zksync.utils.applyL1ToL2Alias(hubPool.address), spokePool.address, depositAmount);
      receipts = await adapter.bridges[l1Weth].queryL2BridgeFinalizationEvents(
        toAddress(l1Weth),
        toAddress(spokePool.address),
        toAddress(spokePool.address),
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Weth.address].length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Weth)]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });
    });

    it("Correctly makes l1 deposits", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Weth)]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
        [spokePool.address]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
      });

      // Make a single l1 -> l2 deposit via the chaina adapter.
      await adapter.sendTokenToTargetChain(
        toAddress(monitoredEoa),
        toAddress(l1Weth),
        toAddress(l2Token),
        depositAmount
      );
      const deposits = await adapter.bridges[l1Weth].queryL1BridgeInitiationEvents(
        toAddress(l1Weth),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(deposits).to.exist;
      expect(deposits[l2Weth.address].length).to.equal(1);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Weth)]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [deposits[l2Weth.address][0].txnRef],
              totalAmount: deposits[l2Weth.address][0].amount,
            },
          },
        },
        [spokePool.address]: {
          [l1Weth]: {
            [l2Weth.address]: {
              depositTxHashes: [],
              totalAmount: BigNumber.from(0),
            },
          },
        },
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

      const result = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
        toAddress(l1Token),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(result).to.exist;
      expect(result[l2Token].length).to.equal(1);

      // Ensure that the recipient address filters work.
      for (const recipient of [monitoredEoa, randomEoa]) {
        const result = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
          toAddress(l1Token),
          toAddress(monitoredEoa),
          toAddress(recipient),
          searchConfig
        );
        expect(result).to.exist;
        expect(result[l2Token].length).to.equal(1);

        const deposit = result[l2Token];
        expect(deposit[0]).to.exist;
        const { assetId: _assetId } = deposit[0];

        // The event no longer has l1Token as a field.
        const assetId = await l1Bridge.assetId(l1Token);
        expect(_assetId).to.equal(assetId);
      }
    });

    it("Get L2 receipts: EOA", async function () {
      // Should return only event
      await l2Bridge.finalizeDeposit(MAINNET, monitoredEoa, l1Token, depositAmount);
      await l2Bridge.finalizeDeposit(MAINNET, randomEoa, l1Token, depositAmount);

      const result = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        toAddress(l1Token),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(result[l2Token].length).to.equal(1);

      // Ensure that the recipient address filters work.
      for (const recipient of [monitoredEoa, randomEoa]) {
        const result = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
          toAddress(l1Token),
          toAddress(monitoredEoa),
          toAddress(recipient),
          searchConfig
        );
        expect(result).to.exist;
        expect(result[l2Token].length).to.equal(1);

        const deposit = result[l2Token];
        expect(deposit[0]).to.exist;
        const { assetId: _assetId } = deposit[0];

        const assetId = await l2Bridge.assetId(l2Token);
        expect(_assetId).to.equal(assetId);
      }
    });

    it("Matches l1 deposits and l2 receipts: EOA", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
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
              totalAmount: bnZero,
            },
          },
        },
      });

      // Make a single l1 -> l2 deposit.
      await l1Bridge.deposit(monitoredEoa, l1Token, depositAmount, l2TxGasLimit, l2TxGasPerPubdataByte);
      const deposits = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
        toAddress(l1Token),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(deposits).to.exist;
      expect(deposits[l2Token].length).to.equal(1);

      let receipts = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        toAddress(l1Token),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Token].length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [deposits[l2Token][0].txnRef],
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
              totalAmount: bnZero,
            },
          },
        },
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Bridge.finalizeDeposit(MAINNET, monitoredEoa, l1Token, depositAmount);
      receipts = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        toAddress(l1Token),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Token].length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
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
              totalAmount: bnZero,
            },
          },
        },
      });
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

      const result = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
        toAddress(l1Token),
        toAddress(spokePool.address),
        toAddress(spokePool.address),
        searchConfig
      );
      expect(result).to.exist;
      expect(result[l2Token].length).to.equal(1);

      // Ensure that the recipient address filters work.
      for (const [sender, recipient] of [
        [hubPool.address, spokePool.address],
        [randomEoa, monitoredEoa],
      ]) {
        const result = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
          toAddress(l1Token),
          toAddress(sender),
          toAddress(recipient),
          searchConfig
        );
        expect(result).to.exist;
        expect(result[l2Token].length).to.equal(1);

        const deposit = result[l2Token];
        expect(deposit[0]).to.exist;
        const { assetId: _assetId } = deposit[0];

        const assetId = await l1Bridge.assetId(l1Token);
        expect(_assetId).to.equal(assetId);
      }
    });

    it("Get L2 receipts: HubPool", async function () {
      // Should return only event
      await l2Bridge.finalizeDeposit(MAINNET, spokePool.address, l1Token, depositAmount);
      await l2Bridge.finalizeDeposit(MAINNET, monitoredEoa, l1Token, depositAmount);

      const result = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        toAddress(l1Token),
        toAddress(spokePool.address),
        toAddress(spokePool.address),
        searchConfig
      );
      expect(result[l2Token].length).to.equal(1);

      // Ensure that the recipient address filters work.
      for (const [sender, recipient] of [
        [hubPool.address, spokePool.address],
        [monitoredEoa, monitoredEoa],
      ]) {
        const result = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
          toAddress(l1Token),
          toAddress(sender),
          toAddress(recipient),
          searchConfig
        );
        expect(result).to.exist;
        expect(result[l2Token].length).to.equal(1);

        const deposit = result[l2Token];
        expect(deposit[0]).to.exist;
        const { assetId: _assetId } = deposit[0];

        const assetId = await l2Bridge.assetId(l2Token);
        expect(_assetId).to.equal(assetId);
      }
    });

    it("Matches l1 deposits and l2 receipts: HubPool", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
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
              totalAmount: bnZero,
            },
          },
        },
      });

      // Make a single l1 -> l2 deposit.
      await l1Bridge.depositFor(
        hubPool.address,
        spokePool.address,
        l1Token,
        depositAmount,
        l2TxGasLimit,
        l2TxGasPerPubdataByte
      );
      const deposits = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
        toAddress(l1Token),
        toAddress(spokePool.address),
        toAddress(spokePool.address),
        searchConfig
      );
      expect(deposits).to.exist;
      expect(deposits[l2Token].length).to.equal(1);

      let receipts = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        toAddress(l1Token),
        null,
        toAddress(spokePool.address),
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Token].length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
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
              depositTxHashes: [deposits[l2Token][0].txnRef],
              totalAmount: deposits[l2Token][0].amount,
            },
          },
        },
        [hubPool.address]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: bnZero,
            },
          },
        },
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Bridge.finalizeDeposit(MAINNET, spokePool.address, l1Token, depositAmount);
      receipts = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        toAddress(l1Token),
        null,
        toAddress(spokePool.address),
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Token].length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
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
              totalAmount: bnZero,
            },
          },
        },
      });
    });

    it("Correctly makes l1 deposits", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
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
              totalAmount: bnZero,
            },
          },
        },
      });

      // Make a single l1 -> l2 deposit via the chain adapter.
      await adapter.sendTokenToTargetChain(
        toAddress(monitoredEoa),
        toAddress(l1Token),
        toAddress(l2Token),
        depositAmount,
        false
      );
      const deposits = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
        toAddress(l1Token),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(deposits).to.exist;
      expect(deposits[l2Token].length).to.equal(1);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [deposits[l2Token][0].txnRef],
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
              totalAmount: bnZero,
            },
          },
        },
      });
    });
  });

  describe("USDC bridge", async function () {
    let randomEoa: string;
    const l1Token = USDC.addresses[MAINNET];
    const l2Token = USDC.addresses[LENS];

    const deposit = async (to: string, amount: BigNumber) => {
      const secondBridge = randomAddress();
      const secondBridgeCalldata = ethers.utils.defaultAbiCoder.encode(
        ["address", "uint256", "address"],
        [l1Token, amount, to]
      );

      const args = [LENS, 0, 0, l2TxGasLimit, l2TxGasPerPubdataByte, to, secondBridge, 0, secondBridgeCalldata];
      return l1Bridge.requestL2TransactionTwoBridges(args);
    };

    beforeEach(async function () {
      randomEoa = randomAddress();
      await l1Bridge.setUSDC(l1Token);
      await l2Bridge.mapToken(l1Token, l2Token);
      await l2Bridge.setUSDC(l2Token);

      const hubPoolClient = null;
      const deploymentBlock = spokePool.deployTransaction.blockNumber!;
      const lensSpokePoolClient = new SpokePoolClient(logger, spokePool, hubPoolClient, LENS, deploymentBlock, {
        fromBlock: deploymentBlock,
      });

      const l1Signer = adapter.spokePoolClients[MAINNET].spokePool.signer;
      const l2Signer = lensSpokePoolClient.spokePool.signer;

      adapter = new TestBaseChainAdapter(
        { ...adapter.spokePoolClients, [LENS]: lensSpokePoolClient },
        LENS,
        MAINNET,
        [toAddress(monitoredEoa), toAddress(hubPool.address), toAddress(spokePool.address)],
        logger,
        ["USDC"],
        { [USDC.addresses[MAINNET]]: new TestZkSyncUSDCBridge(LENS, MAINNET, l1Signer, l2Signer, undefined) },
        1
      );

      adapter.setL1Bridge(l1Token, l1Bridge);
      adapter.setSharedBridge(l1Token, l1Bridge);
      adapter.setL1USDCBridge(l1Token, l1Bridge);
      adapter.setL2Bridge(l1Token, l2Bridge);
    });

    it("Get L1 deposits: EOA", async function () {
      await deposit(monitoredEoa, depositAmount);
      await deposit(randomEoa, depositAmount);

      const result = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
        toAddress(l1Token),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(result).to.exist;
      expect(result[l2Token].length).to.equal(1);

      // Ensure that the recipient address filters work.
      for (const recipient of [monitoredEoa, randomEoa]) {
        const result = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
          toAddress(l1Token),
          toAddress(monitoredEoa),
          toAddress(recipient),
          searchConfig
        );
        expect(result).to.exist;
        expect(result[l2Token].length).to.equal(1);

        const [deposit] = result[l2Token];
        expect(deposit).to.exist;
        const { from, to, amount } = deposit;
        expect(from).to.equal(monitoredEoa);
        expect(to).to.equal(recipient);
        expect(amount.eq(depositAmount)).to.be.true;
      }
    });

    it("Get L2 receipts: EOA", async function () {
      // Should return only event
      await l2Bridge.finalizeDeposit(MAINNET, monitoredEoa, l1Token, depositAmount);
      await l2Bridge.finalizeDeposit(MAINNET, randomEoa, l1Token, depositAmount);

      const result = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        toAddress(l1Token),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(result[l2Token].length).to.equal(1);

      // Ensure that the recipient address filters work.
      for (const recipient of [monitoredEoa, randomEoa]) {
        const result = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
          toAddress(l1Token),
          toAddress(monitoredEoa),
          toAddress(recipient),
          searchConfig
        );
        expect(result).to.exist;
        expect(result[l2Token].length).to.equal(1);

        const [deposit] = result[l2Token];
        expect(deposit).to.exist;
        const { to, amount } = deposit;
        expect(to).to.equal(recipient);
        expect(amount.eq(depositAmount)).to.be.true;
      }
    });

    it("Matches l1 deposits and l2 receipts: EOA", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
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
              totalAmount: bnZero,
            },
          },
        },
      });

      // Make a single l1 -> l2 deposit.
      await deposit(monitoredEoa, depositAmount);
      const deposits = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
        toAddress(l1Token),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(deposits).to.exist;
      expect(deposits[l2Token].length).to.equal(1);

      let receipts = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        toAddress(l1Token),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Token].length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [deposits[l2Token][0].txnRef],
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
              totalAmount: bnZero,
            },
          },
        },
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Bridge.finalizeDeposit(MAINNET, monitoredEoa, l1Token, depositAmount);
      receipts = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        toAddress(l1Token),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Token].length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
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
              totalAmount: bnZero,
            },
          },
        },
      });
    });

    it("Get L1 deposits: HubPool", async function () {
      await deposit(spokePool.address, depositAmount);
      await deposit(monitoredEoa, depositAmount);

      const result = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
        toAddress(l1Token),
        toAddress(spokePool.address),
        toAddress(spokePool.address),
        searchConfig
      );
      expect(result).to.exist;
      expect(result[l2Token].length).to.equal(1);

      // Ensure that the recipient address filters work.
      for (const [sender, recipient] of [
        [hubPool.address, spokePool.address],
        [randomEoa, monitoredEoa],
      ]) {
        const result = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
          toAddress(l1Token),
          toAddress(sender),
          toAddress(recipient),
          searchConfig
        );
        expect(result).to.exist;
        expect(result[l2Token].length).to.equal(1);

        const [deposit] = result[l2Token];
        expect(deposit).to.exist;
        const { to, amount } = deposit;
        expect(to).to.equal(recipient);
        expect(amount.eq(depositAmount)).to.be.true;
      }
    });

    it("Get L2 receipts: HubPool", async function () {
      // Should return only event
      await l2Bridge.finalizeDeposit(MAINNET, spokePool.address, l1Token, depositAmount);
      await l2Bridge.finalizeDeposit(MAINNET, monitoredEoa, l1Token, depositAmount);

      const result = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        toAddress(l1Token),
        toAddress(spokePool.address),
        toAddress(spokePool.address),
        searchConfig
      );
      expect(result[l2Token].length).to.equal(1);

      // Ensure that the recipient address filters work.
      for (const [sender, recipient] of [
        [hubPool.address, spokePool.address],
        [monitoredEoa, monitoredEoa],
      ]) {
        const result = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
          toAddress(l1Token),
          toAddress(sender),
          toAddress(recipient),
          searchConfig
        );
        expect(result).to.exist;
        expect(result[l2Token].length).to.equal(1);

        const [deposit] = result[l2Token];
        expect(deposit).to.exist;
        const { to, amount } = deposit;
        expect(to).to.equal(recipient);
        expect(amount.eq(depositAmount)).to.be.true;
      }
    });

    it("Matches l1 deposits and l2 receipts: HubPool", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
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
              totalAmount: bnZero,
            },
          },
        },
      });

      // Make a single l1 -> l2 deposit.
      await deposit(spokePool.address, depositAmount);
      const deposits = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
        toAddress(l1Token),
        toAddress(spokePool.address),
        toAddress(spokePool.address),
        searchConfig
      );
      expect(deposits).to.exist;
      expect(deposits[l2Token].length).to.equal(1);

      let receipts = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        toAddress(l1Token),
        null,
        toAddress(spokePool.address),
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Token].length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
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
              depositTxHashes: [deposits[l2Token][0].txnRef],
              totalAmount: deposits[l2Token][0].amount,
            },
          },
        },
        [hubPool.address]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [],
              totalAmount: bnZero,
            },
          },
        },
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Bridge.finalizeDeposit(MAINNET, spokePool.address, l1Token, depositAmount);
      receipts = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        toAddress(l1Token),
        null,
        toAddress(spokePool.address),
        searchConfig
      );
      expect(receipts).to.exist;
      expect(receipts[l2Token].length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
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
              totalAmount: bnZero,
            },
          },
        },
      });
    });

    it("Correctly makes l1 deposits", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
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
              totalAmount: bnZero,
            },
          },
        },
      });

      // Make a single l1 -> l2 deposit via the chain adapter.
      await adapter.sendTokenToTargetChain(
        toAddress(monitoredEoa),
        toAddress(l1Token),
        toAddress(l2Token),
        depositAmount,
        false
      );
      const deposits = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
        toAddress(l1Token),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );
      expect(deposits).to.exist;
      expect(deposits[l2Token].length).to.equal(1);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([toAddress(l1Token)]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Token]: {
            [l2Token]: {
              depositTxHashes: [deposits[l2Token][0].txnRef],
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
              totalAmount: bnZero,
            },
          },
        },
      });
    });
  });
});
