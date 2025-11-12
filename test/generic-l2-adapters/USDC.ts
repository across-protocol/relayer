import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { UsdcCCTPBridge } from "../../src/adapter/directed/l2ToL1/UsdcCCTPBridge";
import { ethers, getContractFactory, Contract, randomAddress, expect } from "../utils";
import { utils } from "@across-protocol/sdk";
import { EvmAddress, toBNWei } from "../../src/utils/SDKUtils";
import { BigNumber, getCctpDomainForChainId } from "../../src/utils";
import { CCTPV2_FINALITY_THRESHOLD_FAST } from "../../src/common/Constants";

describe("Cross Chain Adapter: USDC CCTP L2 Bridge", async function () {
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

    adapter = new MockBaseChainAdapter(l2ChainId, hubChainId, deployer, deployer, toAddress(l1USDCToken));
    adapter.setTargetL1Bridge(cctpBridgeContract);
    adapter.setTargetL2Bridge(cctpBridgeContract);
  });
  it("constructWithdrawToL1Txns", async function () {
    const amountToWithdraw = toBNWei("100", 6);
    const expectedMaxFee = amountToWithdraw.div(10000);
    const result = (
      await adapter.constructWithdrawToL1Txns(
        toAddress(monitoredEoa),
        toAddress(l2USDCToken),
        toAddress(l1USDCToken),
        amountToWithdraw,
        { fastMode: true }
      )
    )[0];
    expect(result.chainId).to.equal(l2ChainId);
    expect(result.contract.address).to.equal(cctpBridgeContract.address);
    expect(result.method).to.equal("depositForBurn");
    expect(result.args[0]).to.equal(amountToWithdraw.add(expectedMaxFee));
    expect(result.args[1]).to.equal(getCctpDomainForChainId(hubChainId));
    expect(result.args[2]).to.equal(toAddress(monitoredEoa).toBytes32());
    expect(result.args[3]).to.equal(toAddress(l2USDCToken).toNative());
    expect(result.args[4]).to.equal(ethers.constants.HashZero);
    expect(result.args[5]).to.equal(expectedMaxFee);
    expect(result.args[6]).to.equal(CCTPV2_FINALITY_THRESHOLD_FAST);
  });
  it("getL2PendingWithdrawalAmount", async function () {
    const amountToWithdraw = toBNWei("100", 6);
    await cctpBridgeContract.emitDepositForBurn(
      l2USDCToken,
      amountToWithdraw,
      monitoredEoa,
      toAddress(monitoredEoa),
      getCctpDomainForChainId(hubChainId),
      toAddress(cctpBridgeContract.address),
      ethers.constants.HashZero
    );
    let amount = await adapter.getL2PendingWithdrawalAmount(
      searchConfig,
      searchConfig,
      toAddress(monitoredEoa),
      toAddress(l2USDCToken)
    );
    expect(amount).to.equal(amountToWithdraw);
    const feeCollected = amountToWithdraw.div(10000);
    await cctpBridgeContract.emitMintAndWithdraw(
      monitoredEoa,
      amountToWithdraw.sub(feeCollected),
      l1USDCToken,
      feeCollected
    );
    amount = await adapter.getL2PendingWithdrawalAmount(
      searchConfig,
      searchConfig,
      toAddress(monitoredEoa),
      toAddress(l2USDCToken)
    );
    expect(amount).to.equal(0);
  });
  it("requiredTokenApprovals", async function () {
    const approvals = adapter.requiredTokenApprovals();
    expect(approvals).to.deep.equal([{ token: toAddress(l2USDCToken), bridge: toAddress(cctpBridgeContract.address) }]);
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
