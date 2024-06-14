import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { SpokePoolClient } from "../../src/clients";
import { ArbitrumAdapter, l1Gateways, l2Gateways } from "../../src/clients/bridges/ArbitrumAdapter";
import { ethers, getContractFactory, Contract, randomAddress, expect, toBN } from "../utils";
import { utils, relayFeeCalculator } from "@across-protocol/sdk";
import { ZERO_ADDRESS } from "@uma/common";
import { CONTRACT_ADDRESSES } from "../../src/common";

describe("Cross Chain Adapter: Arbitrum", async function () {
  let adapter: ArbitrumAdapter;
  let defaultAdapter: ArbitrumAdapter;
  let monitoredEoa: string;
  let l1Token: string;
  let l2Token: string;

  let erc20BridgeContract: Contract;
  let searchConfig: utils.EventSearchConfig;

  beforeEach(async function () {
    searchConfig = {
      fromBlock: 1,
      toBlock: 1_000_000,
    };
    const [deployer] = await ethers.getSigners();
    const logger = relayFeeCalculator.DEFAULT_LOGGER;

    monitoredEoa = randomAddress();
    l1Token = TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.MAINNET];
    l2Token = TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.ARBITRUM];

    const spokePool = await (await getContractFactory("MockSpokePool", deployer)).deploy(ZERO_ADDRESS);
    erc20BridgeContract = await (await getContractFactory("ArbitrumERC20Bridge", deployer)).deploy();

    const l2SpokePoolClient = new SpokePoolClient(null, spokePool, null, CHAIN_IDs.ARBITRUM, 0, {
      fromBlock: 0,
    });
    const l1SpokePoolClient = new SpokePoolClient(null, spokePool, null, CHAIN_IDs.MAINNET, 0, {
      fromBlock: 0,
    });

    adapter = new ArbitrumAdapter(
      logger,
      {
        [CHAIN_IDs.ARBITRUM]: l2SpokePoolClient,
        [CHAIN_IDs.MAINNET]: l1SpokePoolClient,
      },
      [monitoredEoa],
      {
        // Override the gateway addresses to use the mocked bridge contract
        l1: {
          [l1Token]: erc20BridgeContract.address,
        },
        l2: {
          [l1Token]: erc20BridgeContract.address,
        },
      }
    );
    defaultAdapter = new ArbitrumAdapter(
      null,
      {
        [CHAIN_IDs.ARBITRUM]: l2SpokePoolClient,
        [CHAIN_IDs.MAINNET]: l1SpokePoolClient,
      },
      []
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
      const tx = await adapter.wrapEthIfAboveThreshold(toBN(0), toBN(1), true, true);
      expect(tx).to.not.be.null;
      expect(tx?.hash).to.equal(ZERO_ADDRESS);
    });
  });

  describe("Contract getters", () => {
    it("return correct L1 bridge contract", async () => {
      const overriddenL1Bridge = adapter.getL1Bridge(l1Token);
      const defaultL1Bridge = defaultAdapter.getL1Bridge(l1Token);

      expect(overriddenL1Bridge.address).to.equal(erc20BridgeContract.address);
      expect(defaultL1Bridge.address).to.equal(l1Gateways[l1Token]);
    });

    it("return correct L2 bridge contract", async () => {
      const overriddenL2Bridge = adapter.getL2Bridge(l1Token);
      const defaultL2Bridge = defaultAdapter.getL2Bridge(l1Token);

      expect(overriddenL2Bridge.address).to.equal(erc20BridgeContract.address);
      expect(defaultL2Bridge.address).to.equal(l2Gateways[l1Token]);
    });

    it("return correct L1 gateway router contract", async () => {
      const gatewayRouter = adapter.getL1GatewayRouter();
      expect(gatewayRouter.address).to.equal(
        CONTRACT_ADDRESSES[CHAIN_IDs.MAINNET]["arbitrumErc20GatewayRouter"].address
      );
    });
  });
});
