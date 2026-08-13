import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { utils } from "@across-protocol/sdk";
import { ArbitrumOrbitBridge } from "../../src/adapter/l2Bridges/ArbitrumOrbitBridge";
import { EvmAddress, toBNWei } from "../../src/utils/SDKUtils";
import { Contract, ethers, expect, getContractFactory, randomAddress } from "../utils";

describe("Cross Chain Adapter: Arbitrum Orbit L2 Bridge", function () {
  const hubChainId = CHAIN_IDs.MAINNET;
  const l2ChainId = CHAIN_IDs.ROBINHOOD;
  const l1Token = TOKEN_SYMBOLS_MAP.WETH.addresses[hubChainId];
  const l2Token = TOKEN_SYMBOLS_MAP.WETH.addresses[l2ChainId];
  const l1Usdc = TOKEN_SYMBOLS_MAP.USDC.addresses[hubChainId];

  const toAddress = (address: string): EvmAddress => EvmAddress.from(address);
  const searchConfig: utils.EventSearchConfig = { from: 0, to: 1_000_000 };
  const amount = toBNWei("3");

  let adapter: MockArbitrumOrbitBridge;
  let l2Gateway: Contract;
  let l1Gateway: Contract;
  let monitoredEoa: string;

  const pendingAmount = () =>
    adapter.getL2PendingWithdrawalAmount(searchConfig, searchConfig, toAddress(monitoredEoa), toAddress(l2Token));

  beforeEach(async function () {
    const [deployer] = await ethers.getSigners();
    monitoredEoa = randomAddress();

    l2Gateway = await (await getContractFactory("ArbitrumERC20Gateway", deployer)).deploy();
    l1Gateway = await (await getContractFactory("ArbitrumERC20Gateway", deployer)).deploy();

    adapter = new MockArbitrumOrbitBridge(l2ChainId, hubChainId, deployer, deployer, toAddress(l1Token));
    adapter.setTargetL2Bridge(l2Gateway);
    adapter.setTargetL1Bridge(l1Gateway);
  });

  it("counts an initiated withdrawal as pending", async function () {
    await l2Gateway.emitWithdrawalInitiated(l1Token, monitoredEoa, monitoredEoa, 1, 1, amount);
    expect(await pendingAmount()).to.equal(amount);
  });

  it("stops counting a withdrawal once it is finalized on L1", async function () {
    await l2Gateway.emitWithdrawalInitiated(l1Token, monitoredEoa, monitoredEoa, 1, 1, amount);
    await l1Gateway.emitWithdrawalFinalized(l1Token, monitoredEoa, monitoredEoa, 1, amount);
    expect(await pendingAmount()).to.equal(0);
  });

  it("counts each initiated withdrawal against at most one finalization", async function () {
    await l2Gateway.emitWithdrawalInitiated(l1Token, monitoredEoa, monitoredEoa, 1, 1, amount);
    await l2Gateway.emitWithdrawalInitiated(l1Token, monitoredEoa, monitoredEoa, 2, 2, amount);
    await l1Gateway.emitWithdrawalFinalized(l1Token, monitoredEoa, monitoredEoa, 1, amount);
    expect(await pendingAmount()).to.equal(amount);
  });

  it("ignores withdrawals of other tokens on a shared gateway", async function () {
    await l2Gateway.emitWithdrawalInitiated(l1Usdc, monitoredEoa, monitoredEoa, 1, 1, amount);
    expect(await pendingAmount()).to.equal(0);
  });

  it("does not net out a finalization of a different token", async function () {
    await l2Gateway.emitWithdrawalInitiated(l1Token, monitoredEoa, monitoredEoa, 1, 1, amount);
    await l1Gateway.emitWithdrawalFinalized(l1Usdc, monitoredEoa, monitoredEoa, 1, amount);
    expect(await pendingAmount()).to.equal(amount);
  });
});

class MockArbitrumOrbitBridge extends ArbitrumOrbitBridge {
  setTargetL1Bridge(l1Bridge: Contract) {
    this.l1Bridge = l1Bridge;
  }

  setTargetL2Bridge(l2Bridge: Contract) {
    this.l2Bridge = l2Bridge;
  }
}
