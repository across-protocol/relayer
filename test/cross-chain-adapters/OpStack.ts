import { CHAIN_IDs } from "@across-protocol/constants-v2";
import { ethers, getContractFactory, Contract, randomAddress, expect } from "../utils";
import { utils } from "@across-protocol/sdk-v2";
import { CONTRACT_ADDRESSES } from "../../src/common";
import { WethBridge } from "../../src/clients/bridges/op-stack/WethBridge";
import { Signer } from "ethers";

describe("Cross Chain Adapter: OP Stack", async function () {
  let monitoredEoa: string;
  let atomicDepositorAddress: string;
  let monitoredEoaAccount: Signer;

  let wethBridge: WethBridge;
  let wethBridgeContract: Contract;
  let wethContract: Contract;
  let searchConfig: utils.EventSearchConfig;

  beforeEach(async function () {
    searchConfig = {
      fromBlock: 0,
      toBlock: 1_000_000,
    };
    [monitoredEoaAccount] = await ethers.getSigners();

    monitoredEoa = monitoredEoaAccount.address;
    atomicDepositorAddress = CONTRACT_ADDRESSES[CHAIN_IDs.MAINNET].atomicDepositor.address;

    wethBridge = new WethBridge(CHAIN_IDs.OPTIMISM, CHAIN_IDs.MAINNET, monitoredEoaAccount, monitoredEoaAccount);

    wethBridgeContract = await (await getContractFactory("OpStackWethBridge", monitoredEoaAccount)).deploy();
    wethContract = await (await getContractFactory("WETH9", monitoredEoaAccount)).deploy();
  });

  describe("WETH", function () {
    it("Get L1 initiated events for EOA", async function () {
      // For EOA's only returns transfers originating from atomic depositor address and recipient
      // is the filtered address.
      await wethBridgeContract.emitDepositInitiated(monitoredEoa, randomAddress(), 1);
      await wethBridgeContract.emitDepositInitiated(randomAddress(), monitoredEoa, 1);
      await wethBridgeContract.emitDepositInitiated(atomicDepositorAddress, randomAddress(), 1);
      await wethBridgeContract.emitDepositInitiated(atomicDepositorAddress, monitoredEoa, 1);
      const result = await wethBridge.queryL1BridgeInitiationEvents(
        wethContract.address,
        monitoredEoa,
        searchConfig,
        wethBridgeContract
      );
      expect(result.length).to.equal(1);
      expect(result[0].args._from).to.equal(atomicDepositorAddress);
      expect(result[0].args._to).to.equal(monitoredEoa);
      expect(result[0].args._amount).to.equal(1);
    });
    // TODO: Add unit tests when from address is contract but need to change the providers such that we can
    // pretend we are monitoring the hub pool contract.
    it("Get L2 finalized events for EOA", async function () {
      // Counts only finalized events preceding a WETH wrap event.
      // For EOA's, weth transfer from address should be atomic depositor address
      await wethBridgeContract.emitDepositFinalized(atomicDepositorAddress, monitoredEoa, 1);
      const emptyResult = await wethBridge.queryL2BridgeFinalizationEvents(
        wethContract.address,
        monitoredEoa,
        searchConfig,
        wethBridgeContract,
        wethContract
      );
      expect(emptyResult.length).to.equal(0);

      // Mine Deposit event now.
      await wethContract.connect(monitoredEoaAccount).deposit({ value: 0 });
      const result = await wethBridge.queryL2BridgeFinalizationEvents(
        wethContract.address,
        monitoredEoa,
        searchConfig,
        wethBridgeContract,
        wethContract
      );
      expect(result.length).to.equal(1);
      expect(result[0].args._from).to.equal(atomicDepositorAddress);
      expect(result[0].args._to).to.equal(monitoredEoa);
    });
  });
});
