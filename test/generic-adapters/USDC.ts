import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { UsdcCCTPBridge } from "../../src/adapter/undirected";
import { ethers, getContractFactory, Contract, randomAddress, expect } from "../utils";
import { utils } from "@across-protocol/sdk";
import { EvmAddress, toBNWei } from "../../src/utils/SDKUtils";
import { BigNumber, getCctpDomainForChainId } from "../../src/utils";
import { CCTPV2_FINALITY_THRESHOLD_FAST } from "../../src/common/Constants";

describe("Cross Chain Adapter: USDC CCTP Bridge", async function () {
  let adapter: MockBaseChainAdapter;
  let monitoredEoa: string;
  let l1USDCToken, l2USDCToken: string;
  let hubChainId, l2ChainId;

  let cctpBridgeContract: Contract;
  let searchConfig: utils.EventSearchConfig;

  const toAddress = (address: string): EvmAddress => {
    return EvmAddress.from(address);
  };
  beforeEach(async function () {
    searchConfig = {
      from: 0,
      to: 1_000_000,
    };
    const [deployer] = await ethers.getSigners();

    monitoredEoa = randomAddress();
    hubChainId = CHAIN_IDs.MAINNET;
    l2ChainId = CHAIN_IDs.LINEA;

    l1USDCToken = TOKEN_SYMBOLS_MAP.USDC.addresses[hubChainId];
    l2USDCToken = TOKEN_SYMBOLS_MAP.USDC.addresses[l2ChainId];
    cctpBridgeContract = await (await getContractFactory("CctpV2TokenMessenger", deployer)).deploy();

    adapter = new MockBaseChainAdapter(l2ChainId, hubChainId, deployer, deployer, toAddress(l1USDCToken), null);
    adapter.setTargetL1Bridge(cctpBridgeContract);
    adapter.setTargetL2Bridge(cctpBridgeContract);
  });
  it("constructWithdrawToL1Txns", async function () {
    const amountToSend = toBNWei("100", 6);
    const expectedMaxFee = amountToSend.div(10000);
    const result = await adapter.constructL1ToL2Txn(
      toAddress(monitoredEoa),
      toAddress(l1USDCToken),
      toAddress(l2USDCToken),
      amountToSend,
      { fastMode: true }
    );
    expect(result.contract.address).to.equal(cctpBridgeContract.address);
    expect(result.method).to.equal("depositForBurn");
    expect(result.args[0]).to.equal(amountToSend.add(expectedMaxFee));
    expect(result.args[1]).to.equal(getCctpDomainForChainId(l2ChainId));
    expect(result.args[2]).to.equal(toAddress(monitoredEoa).toBytes32());
    expect(result.args[3]).to.equal(toAddress(l1USDCToken).toNative());
    expect(result.args[4]).to.equal(ethers.constants.HashZero);
    expect(result.args[5]).to.equal(expectedMaxFee);
    expect(result.args[6]).to.equal(CCTPV2_FINALITY_THRESHOLD_FAST);
  });
  it("queryL1BridgeInitiationEvents", async function () {
    const amount = toBNWei("100", 6);
    await cctpBridgeContract.emitDepositForBurn(
      l1USDCToken,
      amount,
      monitoredEoa,
      toAddress(monitoredEoa),
      getCctpDomainForChainId(l2ChainId),
      toAddress(cctpBridgeContract.address),
      ethers.constants.HashZero
    );
    const event = (
      await adapter.queryL1BridgeInitiationEvents(
        toAddress(l1USDCToken),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      )
    )[l2USDCToken][0];
    expect(event.burnToken).to.equal(l1USDCToken);
    expect(event.amount).to.equal(amount);
    expect(event.depositor).to.equal(monitoredEoa);
    expect(event.mintRecipient).to.equal(toAddress(monitoredEoa).toBytes32());
    expect(event.destinationDomain).to.equal(getCctpDomainForChainId(l2ChainId));
    expect(event.destinationTokenMessenger).to.equal(toAddress(cctpBridgeContract.address).toBytes32());
    expect(event.destinationCaller).to.equal(ethers.constants.HashZero);
  });
  it("queryL2BridgeFinalizationEvents", async function () {
    const amount = toBNWei("100", 6);
    const feeCollected = amount.div(10000);
    await cctpBridgeContract.emitMintAndWithdraw(monitoredEoa, amount.sub(feeCollected), l2USDCToken, feeCollected);
    const event = (
      await adapter.queryL2BridgeFinalizationEvents(
        toAddress(l1USDCToken),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      )
    )[l2USDCToken][0];
    expect(event.mintToken).to.equal(l2USDCToken);
    expect(event.amount).to.equal(amount); // amount in event is modified by adapter to be sum of fee and amount
    expect(event.feeCollected).to.equal(feeCollected);
    expect(event.mintRecipient).to.equal(monitoredEoa);
  });
});

class MockBaseChainAdapter extends UsdcCCTPBridge {
  setTargetL1Bridge(l1Bridge: Contract) {
    this.l1Bridge = l1Bridge;
  }

  setTargetL2Bridge(l2Bridge: Contract) {
    this.l2Bridge = l2Bridge;
  }

  async _getCctpV2DepositForBurnMaxFee(amount: BigNumber): Promise<{ maxFee: BigNumber; finalityThreshold: number }> {
    return Promise.resolve({
      maxFee: amount.div(10000), // 0.01%
      finalityThreshold: CCTPV2_FINALITY_THRESHOLD_FAST,
    });
  }
}
