import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { ZKStackBaseTokenBridge } from "../../src/adapter/l2Bridges/ZKStackBaseTokenBridge";
import { ethers, getContractFactory, Contract, randomAddress, expect } from "../utils";
import { utils } from "@across-protocol/sdk";
import { EvmAddress, toBNWei } from "../../src/utils/SDKUtils";

describe("Cross Chain Adapter: ZkStack Base Token L2 Bridge", function () {
  let adapter: MockZKStackBaseTokenBridge;
  let monitoredEoa: string;
  let l1Token, l2Token: string;
  let hubChainId, l2ChainId;

  let l2BaseTokenContract: Contract;
  let l1NativeTokenVaultContract: Contract;
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
    l2ChainId = CHAIN_IDs.LENS;

    l1Token = TOKEN_SYMBOLS_MAP.WGHO.addresses[hubChainId];
    l2Token = TOKEN_SYMBOLS_MAP.WGHO.addresses[l2ChainId];
    l2BaseTokenContract = await (await getContractFactory("zkSync_L2BaseToken", deployer)).deploy();
    l1NativeTokenVaultContract = await (await getContractFactory("zkSync_L1NativeTokenVault", deployer)).deploy();

    adapter = new MockZKStackBaseTokenBridge(l2ChainId, hubChainId, deployer, deployer, toAddress(l1Token));
    adapter.setTargetL1Bridge(l1NativeTokenVaultContract);
    adapter.setTargetL2Bridge(l2BaseTokenContract);
  });
  it("constructWithdrawToL1Txns", async function () {
    const amountToWithdraw = toBNWei("100");
    const [unwrapTxn, withdrawTxn] = await adapter.constructWithdrawToL1Txns(
      toAddress(monitoredEoa),
      toAddress(l2Token),
      toAddress(l1Token),
      amountToWithdraw
    );
    // The first transaction unwraps the wrapped base token (e.g. WGHO -> GHO).
    expect(unwrapTxn.chainId).to.equal(l2ChainId);
    expect(unwrapTxn.contract.address).to.equal(l2Token);
    expect(unwrapTxn.method).to.equal("withdraw");
    expect(unwrapTxn.args[0]).to.equal(amountToWithdraw);
    // The second transaction withdraws the base token to L1 via the L2BaseToken system contract.
    expect(withdrawTxn.chainId).to.equal(l2ChainId);
    expect(withdrawTxn.contract.address).to.equal(l2BaseTokenContract.address);
    expect(withdrawTxn.method).to.equal("withdraw");
    expect(withdrawTxn.args[0]).to.equal(toAddress(monitoredEoa).toNative());
    expect(withdrawTxn.value).to.equal(amountToWithdraw);
  });
  it("getL2PendingWithdrawalAmount", async function () {
    const amountToWithdraw = toBNWei("100");
    await l2BaseTokenContract.emitWithdrawal(monitoredEoa, monitoredEoa, amountToWithdraw);
    let amount = await adapter.getL2PendingWithdrawalAmount(
      searchConfig,
      searchConfig,
      toAddress(monitoredEoa),
      toAddress(l2Token)
    );
    expect(amount).to.equal(amountToWithdraw);
    await l1NativeTokenVaultContract.emitBridgeMint(l2ChainId, l1Token, monitoredEoa, amountToWithdraw);
    amount = await adapter.getL2PendingWithdrawalAmount(
      searchConfig,
      searchConfig,
      toAddress(monitoredEoa),
      toAddress(l2Token)
    );
    expect(amount).to.equal(0);
  });
  it("getL2PendingWithdrawalAmount: ignores unrelated senders and receivers", async function () {
    const amountToWithdraw = toBNWei("100");
    const otherEoa = randomAddress();
    // Withdrawals from other senders are not counted.
    await l2BaseTokenContract.emitWithdrawal(otherEoa, otherEoa, amountToWithdraw);
    let amount = await adapter.getL2PendingWithdrawalAmount(
      searchConfig,
      searchConfig,
      toAddress(monitoredEoa),
      toAddress(l2Token)
    );
    expect(amount).to.equal(0);
    // Finalizations to other receivers do not offset the monitored address' pending withdrawals.
    await l2BaseTokenContract.emitWithdrawal(monitoredEoa, monitoredEoa, amountToWithdraw);
    await l1NativeTokenVaultContract.emitBridgeMint(l2ChainId, l1Token, otherEoa, amountToWithdraw);
    amount = await adapter.getL2PendingWithdrawalAmount(
      searchConfig,
      searchConfig,
      toAddress(monitoredEoa),
      toAddress(l2Token)
    );
    expect(amount).to.equal(amountToWithdraw);
  });
});

class MockZKStackBaseTokenBridge extends ZKStackBaseTokenBridge {
  setTargetL1Bridge(l1Bridge: Contract) {
    this.l1Bridge = l1Bridge;
  }

  setTargetL2Bridge(l2Bridge: Contract) {
    this.l2Bridge = l2Bridge;
  }
}
