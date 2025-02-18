import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { SpokePoolClient } from "../../src/clients";
import { BaseChainAdapter } from "../../src/adapter";
import { ArbitrumOrbitBridge, UsdcTokenSplitterBridge } from "../../src/adapter/bridges";
import { ethers, getContractFactory, Contract, randomAddress, expect, toBN, createSpyLogger } from "../utils";
import { ZERO_ADDRESS } from "@uma/common";
import { SUPPORTED_TOKENS } from "../../src/common";
import { hashCCTPSourceAndNonce, getCctpDomainForChainId } from "../../src/utils";

const logger = createSpyLogger().spyLogger;
const searchConfig = {
  fromBlock: 1,
  toBlock: 1_000_000,
};

const monitoredEoa = randomAddress();
const l1Token = TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.MAINNET];
const l2Token = TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.ARBITRUM];
const l1UsdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET];
const l2UsdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.ARBITRUM];

let erc20BridgeContract: Contract;
let cctpBridgeContract: Contract;
let cctpMessageTransmitterContract: Contract;

let adapter: ArbitrumAdapter;

class ArbitrumAdapter extends BaseChainAdapter {
  setL1Bridge(address: string, bridge: Contract) {
    this.bridges[address].l1Bridge = bridge;
  }

  setL2Bridge(address: string, bridge: Contract) {
    this.bridges[address].l2Bridge = bridge;
  }

  setCCTPL1Bridge(address: string, bridge: Contract) {
    this.bridges[address].cctpBridge.l1Bridge = bridge;
  }

  setCCTPL2Bridge(address: string, bridge: Contract) {
    this.bridges[address].cctpBridge.l2Bridge = bridge;
  }
}

describe("Cross Chain Adapter: Arbitrum", async function () {
  beforeEach(async function () {
    const [deployer] = await ethers.getSigners();

    const spokePool = await (await getContractFactory("MockSpokePool", deployer)).deploy(ZERO_ADDRESS);

    erc20BridgeContract = await (await getContractFactory("ArbitrumERC20Bridge", deployer)).deploy();
    cctpBridgeContract = await (await getContractFactory("CctpTokenMessenger", deployer)).deploy();
    cctpMessageTransmitterContract = await (await getContractFactory("CctpMessageTransmitter", deployer)).deploy();

    const l2SpokePoolClient = new SpokePoolClient(logger, spokePool, null, CHAIN_IDs.ARBITRUM, 0, {
      fromBlock: 0,
    });
    const l1SpokePoolClient = new SpokePoolClient(logger, spokePool, null, CHAIN_IDs.MAINNET, 0, {
      fromBlock: 0,
    });

    const l1Signer = l1SpokePoolClient.spokePool.signer;
    const l2Signer = l2SpokePoolClient.spokePool.signer;
    const bridges = {
      [l1Token]: new ArbitrumOrbitBridge(CHAIN_IDs.ARBITRUM, CHAIN_IDs.MAINNET, l1Signer, l2Signer, l1Token),
      [l1UsdcAddress]: new UsdcTokenSplitterBridge(
        CHAIN_IDs.ARBITRUM,
        CHAIN_IDs.MAINNET,
        l1Signer,
        l2Signer,
        l1UsdcAddress
      ),
    };

    adapter = new ArbitrumAdapter(
      {
        [CHAIN_IDs.ARBITRUM]: l2SpokePoolClient,
        [CHAIN_IDs.MAINNET]: l1SpokePoolClient,
      },
      CHAIN_IDs.ARBITRUM,
      CHAIN_IDs.MAINNET,
      [monitoredEoa],
      logger,
      SUPPORTED_TOKENS[CHAIN_IDs.ARBITRUM], // Supported Tokens.
      bridges,
      1
    );

    // Set the adapter bridges to appropriate contracts.
    adapter.setL1Bridge(l1Token, erc20BridgeContract);
    adapter.setL2Bridge(l1Token, erc20BridgeContract);
    adapter.setCCTPL1Bridge(l1UsdcAddress, cctpBridgeContract);
    adapter.setCCTPL2Bridge(l1UsdcAddress, cctpMessageTransmitterContract);

    // Required to pass checks in `BaseAdapter.getUpdatedSearchConfigs`
    l2SpokePoolClient.latestBlockSearched = searchConfig.toBlock;
    l1SpokePoolClient.latestBlockSearched = searchConfig.toBlock;
  });

  describe("ERC20", () => {
    it("get DepositInitiated events from L1", async () => {
      await erc20BridgeContract.emitDepositInitiated(l1Token, monitoredEoa, monitoredEoa, 0, 1);
      await erc20BridgeContract.emitDepositInitiated(l1Token, monitoredEoa, randomAddress(), 1, 1);

      const depositInitiatedEvents = await adapter.bridges[l1Token].queryL1BridgeInitiationEvents(
        l1Token,
        monitoredEoa,
        monitoredEoa,
        searchConfig
      );
      expect(depositInitiatedEvents[l2Token]).to.have.lengthOf(1);
      expect(depositInitiatedEvents[l2Token][0]._sequenceNumber.toNumber()).to.equal(0);
      expect(depositInitiatedEvents[l2Token][0]._amount.toNumber()).to.equal(1);
      expect(depositInitiatedEvents[l2Token][0].from).to.equal(monitoredEoa);
      expect(depositInitiatedEvents[l2Token][0].to).to.equal(monitoredEoa);
    });

    it("get DepositFinalized events from L2", async () => {
      await erc20BridgeContract.emitDepositFinalized(l1Token, monitoredEoa, monitoredEoa, 1);
      await erc20BridgeContract.emitDepositFinalized(l1Token, monitoredEoa, randomAddress(), 1);

      const depositFinalizedEvents = await adapter.bridges[l1Token].queryL2BridgeFinalizationEvents(
        l1Token,
        monitoredEoa,
        monitoredEoa,
        searchConfig
      );
      expect(depositFinalizedEvents[l2Token]).to.have.lengthOf(1);
      expect(depositFinalizedEvents[l2Token][0].amount.toNumber()).to.equal(1);
      expect(depositFinalizedEvents[l2Token][0].from).to.equal(monitoredEoa);
    });

    it("get outstanding cross-chain transfers", async () => {
      // Deposits that do not originate from monitoredEoa should be ignored
      await erc20BridgeContract.emitDepositInitiated(l1Token, monitoredEoa, monitoredEoa, 0, 1);
      await erc20BridgeContract.emitDepositFinalized(l1Token, monitoredEoa, monitoredEoa, 1);
      // Finalized deposits that should not be considered as outstanding
      await erc20BridgeContract.emitDepositInitiated(l1Token, monitoredEoa, monitoredEoa, 1, 1);
      await erc20BridgeContract.emitDepositFinalized(l1Token, monitoredEoa, monitoredEoa, 1);
      // Outstanding deposits
      const outstandingDepositEvent = await erc20BridgeContract.emitDepositInitiated(
        l1Token,
        monitoredEoa,
        monitoredEoa,
        2,
        1
      );

      const outstandingTransfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);
      const transferObject = outstandingTransfers[monitoredEoa][l1Token][l2Token];
      expect(transferObject.totalAmount).to.equal(toBN(1));
      expect(transferObject.depositTxHashes).to.deep.equal([outstandingDepositEvent.hash]);
    });
  });

  describe("Wrap ETH", () => {
    it("return simulated success tx if above threshold", async () => {
      const tx = await adapter.wrapEthIfAboveThreshold(toBN(0), toBN(1), true);
      expect(tx).to.not.be.null;
      expect(tx?.hash).to.equal(ZERO_ADDRESS);
    });
  });

  describe("CCTP", () => {
    it("return only relevant L1 bridge init events", async () => {
      const processedNonce = 1;
      const unprocessedNonce = 2;
      await cctpBridgeContract.emitDepositForBurn(
        processedNonce,
        l1UsdcAddress,
        1,
        monitoredEoa,
        ethers.utils.hexZeroPad(monitoredEoa, 32),
        getCctpDomainForChainId(CHAIN_IDs.ARBITRUM),
        ethers.utils.hexZeroPad(cctpMessageTransmitterContract.address, 32),
        ethers.utils.hexZeroPad(monitoredEoa, 32)
      );
      await cctpBridgeContract.emitDepositForBurn(
        unprocessedNonce,
        l1UsdcAddress,
        1,
        monitoredEoa,
        ethers.utils.hexZeroPad(monitoredEoa, 32),
        getCctpDomainForChainId(CHAIN_IDs.ARBITRUM),
        ethers.utils.hexZeroPad(cctpMessageTransmitterContract.address, 32),
        ethers.utils.hexZeroPad(monitoredEoa, 32)
      );
      await cctpMessageTransmitterContract.setUsedNonce(
        hashCCTPSourceAndNonce(getCctpDomainForChainId(CHAIN_IDs.MAINNET), processedNonce),
        processedNonce
      );
      const outstandingTransfers = await adapter.getOutstandingCrossChainTransfers([l1UsdcAddress]);
      expect(outstandingTransfers[monitoredEoa][l1UsdcAddress][l2UsdcAddress].totalAmount).to.equal(toBN(1));
    });
  });
});
