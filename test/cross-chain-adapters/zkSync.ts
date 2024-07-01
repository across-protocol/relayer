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
let l1Bridge: Contract;
let l2Bridge: Contract;
let hubPool: Contract;

class zkSyncTestAdapter extends ZKSyncAdapter {
  protected hubPool: Contract;

  override getAtomicDepositor(): Contract {
    return l1Bridge;
  }

  protected override getL1ERC20BridgeContract(): Contract {
    return l1Bridge;
  }

  protected override getL2ERC20BridgeContract(): Contract {
    return l2Bridge;
  }

  override getHubPool(): Contract {
    return hubPool;
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
  const { USDC, WETH } = TOKEN_SYMBOLS_MAP;
  const l2TxGasLimit = bnZero;
  const l2TxGasPerPubdataByte = bnZero;
  const l1Token = USDC.addresses[MAINNET];
  const l1Weth = WETH.addresses[MAINNET];

  let spokePool: Contract;
  let adapter: zkSyncTestAdapter;
  let monitoredEoa: string;
  let l2Token: string, l2Weth: string;

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

    adapter = new zkSyncTestAdapter(
      logger,
      {
        [MAINNET]: l1SpokePoolClient,
        [ZK_SYNC]: l2SpokePoolClient,
      },
      [monitoredEoa, hubPool.address, spokePool.address]
    );

    amount = toBN(Math.round(Math.random() * 1e18));
    [l2Token, l2Weth] = [adapter.resolveL2TokenAddress(l1Token), adapter.resolveL2TokenAddress(l1Weth)];

    // wethBridgeContract = await (await getContractFactory("LineaWethBridge", deployer)).deploy();
    l1Bridge = await (await getContractFactory("zkSync_L1Bridge", depositor)).deploy();
    l2Bridge = await (await getContractFactory("zkSync_L2Bridge", depositor)).deploy();
  });

  describe("WETH bridge", function () {
    it("Get L1 deposits: EOA", async function () {
      await l1Bridge.bridgeWethToZkSync(monitoredEoa, amount, 0, 0, ZERO_ADDRESS);

      const result = await adapter.getWETHDeposits(l1Bridge, searchConfig);
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
      await l2Bridge.transfer(monitoredEoa, monitoredEoa, amount);

      const result = await adapter.getWETHReceipts(l2Bridge, searchConfig, monitoredEoa, monitoredEoa);
      expect(result.length).to.equal(1);

      const receipt = result.at(0)!;
      expect(receipt.args).to.exist;
      const { from, to, amount: _amount } = receipt.args!;
      expect(from).to.equal(monitoredEoa);
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
      const deposits = await adapter.getWETHDeposits(l1Bridge, searchConfig);
      expect(deposits).to.exist;
      expect(deposits.length).to.equal(1);

      let receipts = await adapter.getERC20Receipts(l2Bridge, searchConfig, monitoredEoa, monitoredEoa);
      expect(receipts).to.exist;
      expect(receipts.length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [deposits[0].transactionHash],
              totalAmount: deposits[0].args!.amount,
            },
          },
        },
        [spokePool.address]: {},
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Bridge.finalizeDeposit(monitoredEoa, monitoredEoa, l1Token, amount);
      receipts = await adapter.getERC20Receipts(l2Bridge, searchConfig, monitoredEoa, monitoredEoa);
      expect(receipts).to.exist;
      expect(receipts.length).to.equal(1);

      // There should be no outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      expect(transfers).to.deep.equal({ [monitoredEoa]: {}, [spokePool.address]: {} });
    });

    it("Get L1 deposits: HubPool", async function () {
      await hubPool.relayTokens(l1Weth, l2Weth, amount, spokePool.address);

      const result = await adapter.getWETHDeposits(hubPool, searchConfig, hubPool.address);
      expect(result).to.exist;
      expect(result.length).to.equal(1);

      const deposit = result.at(0)!;
      expect(deposit.args).to.exist;
      const { to, amount: _amount } = deposit.args!;
      expect(to).to.equal(spokePool.address);
      expect(_amount).to.equal(amount);
    });

    it("Get L2 receipts: HubPool", async function () {
      await l2Bridge.transfer(hubPool.address, spokePool.address, amount);

      const result = await adapter.getWETHReceipts(l2Bridge, searchConfig, hubPool.address, spokePool.address);
      expect(result.length).to.equal(1);

      const receipt = result.at(0)!;
      expect(receipt.args).to.exist;
      const { from, to, amount: _amount } = receipt.args!;
      expect(from).to.equal(hubPool.address);
      expect(to).to.equal(spokePool.address);
      expect(_amount).to.equal(amount);
    });

    it("Matches L1 and L2 events: HubPool", async function () {
      // There should be no pre-existing outstanding transfers.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      let transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({ [monitoredEoa]: {}, [spokePool.address]: {} });

      // Make a single l1 -> l2 deposit.
      await l1Bridge.bridgeWethToZkSync(monitoredEoa, amount, 0, 0, ZERO_ADDRESS);
      const deposits = await adapter.getWETHDeposits(l1Bridge, searchConfig);
      expect(deposits).to.exist;
      expect(deposits.length).to.equal(1);

      let receipts = await adapter.getERC20Receipts(l2Bridge, searchConfig, monitoredEoa, monitoredEoa);
      expect(receipts).to.exist;
      expect(receipts.length).to.equal(0);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth]: {
              depositTxHashes: [deposits[0].transactionHash],
              totalAmount: deposits[0].args!.amount,
            },
          },
        },
        [spokePool.address]: {},
      });

      // Finalise the ongoing deposit on the destination chain.
      await l2Bridge.finalizeDeposit(monitoredEoa, monitoredEoa, l1Token, amount);
      receipts = await adapter.getERC20Receipts(l2Bridge, searchConfig, monitoredEoa, monitoredEoa);
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
      let transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({ [monitoredEoa]: {}, [spokePool.address]: {} });

      // Make a single l1 -> l2 deposit via the chaina adapter.
      await adapter.sendTokenToTargetChain(monitoredEoa, l1Weth, l2Token, amount);
      const deposits = await adapter.getWETHDeposits(l1Bridge, searchConfig);
      expect(deposits).to.exist;
      expect(deposits.length).to.equal(1);

      // There should be 1 outstanding transfer.
      await Promise.all(Object.values(adapter.spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));
      transfers = await adapter.getOutstandingCrossChainTransfers([l1Weth]);
      expect(transfers).to.deep.equal({
        [monitoredEoa]: {
          [l1Weth]: {
            [l2Weth]: {
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

      const result = await adapter.getERC20Deposits(l1Bridge, searchConfig);
      expect(result).to.exist;
      expect(result.length).to.equal(2);

      // Ensure that the recipient address filters work.
      for (const recipient of [monitoredEoa, randomEoa]) {
        const result = await adapter.getERC20Deposits(l1Bridge, searchConfig, monitoredEoa, recipient);
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

      const result = await adapter.getERC20Receipts(l2Bridge, searchConfig);
      expect(result.length).to.equal(2);

      // Ensure that the recipient address filters work.
      for (const recipient of [monitoredEoa, randomEoa]) {
        const result = await adapter.getERC20Receipts(l2Bridge, searchConfig, monitoredEoa, recipient);
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
      const deposits = await adapter.getERC20Deposits(l1Bridge, searchConfig);
      expect(deposits).to.exist;
      expect(deposits.length).to.equal(1);

      let receipts = await adapter.getERC20Receipts(l2Bridge, searchConfig, monitoredEoa, monitoredEoa);
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
      receipts = await adapter.getERC20Receipts(l2Bridge, searchConfig, monitoredEoa, monitoredEoa);
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

      const result = await adapter.getERC20Deposits(l1Bridge, searchConfig);
      expect(result).to.exist;
      expect(result.length).to.equal(2);

      // Ensure that the recipient address filters work.
      for (const [sender, recipient] of [
        [hubPool.address, spokePool.address],
        [randomEoa, monitoredEoa],
      ]) {
        const result = await adapter.getERC20Deposits(l1Bridge, searchConfig, sender, recipient);
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

      const result = await adapter.getERC20Receipts(l2Bridge, searchConfig);
      expect(result.length).to.equal(2);

      // Ensure that the recipient address filters work.
      for (const [sender, recipient] of [
        [hubPool.address, spokePool.address],
        [randomEoa, monitoredEoa],
      ]) {
        const result = await adapter.getERC20Receipts(l2Bridge, searchConfig, sender, recipient);
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
      const deposits = await adapter.getERC20Deposits(l1Bridge, searchConfig);
      expect(deposits).to.exist;
      expect(deposits.length).to.equal(1);

      let receipts = await adapter.getERC20Receipts(l2Bridge, searchConfig, hubPool.address, spokePool.address);
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
      receipts = await adapter.getERC20Receipts(l2Bridge, searchConfig, hubPool.address, spokePool.address);
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
      const deposits = await adapter.getERC20Deposits(l1Bridge, searchConfig);
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
