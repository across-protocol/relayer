import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { SpokePoolClient } from "../../src/clients";
import { ArbitrumAdapter } from "../../src/clients/bridges/ArbitrumAdapter";
import { ethers, getContractFactory, Contract, randomAddress, expect, toBN, createSpyLogger } from "../utils";
import { ZERO_ADDRESS } from "@uma/common";
import { chainIdsToCctpDomains } from "../../src/common";
import { hashCCTPSourceAndNonce } from "../../src/utils";

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

class ArbitrumAdapterTest extends ArbitrumAdapter {
  protected override getL1Bridge(): Contract {
    return erc20BridgeContract;
  }

  protected override getL2Bridge(): Contract {
    return erc20BridgeContract;
  }

  protected override getL1CCTPTokenMessengerBridge(): Contract {
    return cctpBridgeContract;
  }

  protected override getL2CCTPMessageTransmitter(): Contract {
    return cctpMessageTransmitterContract;
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

    adapter = new ArbitrumAdapterTest(
      logger,
      {
        [CHAIN_IDs.ARBITRUM]: l2SpokePoolClient,
        [CHAIN_IDs.MAINNET]: l1SpokePoolClient,
      },
      [monitoredEoa]
    );

    // Required to pass checks in `BaseAdapter.getUpdatedSearchConfigs`
    l2SpokePoolClient.latestBlockSearched = searchConfig.toBlock;
    l1SpokePoolClient.latestBlockSearched = searchConfig.toBlock;
  });

  describe("ERC20", () => {
    it("get DepositInitiated events from L1", async () => {
      await erc20BridgeContract.emitDepositInitiated(l1Token, randomAddress(), monitoredEoa, 0, 1);
      await erc20BridgeContract.emitDepositInitiated(l1Token, monitoredEoa, randomAddress(), 1, 1);

      const depositInitiatedEvents = await adapter.getL1DepositInitiatedEvents(l1Token, monitoredEoa, searchConfig);
      expect(depositInitiatedEvents).to.have.lengthOf(1);
      expect(depositInitiatedEvents[0].args?._sequenceNumber.toNumber()).to.equal(1);
      expect(depositInitiatedEvents[0].args?._amount.toNumber()).to.equal(1);
      expect(depositInitiatedEvents[0].args?._from).to.equal(monitoredEoa);
    });

    it("get DepositFinalized events from L2", async () => {
      await erc20BridgeContract.emitDepositFinalized(l1Token, randomAddress(), monitoredEoa, 1);
      await erc20BridgeContract.emitDepositFinalized(l1Token, monitoredEoa, randomAddress(), 1);

      const depositFinalizedEvents = await adapter.getL2DepositFinalizedEvents(l1Token, monitoredEoa, searchConfig);
      expect(depositFinalizedEvents).to.have.lengthOf(1);
      expect(depositFinalizedEvents[0].args?.amount.toNumber()).to.equal(1);
      expect(depositFinalizedEvents[0].args?.from).to.equal(monitoredEoa);
    });

    it("get outstanding cross-chain transfers", async () => {
      // Deposits that do not originate from monitoredEoa should be ignored
      await erc20BridgeContract.emitDepositInitiated(l1Token, randomAddress(), monitoredEoa, 0, 1);
      await erc20BridgeContract.emitDepositFinalized(l1Token, randomAddress(), monitoredEoa, 1);
      // Finalized deposits that should not be considered as outstanding
      await erc20BridgeContract.emitDepositInitiated(l1Token, monitoredEoa, randomAddress(), 1, 1);
      await erc20BridgeContract.emitDepositFinalized(l1Token, monitoredEoa, randomAddress(), 1);
      // Outstanding deposits
      await erc20BridgeContract.emitDepositInitiated(l1Token, monitoredEoa, randomAddress(), 2, 1);

      const depositEvents = await adapter.getL1DepositInitiatedEvents(l1Token, monitoredEoa, searchConfig);
      const outstandingDepositEvent = depositEvents.find((e) => e.args?._sequenceNumber.toNumber() === 2);
      const outstandingTransfers = await adapter.getOutstandingCrossChainTransfers([l1Token]);

      expect(outstandingTransfers[monitoredEoa][l1Token][l2Token]).to.deep.equal({
        totalAmount: toBN(1),
        depositTxHashes: [outstandingDepositEvent?.transactionHash],
      });
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
        chainIdsToCctpDomains[CHAIN_IDs.ARBITRUM],
        ethers.utils.hexZeroPad(cctpMessageTransmitterContract.address, 32),
        ethers.utils.hexZeroPad(monitoredEoa, 32)
      );
      await cctpBridgeContract.emitDepositForBurn(
        unprocessedNonce,
        l1UsdcAddress,
        1,
        monitoredEoa,
        ethers.utils.hexZeroPad(monitoredEoa, 32),
        chainIdsToCctpDomains[CHAIN_IDs.ARBITRUM],
        ethers.utils.hexZeroPad(cctpMessageTransmitterContract.address, 32),
        ethers.utils.hexZeroPad(monitoredEoa, 32)
      );
      await cctpMessageTransmitterContract.setUsedNonce(
        hashCCTPSourceAndNonce(chainIdsToCctpDomains[CHAIN_IDs.MAINNET], processedNonce),
        processedNonce
      );
      const outstandingTransfers = await adapter.getOutstandingCrossChainTransfers([l1UsdcAddress]);
      expect(outstandingTransfers[monitoredEoa][l1UsdcAddress][l2UsdcAddress].totalAmount).to.equal(toBN(1));
    });
  });
});
