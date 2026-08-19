import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { PolygonERC20Bridge } from "../../src/adapter/l2Bridges/PolygonERC20Bridge";
import { PolygonWethBridge } from "../../src/adapter/l2Bridges/PolygonWethBridge";
import { CANONICAL_L2_BRIDGE, CUSTOM_L2_BRIDGE, getContractEntry } from "../../src/common";
import { ethers, randomAddress, expect } from "../utils";
import { EvmAddress, toBNWei } from "../../src/utils/SDKUtils";

describe("Cross Chain Adapter: Polygon PoS L2 Bridge", function () {
  let deployer: ethers.Signer;
  let signerAddress: string;
  let l1WbtcToken: string, l2WbtcToken: string;
  let l1WethToken: string, l2WethToken: string;
  let hubChainId: number, l2ChainId: number;

  const toAddress = (address: string): EvmAddress => EvmAddress.from(address);

  beforeEach(async function () {
    [deployer] = await ethers.getSigners();
    signerAddress = await deployer.getAddress();

    hubChainId = CHAIN_IDs.MAINNET;
    l2ChainId = CHAIN_IDs.POLYGON;
    // WBTC is mapped to a real L1 ERC20 root token, so it takes the standard ERC20-predicate exit.
    l1WbtcToken = TOKEN_SYMBOLS_MAP.WBTC.addresses[hubChainId];
    l2WbtcToken = TOKEN_SYMBOLS_MAP.WBTC.addresses[l2ChainId];
    l1WethToken = TOKEN_SYMBOLS_MAP.WETH.addresses[hubChainId];
    l2WethToken = TOKEN_SYMBOLS_MAP.WETH.addresses[l2ChainId];
  });

  describe("PolygonERC20Bridge", function () {
    let adapter: PolygonERC20Bridge;

    beforeEach(function () {
      adapter = new PolygonERC20Bridge(l2ChainId, hubChainId, deployer, deployer, toAddress(l1WbtcToken));
    });

    it("constructWithdrawToL1Txns burns the child token", async function () {
      const amountToWithdraw = toBNWei("1.5", 8);
      const result = (
        await adapter.constructWithdrawToL1Txns(
          toAddress(signerAddress),
          toAddress(l2WbtcToken),
          toAddress(l1WbtcToken),
          amountToWithdraw
        )
      )[0];

      expect(result.chainId).to.equal(l2ChainId);
      expect(result.method).to.equal("withdraw");
      // The burn is issued against the child token itself, not a separate bridge contract.
      expect(result.contract.address).to.equal(ethers.utils.getAddress(l2WbtcToken));
      expect(result.args[0]).to.equal(amountToWithdraw);
      // The PoS exit is claimed in a separate hub-chain transaction, so this must not be batched into a multicall.
      expect(result.nonMulticall).to.be.true;
    });

    it("constructWithdrawToL1Txns refuses a recipient other than the burner", async function () {
      // Polygon credits the exit to whoever burned the tokens, so a differing recipient cannot be honoured and must
      // fail loudly rather than silently sending the funds to the signer.
      await expect(
        adapter.constructWithdrawToL1Txns(
          toAddress(randomAddress()),
          toAddress(l2WbtcToken),
          toAddress(l1WbtcToken),
          toBNWei("1", 8)
        )
      ).to.be.rejectedWith("always exit to the burner");
    });

    it("matches exits on the ERC20 predicate, keyed by root token", function () {
      const erc20Predicate = getContractEntry(hubChainId, "polygonBridge").address;
      expect(adapter["getL1Bridge"]().address).to.equal(ethers.utils.getAddress(erc20Predicate));

      const filter = adapter["exitedEventFilter"](toAddress(signerAddress));
      // ExitedERC20(exitor, rootToken, amount): signature + both indexed operands.
      expect(filter.topics).to.have.length(3);
    });
  });

  describe("PolygonWethBridge", function () {
    let adapter: PolygonWethBridge;

    beforeEach(function () {
      adapter = new PolygonWethBridge(l2ChainId, hubChainId, deployer, deployer, toAddress(l1WethToken));
    });

    it("burns the child token exactly like any other PoS token", async function () {
      const amountToWithdraw = toBNWei("1.5");
      const result = (
        await adapter.constructWithdrawToL1Txns(
          toAddress(signerAddress),
          toAddress(l2WethToken),
          toAddress(l1WethToken),
          amountToWithdraw
        )
      )[0];

      expect(result.method).to.equal("withdraw");
      expect(result.contract.address).to.equal(ethers.utils.getAddress(l2WethToken));
      expect(result.args[0]).to.equal(amountToWithdraw);
    });

    it("matches exits on the Ether predicate, not the ERC20 predicate", function () {
      // Polygon maps its WETH child token to L1 ether, so the claim is released by a different predicate than every
      // other bridged ERC20. Querying the ERC20 predicate would never match and would strand the burn as pending.
      const etherPredicate = getContractEntry(hubChainId, "polygonWethBridge").address;
      const erc20Predicate = getContractEntry(hubChainId, "polygonBridge").address;
      expect(etherPredicate).to.not.equal(erc20Predicate);
      expect(adapter["getL1Bridge"]().address).to.equal(ethers.utils.getAddress(etherPredicate));

      // ExitedEther(exitor, amount) carries no rootToken topic: signature + exitor only.
      const filter = adapter["exitedEventFilter"](toAddress(signerAddress));
      expect(filter.topics).to.have.length(2);
    });
  });

  it("routes WETH to the Ether-predicate adapter and everything else to the ERC20 one", function () {
    // Mirrors AdapterManager precedence: CUSTOM_L2_BRIDGE first, then the chain-level CANONICAL_L2_BRIDGE.
    const resolve = (l1Token: string) => CUSTOM_L2_BRIDGE[l2ChainId]?.[l1Token] ?? CANONICAL_L2_BRIDGE[l2ChainId];
    expect(resolve(l1WethToken)).to.equal(PolygonWethBridge);
    expect(resolve(l1WbtcToken)).to.equal(PolygonERC20Bridge);
  });
});
