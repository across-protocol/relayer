import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { utils } from "@across-protocol/sdk";
import { ZKStackBridge } from "../../src/adapter/l2Bridges/ZKStackBridge";
import { ZKStackNativeBridge } from "../../src/adapter/l2Bridges/ZKStackNativeBridge";
import { BinanceCEXBridge } from "../../src/adapter/l2Bridges";
import { CANONICAL_L2_BRIDGE, CUSTOM_L2_BRIDGE, getContractEntry, SUPPORTED_TOKENS } from "../../src/common";
import { EvmAddress, toBNWei } from "../../src/utils/SDKUtils";
import { Contract, ethers, expect, getContractFactory, randomAddress } from "../utils";

const toAddress = (address: string): EvmAddress => EvmAddress.from(address);

describe("Cross Chain Adapter: ZK Stack L2 Bridge", function () {
  const hubChainId = CHAIN_IDs.MAINNET;
  const l2ChainId = CHAIN_IDs.ZK_SYNC;

  const l1Token = TOKEN_SYMBOLS_MAP.USDT.addresses[hubChainId];
  const l2Token = TOKEN_SYMBOLS_MAP.USDT.addresses[l2ChainId];
  // zkSync's WETH is the native token vault's WETH_TOKEN, which the vault refuses to burn.
  const l1Weth = TOKEN_SYMBOLS_MAP.WETH.addresses[hubChainId];
  const l2Weth = TOKEN_SYMBOLS_MAP.WETH.addresses[l2ChainId];

  let adapter: MockZKStackBridge;
  let monitoredEoa: string;
  let nativeTokenVault: Contract;
  let searchConfig: utils.EventSearchConfig;

  beforeEach(async function () {
    searchConfig = { from: 0, to: 1_000_000 };
    const [deployer] = await ethers.getSigners();
    monitoredEoa = randomAddress();

    nativeTokenVault = await (await getContractFactory("zkStack_NativeTokenVault", deployer)).deploy();
    await nativeTokenVault.registerToken(l2Token);
    await nativeTokenVault.setWethToken(l2Weth);

    adapter = new MockZKStackBridge(l2ChainId, hubChainId, deployer, deployer, toAddress(l1Token));
    // The vault contract is deployed at the same address on both sides, so one mock serves as both.
    adapter.setTargetL1Bridge(nativeTokenVault);
    adapter.setTargetL2Bridge(nativeTokenVault);
  });

  it("constructWithdrawToL1Txns withdraws via the asset router", async function () {
    const amountToWithdraw = toBNWei("100", 6);
    const txns = await adapter.constructWithdrawToL1Txns(
      toAddress(monitoredEoa),
      toAddress(l2Token),
      toAddress(l1Token),
      amountToWithdraw
    );

    expect(txns.length).to.equal(1);
    const [result] = txns;
    expect(result.chainId).to.equal(l2ChainId);
    // The transaction target is the asset router, not the vault that sources the events.
    expect(result.contract.address).to.equal(getContractEntry(l2ChainId, "assetRouter").address);
    expect(result.method).to.equal("withdraw");
    expect(result.nonMulticall).to.be.true;
    expect(result.args[0]).to.equal(await nativeTokenVault.assetId(l2Token));
    // NativeTokenVault.decodeBridgeBurnData expects exactly (amount, l1Receiver, l2Token).
    expect(result.args[1]).to.equal(
      ethers.utils.defaultAbiCoder.encode(
        ["uint256", "address", "address"],
        [amountToWithdraw, monitoredEoa, toAddress(l2Token).toNative()]
      )
    );
  });

  it("refuses to withdraw the chain's wrapped native token", async function () {
    // WETH is registered, but the vault still cannot burn it, so an assetId check alone is not sufficient.
    await nativeTokenVault.registerToken(l2Weth);
    const wethAdapter = new MockZKStackBridge(l2ChainId, hubChainId, ...(await signers()), toAddress(l1Weth));
    wethAdapter.setTargetL2Bridge(nativeTokenVault);
    wethAdapter.setTargetL1Bridge(nativeTokenVault);

    const txns = await wethAdapter.constructWithdrawToL1Txns(
      toAddress(monitoredEoa),
      toAddress(l2Weth),
      toAddress(l1Weth),
      toBNWei("1")
    );
    expect(txns.length).to.equal(0);
  });

  it("refuses to withdraw a token that is unregistered in the vault", async function () {
    const unregistered = randomAddress();
    const txns = await adapter.constructWithdrawToL1Txns(
      toAddress(monitoredEoa),
      toAddress(unregistered),
      toAddress(l1Token),
      toBNWei("100", 6)
    );
    expect(txns.length).to.equal(0);
  });

  it("getL2PendingWithdrawalAmount reconciles the L2 burn against the L1 mint", async function () {
    const amountToWithdraw = toBNWei("100", 6);

    // The burn is emitted on L2 against the hub chain...
    await nativeTokenVault.emitBridgeBurn(hubChainId, l2Token, monitoredEoa, monitoredEoa, amountToWithdraw);
    expect(
      await adapter.getL2PendingWithdrawalAmount(
        searchConfig,
        searchConfig,
        toAddress(monitoredEoa),
        toAddress(l2Token)
      )
    ).to.equal(amountToWithdraw);

    // ...and the matching mint on L1 against the L2 chain, which settles it.
    await nativeTokenVault.emitBridgeMint(l2ChainId, l2Token, monitoredEoa, amountToWithdraw);
    expect(
      await adapter.getL2PendingWithdrawalAmount(
        searchConfig,
        searchConfig,
        toAddress(monitoredEoa),
        toAddress(l2Token)
      )
    ).to.equal(0);
  });

  it("getL2PendingWithdrawalAmount ignores mints destined for another address", async function () {
    const amountToWithdraw = toBNWei("100", 6);
    await nativeTokenVault.emitBridgeBurn(hubChainId, l2Token, monitoredEoa, monitoredEoa, amountToWithdraw);
    await nativeTokenVault.emitBridgeMint(l2ChainId, l2Token, randomAddress(), amountToWithdraw);

    expect(
      await adapter.getL2PendingWithdrawalAmount(
        searchConfig,
        searchConfig,
        toAddress(monitoredEoa),
        toAddress(l2Token)
      )
    ).to.equal(amountToWithdraw);
  });

  it("requiredTokenApprovals names the native token vault as the spender", async function () {
    const approvals = adapter.requiredTokenApprovals();
    expect(approvals.length).to.equal(1);
    expect(approvals[0].token.eq(toAddress(l2Token))).to.be.true;
    expect(approvals[0].bridge.eq(toAddress(nativeTokenVault.address))).to.be.true;
  });
});

describe("Cross Chain Adapter: ZK Stack Native L2 Bridge", function () {
  const hubChainId = CHAIN_IDs.MAINNET;
  const l2ChainId = CHAIN_IDs.ZK_SYNC;
  const l1Weth = TOKEN_SYMBOLS_MAP.WETH.addresses[hubChainId];
  const l2Weth = TOKEN_SYMBOLS_MAP.WETH.addresses[l2ChainId];

  let adapter: MockZKStackNativeBridge;
  let monitoredEoa: string;
  let l2BaseToken: Contract;
  let searchConfig: utils.EventSearchConfig;

  beforeEach(async function () {
    searchConfig = { from: 0, to: 1_000_000 };
    const [deployer] = await ethers.getSigners();
    monitoredEoa = randomAddress();

    l2BaseToken = await (await getContractFactory("zkStack_L2BaseToken", deployer)).deploy();
    adapter = new MockZKStackNativeBridge(l2ChainId, hubChainId, deployer, deployer, toAddress(l1Weth));
    adapter.setTargetL2Bridge(l2BaseToken);
  });

  it("constructWithdrawToL1Txns unwraps before withdrawing", async function () {
    const amountToWithdraw = toBNWei("1");
    const txns = await adapter.constructWithdrawToL1Txns(
      toAddress(monitoredEoa),
      toAddress(l2Weth),
      toAddress(l1Weth),
      amountToWithdraw
    );
    expect(txns.length).to.equal(2);
    const [unwrap, withdraw] = txns;

    // The unwrap must land before the withdrawal, which spends its proceeds.
    expect(unwrap.contract.address).to.equal(getContractEntry(l2ChainId, "weth").address);
    expect(unwrap.method).to.equal("withdraw");
    expect(unwrap.args[0]).to.equal(amountToWithdraw);
    expect(unwrap.ensureConfirmation).to.be.true;
    expect(unwrap.nonMulticall).to.be.true;

    expect(withdraw.contract.address).to.equal(l2BaseToken.address);
    expect(withdraw.method).to.equal("withdraw");
    expect(withdraw.args[0]).to.equal(monitoredEoa);
    expect(withdraw.value).to.equal(amountToWithdraw);
    // Simulated before the unwrap lands, so the balance is not yet available.
    expect(withdraw.canFailInSimulation).to.be.true;
    expect(withdraw.nonMulticall).to.be.true;
  });

  it("getL2PendingWithdrawalAmount counts base token withdrawals by sender", async function () {
    const amountToWithdraw = toBNWei("1");
    await l2BaseToken.emitWithdrawal(monitoredEoa, monitoredEoa, amountToWithdraw);
    await l2BaseToken.emitWithdrawal(randomAddress(), monitoredEoa, toBNWei("5"));

    expect(
      await adapter.getL2PendingWithdrawalAmount(searchConfig, searchConfig, toAddress(monitoredEoa), toAddress(l2Weth))
    ).to.equal(amountToWithdraw);
  });
});

describe("Cross Chain Adapter: ZK Stack L2 bridge configuration", function () {
  // Mirrors the resolution order in AdapterManager, jussi's topology builder and its edge pricing. A token that
  // resolves to no bridge is skipped everywhere; one that resolves to a bridge which then constructs no
  // transaction is advertised to the rebalancer as a zero-cost edge that can never execute.
  const resolveL2Bridge = (chainId: number, symbol: string) => {
    const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[CHAIN_IDs.MAINNET];
    return CUSTOM_L2_BRIDGE[chainId]?.[l1Token] ?? CANONICAL_L2_BRIDGE[chainId];
  };

  // Every supported token is pinned so that adding one to SUPPORTED_TOKENS cannot silently inherit a route.
  const expectedBridges: { [chainId: number]: { [symbol: string]: unknown } } = {
    [CHAIN_IDs.LENS]: {
      WETH: ZKStackBridge,
      // Standalone bridge, unknown to the native token vault, and misfinalized if sent via the asset router.
      USDC: undefined,
      // Lens's wrapped base token; withdrawing it would deliver untracked L1 GHO.
      WGHO: undefined,
    },
    [CHAIN_IDs.ZK_SYNC]: {
      USDT: ZKStackBridge,
      WBTC: ZKStackBridge,
      DAI: ZKStackBridge,
      // The native token vault refuses to burn its own WETH_TOKEN, so WETH exits as unwrapped ETH.
      WETH: ZKStackNativeBridge,
      // Left on Binance so that hasBinanceRoute() is unchanged.
      USDC: BinanceCEXBridge,
    },
  };

  Object.entries(expectedBridges).forEach(([chainId, expected]) => {
    it(`resolves the intended L2 bridge for every supported token on chain ${chainId}`, function () {
      const supported = SUPPORTED_TOKENS[chainId];
      expect(supported.slice().sort()).to.deep.equal(Object.keys(expected).sort());
      supported.forEach((symbol) => expect(resolveL2Bridge(Number(chainId), symbol)).to.equal(expected[symbol]));
    });
  });
});

async function signers() {
  const [deployer] = await ethers.getSigners();
  return [deployer, deployer] as const;
}

class MockZKStackBridge extends ZKStackBridge {
  setTargetL1Bridge(l1Bridge: Contract) {
    this.l1Bridge = l1Bridge;
  }

  setTargetL2Bridge(l2Bridge: Contract) {
    this.l2Bridge = l2Bridge;
  }
}

class MockZKStackNativeBridge extends ZKStackNativeBridge {
  setTargetL2Bridge(l2Bridge: Contract) {
    this.l2Bridge = l2Bridge;
  }
}
