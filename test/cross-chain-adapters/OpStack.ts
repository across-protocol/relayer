import { utils } from "@across-protocol/sdk";
import { Signer } from "ethers";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";

import { CONTRACT_ADDRESSES, chainIdsToCctpDomains } from "../../src/common";
import { WethBridge } from "../../src/clients/bridges/op-stack/WethBridge";
import { DefaultERC20Bridge } from "../../src/clients/bridges/op-stack/DefaultErc20Bridge";
import { DaiOptimismBridge, SnxOptimismBridge } from "../../src/clients/bridges/op-stack/optimism";
import { OpStackAdapter } from "../../src/clients/bridges/op-stack/OpStackAdapter";
import { SpokePoolClient } from "../../src/clients";

import { ZERO_ADDRESS } from "../constants";
import { ethers, getContractFactory, Contract, randomAddress, expect, createSpyLogger, toBN } from "../utils";
import { UsdcTokenSplitterBridge } from "../../src/clients/bridges/op-stack/UsdcTokenSplitterBridge";
import { hashCCTPSourceAndNonce } from "../../src/utils";
import { UsdcCCTPBridge } from "../../src/clients/bridges/op-stack/UsdcCCTPBridge";
import { OpStackBridge } from "../../src/clients/bridges/op-stack/OpStackBridgeInterface";

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

let adapter: OpStackAdapter;

let monitoredEoa: string;
let monitoredEoaAccount: Signer;

let wethBridge: WethBridge;
let snxBridge: SnxOptimismBridge;
let daiBridge: DaiOptimismBridge;
let erc20Bridge: DefaultERC20Bridge;
let usdcCctpBridge: UsdcCCTPBridge;
let usdcTokenSplitterBridge: UsdcTokenSplitterBridge;

let wethBridgeContract: Contract;
let daiBridgeContract: Contract;
let snxBridgeContract: Contract;
let erc20BridgeContract: Contract;
let cctpBridgeContract: Contract;
let cctpMessageTransmitterContract: Contract;

let wethContract: Contract;
let spokePoolContract: Contract;

let searchConfig: utils.EventSearchConfig;

class WethBridgeTest extends WethBridge {
  protected getL1Bridge(): Contract {
    return wethBridgeContract;
  }

  protected getL2Bridge(): Contract {
    return wethBridgeContract;
  }

  protected getL2Weth(): Contract {
    return wethContract;
  }
}

class DaiBridgeTest extends DaiOptimismBridge {
  protected getL1Bridge(): Contract {
    return daiBridgeContract;
  }

  protected getL2Bridge(): Contract {
    return daiBridgeContract;
  }
}

class SnxBridgeTest extends SnxOptimismBridge {
  protected getL1Bridge(): Contract {
    return snxBridgeContract;
  }

  protected getL2Bridge(): Contract {
    return snxBridgeContract;
  }
}

class DefaultERC20BridgeTest extends DefaultERC20Bridge {
  protected getL1Bridge(): Contract {
    return erc20BridgeContract;
  }

  protected getL2Bridge(): Contract {
    return erc20BridgeContract;
  }
}

class UsdcCCTPBridgeTest extends UsdcCCTPBridge {
  protected override getL1Bridge(): Contract {
    return cctpBridgeContract;
  }

  protected override getL2Bridge(): Contract {
    return cctpMessageTransmitterContract;
  }
}

class UsdcTokenSplitterBridgeTest extends UsdcTokenSplitterBridge {
  protected override getCCTPBridge(): UsdcCCTPBridge {
    return usdcCctpBridge;
  }

  protected override getCanonicalBridge(): DefaultERC20Bridge {
    return erc20Bridge;
  }
}

class OpStackAdapterTest extends OpStackAdapter {
  getBridge(l1Token: string): OpStackBridge {
    const overrides = {
      [l1WethAddress]: wethBridge,
      [l1SnxAddress]: snxBridge,
      [l1DaiAddress]: daiBridge,
      [l1Erc20Address]: erc20Bridge,
      [l1UsdcAddress]: usdcTokenSplitterBridge,
    };
    return overrides[l1Token] ?? super.getBridge(l1Token);
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

    wethBridge = new WethBridgeTest(CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, deployer, deployer);
    snxBridge = new SnxBridgeTest(CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, deployer, deployer);
    daiBridge = new DaiBridgeTest(CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, deployer, deployer);
    erc20Bridge = new DefaultERC20BridgeTest(CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, deployer, deployer);
    usdcCctpBridge = new UsdcCCTPBridgeTest(CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, deployer, deployer);
    usdcTokenSplitterBridge = new UsdcTokenSplitterBridgeTest(
      CHAIN_IDs.OPTIMISM,
      CHAIN_IDs.MAINNET,
      deployer,
      deployer
    );

    spokePoolContract = await (await getContractFactory("MockSpokePool", deployer)).deploy(ZERO_ADDRESS);

    const l2SpokePoolClient = new SpokePoolClient(logger, spokePoolContract, null, CHAIN_IDs.OPTIMISM, 0, {
      fromBlock: 0,
    });
    const l1SpokePoolClient = new SpokePoolClient(logger, spokePoolContract, null, CHAIN_IDs.MAINNET, 0, {
      fromBlock: 0,
    });

    adapter = new OpStackAdapterTest(
      CHAIN_IDs.OPTIMISM,
      logger,
      ["WETH", "SNX", "DAI", "WBTC", "USDC"],
      {
        [CHAIN_IDs.OPTIMISM]: l2SpokePoolClient,
        [CHAIN_IDs.MAINNET]: l1SpokePoolClient,
      },
      [monitoredEoa]
    );

    // Required to pass checks in `BaseAdapter.getUpdatedSearchConfigs`
    l2SpokePoolClient.latestBlockSearched = searchConfig.toBlock;
    l1SpokePoolClient.latestBlockSearched = searchConfig.toBlock;
  });

  describe("WETH", function () {
    it("Get L1 initiated events for EOA", async function () {
      // For EOA's only returns transfers originating from atomic depositor address and recipient
      // is the filtered address.
      await wethBridgeContract.emitDepositInitiated(monitoredEoa, randomAddress(), 1);
      await wethBridgeContract.emitDepositInitiated(randomAddress(), monitoredEoa, 1);
      await wethBridgeContract.emitDepositInitiated(atomicDepositorAddress, randomAddress(), 1);
      await wethBridgeContract.emitDepositInitiated(atomicDepositorAddress, monitoredEoa, 1);
      const result = (await wethBridge.queryL1BridgeInitiationEvents(wethContract.address, monitoredEoa, searchConfig))[
        l2WethAddress
      ];
      expect(result.length).to.equal(1);
      expect(result[0].args?._from).to.equal(atomicDepositorAddress);
      expect(result[0].args?._to).to.equal(monitoredEoa);
      expect(result[0].args?._amount).to.equal(1);
    });
    // TODO: Add unit tests when from address is contract but need to change the providers such that we can
    // pretend we are monitoring the hub pool contract.
    it("Get L2 finalized events for EOA", async function () {
      // Counts only finalized events preceding a WETH wrap event.
      // For EOA's, weth transfer from address should be atomic depositor address
      await wethBridgeContract.emitDepositFinalized(atomicDepositorAddress, monitoredEoa, 1);
      const emptyResult = (
        await wethBridge.queryL2BridgeFinalizationEvents(wethContract.address, monitoredEoa, searchConfig)
      )[l2WethAddress];
      expect(emptyResult.length).to.equal(0);

      // Mine Deposit event now.
      await wethContract.connect(monitoredEoaAccount).deposit({ value: 0 });
      const result = (
        await wethBridge.queryL2BridgeFinalizationEvents(wethContract.address, monitoredEoa, searchConfig)
      )[l2WethAddress];
      expect(result.length).to.equal(1);
      expect(result[0].args?._from).to.equal(atomicDepositorAddress);
      expect(result[0].args?._to).to.equal(monitoredEoa);
    });
  });

  describe("Custom bridge: SNX", () => {
    it("return only relevant L1 bridge init events", async () => {
      await snxBridgeContract.emitDepositInitiated(monitoredEoa, notMonitoredEoa, 1);
      await snxBridgeContract.emitDepositInitiated(notMonitoredEoa, monitoredEoa, 1);

      const events = (await snxBridge.queryL1BridgeInitiationEvents(l1SnxAddress, monitoredEoa, searchConfig))[
        l2SnxAddress
      ];
      expect(events.length).to.equal(1);
      // For the SnxBridge, only the `toAddress` is indexed on the L2 event so we treat the `fromAddress` as the
      // toAddress when fetching the L1 event.
      expect(events[0].args?._to).to.equal(monitoredEoa);
      expect(events[0].args?._from).to.equal(notMonitoredEoa);
    });

    it("return only relevant L2 bridge finalization events", async () => {
      await snxBridgeContract.emitDepositFinalized(notMonitoredEoa, 1);
      await snxBridgeContract.emitDepositFinalized(monitoredEoa, 1);

      const events = (await snxBridge.queryL2BridgeFinalizationEvents(l1SnxAddress, monitoredEoa, searchConfig))[
        l2SnxAddress
      ];
      expect(events.length).to.equal(1);
      expect(events[0].args?._to).to.equal(monitoredEoa);
    });
  });

  describe("Custom bridge: DAI", () => {
    it("return only relevant L1 bridge init events", async () => {
      await daiBridgeContract.emitDepositInitiated(l1DaiAddress, l2DaiAddress, monitoredEoa, notMonitoredEoa, 1);
      await daiBridgeContract.emitDepositInitiated(l1DaiAddress, l2DaiAddress, notMonitoredEoa, monitoredEoa, 1);

      const events = (await daiBridge.queryL1BridgeInitiationEvents(l1DaiAddress, monitoredEoa, searchConfig))[
        l2DaiAddress
      ];
      expect(events.length).to.equal(1);
      expect(events[0].args?._from).to.equal(monitoredEoa);
      expect(events[0].args?._to).to.equal(notMonitoredEoa);
    });

    it("return only relevant L2 bridge finalization events", async () => {
      await daiBridgeContract.emitDepositFinalized(l1DaiAddress, l2DaiAddress, monitoredEoa, notMonitoredEoa, 1);
      await daiBridgeContract.emitDepositFinalized(l1DaiAddress, l2DaiAddress, notMonitoredEoa, monitoredEoa, 1);

      const events = (await daiBridge.queryL2BridgeFinalizationEvents(l1DaiAddress, monitoredEoa, searchConfig))[
        l2DaiAddress
      ];
      expect(events.length).to.equal(1);
      expect(events[0].args?._from).to.equal(monitoredEoa);
      expect(events[0].args?._to).to.equal(notMonitoredEoa);
    });
  });

  describe("Default ERC20 bridge", () => {
    it("return only relevant L1 bridge init events", async () => {
      await erc20BridgeContract.emitDepositInitiated(l1Erc20Address, l2Erc20Address, monitoredEoa, notMonitoredEoa, 1);
      await erc20BridgeContract.emitDepositInitiated(l1Erc20Address, l2Erc20Address, notMonitoredEoa, monitoredEoa, 1);

      const events = (await erc20Bridge.queryL1BridgeInitiationEvents(l1Erc20Address, monitoredEoa, searchConfig))[
        l2Erc20Address
      ];
      expect(events.length).to.equal(1);
      expect(events[0].args?._from).to.equal(monitoredEoa);
      expect(events[0].args?._to).to.equal(notMonitoredEoa);
    });

    it("return only relevant L2 bridge finalization events", async () => {
      await erc20BridgeContract.emitDepositFinalized(l1Erc20Address, l2Erc20Address, monitoredEoa, notMonitoredEoa, 1);
      await erc20BridgeContract.emitDepositFinalized(l1Erc20Address, l2Erc20Address, notMonitoredEoa, monitoredEoa, 1);

      const events = (await erc20Bridge.queryL2BridgeFinalizationEvents(l1Erc20Address, monitoredEoa, searchConfig))[
        l2Erc20Address
      ];
      expect(events.length).to.equal(1);
      expect(events[0].args?._from).to.equal(monitoredEoa);
      expect(events[0].args?._to).to.equal(notMonitoredEoa);
    });
  });

  describe("USDC token splitter bridge", () => {
    it("return only relevant L1 bridge init events", async () => {
      const processedNonce = 1;
      const unprocessedNonce = 2;
      await cctpBridgeContract.emitDepositForBurn(
        processedNonce,
        l1UsdcAddress,
        1,
        monitoredEoa,
        ethers.utils.hexZeroPad(monitoredEoa, 32),
        chainIdsToCctpDomains[CHAIN_IDs.OPTIMISM],
        ethers.utils.hexZeroPad(cctpMessageTransmitterContract.address, 32),
        ethers.utils.hexZeroPad(monitoredEoa, 32)
      );
      await cctpBridgeContract.emitDepositForBurn(
        unprocessedNonce,
        l1UsdcAddress,
        1,
        monitoredEoa,
        ethers.utils.hexZeroPad(monitoredEoa, 32),
        chainIdsToCctpDomains[CHAIN_IDs.OPTIMISM],
        ethers.utils.hexZeroPad(cctpMessageTransmitterContract.address, 32),
        ethers.utils.hexZeroPad(monitoredEoa, 32)
      );
      await cctpMessageTransmitterContract.setUsedNonce(
        hashCCTPSourceAndNonce(chainIdsToCctpDomains[CHAIN_IDs.MAINNET], processedNonce),
        processedNonce
      );

      const events = (
        await usdcTokenSplitterBridge.queryL1BridgeInitiationEvents(l1UsdcAddress, monitoredEoa, searchConfig)
      )[l2UsdcAddress];
      expect(events.length).to.equal(1);
      expect(events[0].args?.nonce.toString()).to.equal(unprocessedNonce.toString());
    });
  });

  describe("OpStackAdapter", () => {
    it("return outstanding cross-chain transfers", async () => {
      const finalizedAmount = 2;
      const outstandingAmount = 1;

      // WETH transfers: 1x outstanding
      await wethBridgeContract.emitDepositInitiated(atomicDepositorAddress, monitoredEoa, outstandingAmount);
      // SNX transfers: 1x outstanding, 1x finalized
      await snxBridgeContract.emitDepositInitiated(notMonitoredEoa, monitoredEoa, outstandingAmount);
      await snxBridgeContract.emitDepositInitiated(notMonitoredEoa, monitoredEoa, finalizedAmount);
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
        await wethBridge.queryL1BridgeInitiationEvents(l1WethAddress, monitoredEoa, searchConfig)
      )[l2WethAddress].find((event) => event.args?._amount.toNumber() === outstandingAmount);
      const outstandingSnxEvent = (
        await snxBridge.queryL1BridgeInitiationEvents(l1SnxAddress, monitoredEoa, searchConfig)
      )[l2SnxAddress].find((event) => event.args?._amount.toNumber() === outstandingAmount);
      const outstandingDaiEvent = (
        await daiBridge.queryL1BridgeInitiationEvents(l1DaiAddress, monitoredEoa, searchConfig)
      )[l2DaiAddress].find((event) => event.args?._amount.toNumber() === outstandingAmount);
      const outstandingErc20Event = (
        await erc20Bridge.queryL1BridgeInitiationEvents(l1Erc20Address, monitoredEoa, searchConfig)
      )[l2Erc20Address].find((event) => event.args?._amount.toNumber() === outstandingAmount);

      const outstandingOfMonitored = (
        await adapter.getOutstandingCrossChainTransfers([l1WethAddress, l1SnxAddress, l1DaiAddress, l1Erc20Address])
      )[monitoredEoa];
      expect(outstandingOfMonitored[l1WethAddress][l2WethAddress]).to.deep.equal({
        totalAmount: toBN(1),
        depositTxHashes: [outstandingWethEvent?.transactionHash],
      });
      expect(outstandingOfMonitored[l1SnxAddress][l2SnxAddress]).to.deep.equal({
        totalAmount: toBN(1),
        depositTxHashes: [outstandingSnxEvent?.transactionHash],
      });
      expect(outstandingOfMonitored[l1DaiAddress][l2DaiAddress]).to.deep.equal({
        totalAmount: toBN(1),
        depositTxHashes: [outstandingDaiEvent?.transactionHash],
      });
      expect(outstandingOfMonitored[l1Erc20Address][l2Erc20Address]).to.deep.equal({
        totalAmount: toBN(1),
        depositTxHashes: [outstandingErc20Event?.transactionHash],
      });
    });

    it("return simulated success tx if above threshold", async () => {
      const tx = await adapter.wrapEthIfAboveThreshold(toBN(0), toBN(1), true);
      expect(tx).to.not.be.null;
      expect(tx?.hash).to.equal(ZERO_ADDRESS);
    });
  });
});
