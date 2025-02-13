import { utils } from "@across-protocol/sdk";
import { Signer } from "ethers";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";

import { CONTRACT_ADDRESSES } from "../../src/common";
import {
  OpStackWethBridge,
  OpStackDefaultERC20Bridge,
  DaiOptimismBridge,
  SnxOptimismBridge,
  UsdcTokenSplitterBridge,
} from "../../src/adapter/bridges";
import { BaseChainAdapter } from "../../src/adapter/BaseChainAdapter";
import { SpokePoolClient } from "../../src/clients";

import { ZERO_ADDRESS } from "../constants";
import { ethers, getContractFactory, Contract, randomAddress, expect, createSpyLogger, toBN } from "../utils";
import { hashCCTPSourceAndNonce, getCctpDomainForChainId } from "../../src/utils";

const atomicDepositorAddress = CONTRACT_ADDRESSES[CHAIN_IDs.MAINNET].atomicDepositor.address;
const l1WethAddress = TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET];
const l2WethAddress = TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.OPTIMISM];
const l1SnxAddress = TOKEN_SYMBOLS_MAP.SNX.addresses[CHAIN_IDs.MAINNET];
const l2SnxAddress = TOKEN_SYMBOLS_MAP.SNX.addresses[CHAIN_IDs.OPTIMISM];
const l1DaiAddress = TOKEN_SYMBOLS_MAP.DAI.addresses[CHAIN_IDs.MAINNET];
const l2DaiAddress = TOKEN_SYMBOLS_MAP.DAI.addresses[CHAIN_IDs.OPTIMISM];
const l1Erc20Address = TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.MAINNET];
const l2Erc20Address = TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.OPTIMISM];
const l1UsdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET];
const l2UsdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.OPTIMISM];

const logger = createSpyLogger().spyLogger;
const notMonitoredEoa = randomAddress();

let adapter: BaseChainAdapter;

let monitoredEoa: string;
let monitoredEoaAccount: Signer;

let wethBridgeContract: Contract;
let daiBridgeContract: Contract;
let snxBridgeContract: Contract;
let erc20BridgeContract: Contract;
let cctpBridgeContract: Contract;
let cctpMessageTransmitterContract: Contract;

let wethContract: Contract;
let spokePoolContract: Contract;

let searchConfig: utils.EventSearchConfig;

class TestBaseChainAdapter extends BaseChainAdapter {
  public setBridge(address: string, bridge: Contract) {
    this.bridges[address].l1Bridge = bridge;
    this.bridges[address].l2Bridge = bridge;
  }

  // This assumes that address is the weth contract address
  public setL2Weth(address: string, l2Weth: Contract) {
    this.bridges[address].l2Weth = l2Weth;
  }

  public setCctpBridge(address: string, cctpBridge: Contract, messageTransmitter: Contract) {
    this.bridges[address].cctpBridge.l1Bridge = cctpBridge;
    this.bridges[address].cctpBridge.l2Bridge = messageTransmitter;
  }
}

describe("Cross Chain Adapter: OP Stack", async function () {
  beforeEach(async function () {
    searchConfig = {
      fromBlock: 0,
      toBlock: 1_000_000,
    };
    const [deployer] = await ethers.getSigners();

    monitoredEoaAccount = deployer;
    monitoredEoa = await monitoredEoaAccount.getAddress();

    wethBridgeContract = await (await getContractFactory("OpStackWethBridge", deployer)).deploy();
    wethContract = await (await getContractFactory("WETH9", deployer)).deploy();
    daiBridgeContract = await (await getContractFactory("OpStackStandardBridge", deployer)).deploy();
    snxBridgeContract = await (await getContractFactory("OpStackSnxBridge", deployer)).deploy();
    erc20BridgeContract = await (await getContractFactory("OpStackStandardBridge", deployer)).deploy();
    cctpBridgeContract = await (await getContractFactory("CctpTokenMessenger", deployer)).deploy();
    cctpMessageTransmitterContract = await (await getContractFactory("CctpMessageTransmitter", deployer)).deploy();

    const bridges = {
      [l1WethAddress]: new OpStackWethBridge(CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, deployer, deployer, undefined),
      [l1SnxAddress]: new SnxOptimismBridge(CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, deployer, deployer, undefined),
      [l1DaiAddress]: new DaiOptimismBridge(CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, deployer, deployer, undefined),
      [l1Erc20Address]: new OpStackDefaultERC20Bridge(
        CHAIN_IDs.OPTIMISM,
        CHAIN_IDs.MAINNET,
        deployer,
        deployer,
        undefined
      ),
      [l1UsdcAddress]: new UsdcTokenSplitterBridge(
        CHAIN_IDs.OPTIMISM,
        CHAIN_IDs.MAINNET,
        deployer,
        deployer,
        undefined
      ),
    };

    spokePoolContract = await (await getContractFactory("MockSpokePool", deployer)).deploy(ZERO_ADDRESS);

    const l2SpokePoolClient = new SpokePoolClient(logger, spokePoolContract, null, CHAIN_IDs.OPTIMISM, 0, {
      fromBlock: 0,
    });
    const l1SpokePoolClient = new SpokePoolClient(logger, spokePoolContract, null, CHAIN_IDs.MAINNET, 0, {
      fromBlock: 0,
    });

    adapter = new TestBaseChainAdapter(
      {
        [CHAIN_IDs.OPTIMISM]: l2SpokePoolClient,
        [CHAIN_IDs.MAINNET]: l1SpokePoolClient,
      },
      CHAIN_IDs.OPTIMISM,
      CHAIN_IDs.MAINNET,
      [monitoredEoa],
      logger,
      ["WETH", "SNX", "DAI", "WBTC", "USDC"],
      bridges,
      1
    );

    adapter.setBridge(l1WethAddress, wethBridgeContract);
    adapter.setBridge(l1SnxAddress, snxBridgeContract);
    adapter.setBridge(l1DaiAddress, daiBridgeContract);
    adapter.setBridge(l1Erc20Address, erc20BridgeContract);
    adapter.setCctpBridge(l1UsdcAddress, cctpBridgeContract, cctpMessageTransmitterContract);
    adapter.setL2Weth(l1WethAddress, wethContract);

    // Required to pass checks in `BaseAdapter.getUpdatedSearchConfigs`
    l2SpokePoolClient.latestBlockSearched = searchConfig.toBlock;
    l1SpokePoolClient.latestBlockSearched = searchConfig.toBlock;
  });

  describe("WETH", function () {
    it("Get L1 initiated events for EOA", async function () {
      const wethBridge = adapter.bridges[l1WethAddress];
      // For EOA's only returns transfers originating from atomic depositor address and recipient
      // is the filtered address.
      await wethBridgeContract.emitDepositInitiated(monitoredEoa, randomAddress(), 1);
      await wethBridgeContract.emitDepositInitiated(randomAddress(), monitoredEoa, 1);
      await wethBridgeContract.emitDepositInitiated(atomicDepositorAddress, randomAddress(), 1);
      await wethBridgeContract.emitDepositInitiated(atomicDepositorAddress, monitoredEoa, 1);
      const result = (
        await wethBridge.queryL1BridgeInitiationEvents(l1WethAddress, monitoredEoa, undefined, searchConfig)
      )[l2WethAddress];
      expect(result.length).to.equal(1);
      expect(result[0].from).to.equal(atomicDepositorAddress);
      expect(result[0].to).to.equal(monitoredEoa);
      expect(result[0].amount).to.equal(1);
    });
    // TODO: Add unit tests when from address is contract but need to change the providers such that we can
    // pretend we are monitoring the hub pool contract.
    it("Get L2 finalized events for EOA", async function () {
      const wethBridge = adapter.bridges[l1WethAddress];
      // Counts only finalized events preceding a WETH wrap event.
      // For EOA's, weth transfer from address should be atomic depositor address
      await wethBridgeContract.emitDepositFinalized(atomicDepositorAddress, monitoredEoa, 1);
      const emptyResult = (
        await wethBridge.queryL2BridgeFinalizationEvents(l1WethAddress, monitoredEoa, monitoredEoa, searchConfig)
      )[l2WethAddress];
      expect(emptyResult.length).to.equal(0);

      // Mine Deposit event now.
      await wethContract.connect(monitoredEoaAccount).deposit({ value: 0 });
      const result = (
        await wethBridge.queryL2BridgeFinalizationEvents(l1WethAddress, monitoredEoa, monitoredEoa, searchConfig)
      )[l2WethAddress];
      expect(result.length).to.equal(1);
      expect(result[0].from).to.equal(atomicDepositorAddress);
      expect(result[0].to).to.equal(monitoredEoa);
    });
  });

  describe("Custom bridge: SNX", () => {
    it("return only relevant L1 bridge init events", async () => {
      const snxBridge = adapter.bridges[l1SnxAddress];
      await snxBridgeContract.emitDepositInitiated(monitoredEoa, monitoredEoa, 1);
      await snxBridgeContract.emitDepositInitiated(notMonitoredEoa, notMonitoredEoa, 1);

      const events = (
        await snxBridge.queryL1BridgeInitiationEvents(l1SnxAddress, monitoredEoa, monitoredEoa, searchConfig)
      )[l2SnxAddress];
      expect(events.length).to.equal(1);
      expect(events[0].to).to.equal(monitoredEoa);
      expect(events[0].from).to.equal(monitoredEoa);
    });

    it("return only relevant L2 bridge finalization events", async () => {
      const snxBridge = adapter.bridges[l1SnxAddress];
      await snxBridgeContract.emitDepositFinalized(notMonitoredEoa, 1);
      await snxBridgeContract.emitDepositFinalized(monitoredEoa, 1);

      const events = (
        await snxBridge.queryL2BridgeFinalizationEvents(l1SnxAddress, monitoredEoa, monitoredEoa, searchConfig)
      )[l2SnxAddress];
      expect(events.length).to.equal(1);
      expect(events[0].to).to.equal(monitoredEoa);
    });
  });

  describe("Custom bridge: DAI", () => {
    it("return only relevant L1 bridge init events", async () => {
      const daiBridge = adapter.bridges[l1DaiAddress];
      await daiBridgeContract.emitDepositInitiated(l1DaiAddress, l2DaiAddress, monitoredEoa, notMonitoredEoa, 1);
      await daiBridgeContract.emitDepositInitiated(l1DaiAddress, l2DaiAddress, notMonitoredEoa, monitoredEoa, 1);

      const events = (
        await daiBridge.queryL1BridgeInitiationEvents(l1DaiAddress, monitoredEoa, undefined, searchConfig)
      )[l2DaiAddress];
      expect(events.length).to.equal(1);
      expect(events[0].from).to.equal(monitoredEoa);
      expect(events[0].to).to.equal(notMonitoredEoa);
    });

    it("return only relevant L2 bridge finalization events", async () => {
      const daiBridge = adapter.bridges[l1DaiAddress];
      await daiBridgeContract.emitDepositFinalized(l1DaiAddress, l2DaiAddress, monitoredEoa, notMonitoredEoa, 1);
      await daiBridgeContract.emitDepositFinalized(l1DaiAddress, l2DaiAddress, notMonitoredEoa, monitoredEoa, 1);

      const events = (
        await daiBridge.queryL2BridgeFinalizationEvents(l1DaiAddress, monitoredEoa, undefined, searchConfig)
      )[l2DaiAddress];
      expect(events.length).to.equal(1);
      expect(events[0].from).to.equal(monitoredEoa);
      expect(events[0].to).to.equal(notMonitoredEoa);
    });
  });

  describe("Default ERC20 bridge", () => {
    it("return only relevant L1 bridge init events", async () => {
      const erc20Bridge = adapter.bridges[l1Erc20Address];
      await erc20BridgeContract.emitDepositInitiated(l1Erc20Address, l2Erc20Address, monitoredEoa, notMonitoredEoa, 1);
      await erc20BridgeContract.emitDepositInitiated(l1Erc20Address, l2Erc20Address, notMonitoredEoa, monitoredEoa, 1);

      const events = (
        await erc20Bridge.queryL1BridgeInitiationEvents(l1Erc20Address, monitoredEoa, undefined, searchConfig)
      )[l2Erc20Address];
      expect(events.length).to.equal(1);
      expect(events[0].from).to.equal(monitoredEoa);
      expect(events[0].to).to.equal(notMonitoredEoa);
    });

    it("return only relevant L2 bridge finalization events", async () => {
      const erc20Bridge = adapter.bridges[l1Erc20Address];
      await erc20BridgeContract.emitDepositFinalized(l1Erc20Address, l2Erc20Address, monitoredEoa, notMonitoredEoa, 1);
      await erc20BridgeContract.emitDepositFinalized(l1Erc20Address, l2Erc20Address, notMonitoredEoa, monitoredEoa, 1);

      const events = (
        await erc20Bridge.queryL2BridgeFinalizationEvents(l1Erc20Address, monitoredEoa, undefined, searchConfig)
      )[l2Erc20Address];
      expect(events.length).to.equal(1);
      expect(events[0].from).to.equal(monitoredEoa);
      expect(events[0].to).to.equal(notMonitoredEoa);
    });
  });

  describe("USDC token splitter bridge", () => {
    it("return only relevant L1 bridge init events", async () => {
      const usdcTokenSplitterBridge = adapter.bridges[l1UsdcAddress];
      const processedNonce = 1;
      const unprocessedNonce = 2;
      await cctpBridgeContract.emitDepositForBurn(
        processedNonce,
        l1UsdcAddress,
        1,
        monitoredEoa,
        ethers.utils.hexZeroPad(monitoredEoa, 32),
        getCctpDomainForChainId(CHAIN_IDs.OPTIMISM),
        ethers.utils.hexZeroPad(cctpMessageTransmitterContract.address, 32),
        ethers.utils.hexZeroPad(monitoredEoa, 32)
      );
      await cctpBridgeContract.emitDepositForBurn(
        unprocessedNonce,
        l1UsdcAddress,
        1,
        monitoredEoa,
        ethers.utils.hexZeroPad(monitoredEoa, 32),
        getCctpDomainForChainId(CHAIN_IDs.OPTIMISM),
        ethers.utils.hexZeroPad(cctpMessageTransmitterContract.address, 32),
        ethers.utils.hexZeroPad(monitoredEoa, 32)
      );
      await cctpMessageTransmitterContract.setUsedNonce(
        hashCCTPSourceAndNonce(getCctpDomainForChainId(CHAIN_IDs.MAINNET), processedNonce),
        processedNonce
      );

      const events = (
        await usdcTokenSplitterBridge.queryL1BridgeInitiationEvents(
          l1UsdcAddress,
          monitoredEoa,
          undefined,
          searchConfig
        )
      )[l2UsdcAddress];
      expect(events.length).to.equal(1);
      expect(events[0].nonce.toString()).to.equal(unprocessedNonce.toString());
    });
  });

  describe("OpStackAdapter", () => {
    it("return outstanding cross-chain transfers", async () => {
      const finalizedAmount = 2;
      const outstandingAmount = 1;

      const wethBridge = adapter.bridges[l1WethAddress];
      const erc20Bridge = adapter.bridges[l1Erc20Address];
      const daiBridge = adapter.bridges[l1DaiAddress];
      const snxBridge = adapter.bridges[l1SnxAddress];

      // WETH transfers: 1x outstanding
      await wethBridgeContract.emitDepositInitiated(atomicDepositorAddress, monitoredEoa, outstandingAmount);
      // SNX transfers: 1x outstanding, 1x finalized
      await snxBridgeContract.emitDepositInitiated(monitoredEoa, monitoredEoa, outstandingAmount);
      await snxBridgeContract.emitDepositInitiated(monitoredEoa, monitoredEoa, finalizedAmount);
      await snxBridgeContract.emitDepositFinalized(monitoredEoa, finalizedAmount);
      // DAI transfers: 1x outstanding, 1x finalized
      await daiBridgeContract.emitDepositInitiated(
        l1DaiAddress,
        l2DaiAddress,
        monitoredEoa,
        notMonitoredEoa,
        outstandingAmount
      );
      await daiBridgeContract.emitDepositInitiated(
        l1DaiAddress,
        l2DaiAddress,
        monitoredEoa,
        notMonitoredEoa,
        finalizedAmount
      );
      await daiBridgeContract.emitDepositFinalized(
        l1DaiAddress,
        l2DaiAddress,
        monitoredEoa,
        notMonitoredEoa,
        finalizedAmount
      );
      // Default ERC20 transfers: 1x outstanding, 1x finalized
      await erc20BridgeContract.emitDepositInitiated(
        l1Erc20Address,
        l2Erc20Address,
        monitoredEoa,
        notMonitoredEoa,
        outstandingAmount
      );
      await erc20BridgeContract.emitDepositInitiated(
        l1Erc20Address,
        l2Erc20Address,
        monitoredEoa,
        notMonitoredEoa,
        finalizedAmount
      );
      await erc20BridgeContract.emitDepositFinalized(
        l1Erc20Address,
        l2Erc20Address,
        monitoredEoa,
        notMonitoredEoa,
        finalizedAmount
      );

      // Get deposit tx hashes of outstanding transfers
      const outstandingWethEvent = (
        await wethBridge.queryL1BridgeInitiationEvents(l1WethAddress, monitoredEoa, monitoredEoa, searchConfig)
      )[l2WethAddress].find((event) => event.amount.toNumber() === outstandingAmount);
      const outstandingSnxEvent = (
        await snxBridge.queryL1BridgeInitiationEvents(l1SnxAddress, monitoredEoa, monitoredEoa, searchConfig)
      )[l2SnxAddress].find((event) => event.amount.toNumber() === outstandingAmount);
      const outstandingDaiEvent = (
        await daiBridge.queryL1BridgeInitiationEvents(l1DaiAddress, monitoredEoa, monitoredEoa, searchConfig)
      )[l2DaiAddress].find((event) => event.amount.toNumber() === outstandingAmount);
      const outstandingErc20Event = (
        await erc20Bridge.queryL1BridgeInitiationEvents(l1Erc20Address, monitoredEoa, monitoredEoa, searchConfig)
      )[l2Erc20Address].find((event) => event.amount.toNumber() === outstandingAmount);

      const outstandingOfMonitored = (
        await adapter.getOutstandingCrossChainTransfers([l1WethAddress, l1SnxAddress, l1DaiAddress, l1Erc20Address])
      )[monitoredEoa];
      expect(outstandingOfMonitored[l1WethAddress][l2WethAddress].totalAmount).to.equal(toBN(1));
      expect(outstandingOfMonitored[l1WethAddress][l2WethAddress].depositTxHashes).to.deep.equal([
        outstandingWethEvent?.transactionHash,
      ]);
      expect(outstandingOfMonitored[l1SnxAddress][l2SnxAddress].totalAmount).to.equal(toBN(1));
      expect(outstandingOfMonitored[l1SnxAddress][l2SnxAddress].depositTxHashes).to.deep.equal([
        outstandingSnxEvent?.transactionHash,
      ]);
      expect(outstandingOfMonitored[l1DaiAddress][l2DaiAddress].totalAmount).to.equal(toBN(1));
      expect(outstandingOfMonitored[l1DaiAddress][l2DaiAddress].depositTxHashes).to.deep.equal([
        outstandingDaiEvent?.transactionHash,
      ]);
      expect(outstandingOfMonitored[l1Erc20Address][l2Erc20Address].totalAmount).to.equal(toBN(1));
      expect(outstandingOfMonitored[l1Erc20Address][l2Erc20Address].depositTxHashes).to.deep.equal([
        outstandingErc20Event?.transactionHash,
      ]);
    });

    it("return simulated success tx if above threshold", async () => {
      const tx = await adapter.wrapEthIfAboveThreshold(toBN(0), toBN(1), true);
      expect(tx).to.not.be.null;
      expect(tx?.hash).to.equal(ZERO_ADDRESS);
    });
  });
});
