import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { utils } from "@across-protocol/sdk";
import { SpokePoolClient } from "../../src/clients";
import { ZKSyncAdapter } from "../../src/clients/bridges";
import { bnZero, Provider } from "../../src/utils";
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

const { MAINNET, ZK_SYNC } = CHAIN_IDs;
const { USDC, WETH } = TOKEN_SYMBOLS_MAP;
const l1Weth = WETH.addresses[MAINNET];

let l1Bridge: Contract, l2Bridge: Contract;
let l2Eth: Contract, l2Weth: Contract;
let hubPool: Contract, spokePool: Contract;

class zkSyncTestAdapter extends ZKSyncAdapter {
  protected hubPool: Contract;

  override isL2ChainContract(address: string): Promise<boolean> {
    return Promise.resolve(address === spokePool.address);
  }

  override isWeth(l1Token: string): boolean {
    return l1Token === l1Weth;
  }

  override getAtomicDepositor(): Contract {
    return l1Bridge;
  }

  override getL1ERC20BridgeContract(): Contract {
    return l1Bridge;
  }

  override getL2ERC20BridgeContract(): Contract {
    return l2Bridge;
  }

  override getHubPool(): Contract {
    return hubPool;
  }

  override getL2Eth(): Contract {
    return l2Eth;
  }

  override getL2Weth(): Contract {
    return l2Weth;
  }

  resolveL2TokenAddress(l1Token: string, isNativeUsdc = false): string {
    return l1Token === l1Weth ? l2Weth.address : super.resolveL2TokenAddress(l1Token, isNativeUsdc);
  }

  protected async getL2GasCost(
    provider: Provider,
    l2GasLimit: BigNumber,
    gasPerPubdataLimit: number
  ): Promise<BigNumber> {
    // None of these are used; just satisfy the linter.
    provider;
    l2GasLimit;
    gasPerPubdataLimit;

    return toBN(2_000_000);
  }
}

describe("Cross Chain Adapter: zkSync", async function () {
  const logger = createSpyLogger().spyLogger;
  const l2TxGasLimit = bnZero;
  const l2TxGasPerPubdataByte = bnZero;
  const l1Token = USDC.addresses[MAINNET];
  let atomicDepositor: string;

  let adapter: zkSyncTestAdapter;
  let monitoredEoa: string;
  let l2Token: string;

  let searchConfig: utils.EventSearchConfig;
  let amount: BigNumber;

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

    l1Bridge = await (await getContractFactory("zkSync_L1Bridge", depositor)).deploy();
    l2Bridge = await (await getContractFactory("zkSync_L2Bridge", depositor)).deploy();
    l2Eth = await (await getContractFactory("WETH9", depositor)).deploy();
    l2Weth = await (await getContractFactory("WETH9", depositor)).deploy();

    adapter = new zkSyncTestAdapter(
      logger,
      {
        [MAINNET]: l1SpokePoolClient,
        [ZK_SYNC]: l2SpokePoolClient,
      },
      [monitoredEoa, hubPool.address, spokePool.address]
    );
    atomicDepositor = adapter.getAtomicDepositor().address;

    amount = toBN(Math.round(Math.random() * 1e18));
    l2Token = adapter.resolveL2TokenAddress(l1Token);
  });

  describe("WETH bridge", function () {
    it("Get L1 deposits: EOA", async function () {
      await l1Bridge.bridgeWethToZkSync(monitoredEoa, amount, 0, 0, ZERO_ADDRESS);

      const result = await adapter.queryL1BridgeInitiationEvents(l1Weth, monitoredEoa, monitoredEoa, searchConfig);
      expect(result).to.exist;
      expect(result.length).to.equal(1);

      const deposit = result.at(0)!;
      expect(deposit.args).to.exist;
      const { from, to, amount: _amount } = deposit.args!;
      expect(from).to.equal(monitoredEoa);
      expect(to).to.equal(monitoredEoa);
      expect(_amount).to.equal(amount);
    });

    it("Get L2 receipts: EOA", async function () {
      await l2Eth.transfer(adapter.getAddressAlias(atomicDepositor), monitoredEoa, amount);
      await l2Weth.transfer(ZERO_ADDRESS, monitoredEoa, amount);

      const result = await adapter.queryL2BridgeFinalizationEvents(l1Weth, null, monitoredEoa, searchConfig);
      expect(result.length).to.equal(1);

      const receipt = result.at(0)!;
      expect(receipt.args).to.exist;
      const { from, to, amount: _amount } = receipt.args!;
      expect(from).to.equal(adapter.getAddressAlias(atomicDepositor));
      expect(to).to.equal(monitoredEoa);
      expect(_amount).to.equal(amount);
    });

    it("Matches L1 and L2 events: EOA", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({ [monitoredEoa]: {}, [spokePool.address]: {} });

      // Make a single l1 -> l2 deposit.
      await l1Bridge.bridgeWethToZkSync(monitoredEoa, amount, 0, 0, ZERO_ADDRESS);
      const deposits = await adapter.queryL1BridgeInitiationEvents(l1Weth, null, monitoredEoa, searchConfig);
      expect(deposits).to.exist;
      expect(deposits.length).to.equal(1);

      let receipts = await adapter.queryL2BridgeFinalizationEvents(l1Weth, null, monitoredEoa, searchConfig);
      expect(receipts).to.exist;
      expect(receipts.length).to.equal(0);

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

      // Finalise the ongoing deposit on the destination chain.
      await l2Eth.transfer(adapter.getAddressAlias(atomicDepositor), monitoredEoa, amount); // Simulate ETH transfer to recipient EOA.
      await l2Weth.transfer(ZERO_ADDRESS, monitoredEoa, amount); // Simulate subsequent WETH deposit.
      receipts = await adapter.queryL2BridgeFinalizationEvents(l1Weth, null, monitoredEoa, searchConfig);
      expect(receipts).to.exist;
      expect(receipts.length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({ [monitoredEoa]: {}, [spokePool.address]: {} });
    });

    it("Get L1 deposits: HubPool", async function () {
      await hubPool.relayTokens(l1Weth, l2Weth.address, amount, spokePool.address);

      const result = await adapter.queryL1BridgeInitiationEvents(l1Weth, null, spokePool.address, searchConfig);
      expect(result).to.exist;
      expect(result.length).to.equal(1);

      const deposit = result.at(0)!;
      expect(deposit.args).to.exist;
      const { to, amount: _amount } = deposit.args!;
      expect(to).to.equal(spokePool.address);
      expect(_amount).to.equal(amount);
    });

    it("Get L2 receipts: HubPool", async function () {
      await l2Eth.transfer(adapter.getAddressAlias(hubPool.address), spokePool.address, amount);

      const result = await adapter.queryL2BridgeFinalizationEvents(l1Weth, null, spokePool.address, searchConfig);
      expect(result.length).to.equal(1);

      const receipt = result.at(0)!;
      expect(receipt.args).to.exist;
      const { from, to, amount: _amount } = receipt.args!;
      expect(from).to.equal(adapter.getAddressAlias(hubPool.address));
      expect(to).to.equal(spokePool.address);
      expect(_amount).to.equal(amount);
    });

    it("Matches L1 and L2 events: HubPool", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({ [monitoredEoa]: {}, [spokePool.address]: {} });

      // Make a single l1 -> l2 deposit.
      await hubPool.relayTokens(l1Weth, l2Weth.address, amount, spokePool.address);
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
      await l2Eth.transfer(adapter.getAddressAlias(hubPool.address), spokePool.address, amount);
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
      await adapter.sendTokenToTargetChain(monitoredEoa, l1Weth, l2Token, amount);
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
      await l1Bridge.deposit(monitoredEoa, l1Token, amount, l2TxGasLimit, l2TxGasPerPubdataByte);
      await l1Bridge.deposit(randomEoa, l1Token, amount, l2TxGasLimit, l2TxGasPerPubdataByte);

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
      await l2Bridge.finalizeDeposit(monitoredEoa, monitoredEoa, l1Token, amount);
      await l2Bridge.finalizeDeposit(monitoredEoa, randomEoa, l1Token, amount);

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
      await l2Bridge.finalizeDeposit(monitoredEoa, monitoredEoa, l1Token, amount);
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
        amount,
        l2TxGasLimit,
        l2TxGasPerPubdataByte
      );
      await l1Bridge.depositFor(randomEoa, monitoredEoa, l1Token, amount, l2TxGasLimit, l2TxGasPerPubdataByte);

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
      await l2Bridge.finalizeDeposit(hubPool.address, spokePool.address, l1Token, amount);
      await l2Bridge.finalizeDeposit(randomEoa, monitoredEoa, l1Token, amount);

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
        amount,
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
      await l2Bridge.finalizeDeposit(hubPool.address, spokePool.address, l1Token, amount);
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
      await adapter.sendTokenToTargetChain(monitoredEoa, l1Token, l2Token, amount);
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
