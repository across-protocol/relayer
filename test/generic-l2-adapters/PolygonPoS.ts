import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { PolygonERC20Bridge } from "../../src/adapter/l2Bridges/PolygonERC20Bridge";
import { ethers, randomAddress, expect } from "../utils";
import { EvmAddress, toBNWei } from "../../src/utils/SDKUtils";

describe("Cross Chain Adapter: Polygon PoS L2 Bridge", function () {
  let adapter: PolygonERC20Bridge;
  let signerAddress: string;
  let l1WethToken: string, l2WethToken: string;
  let hubChainId: number, l2ChainId: number;

  const toAddress = (address: string): EvmAddress => EvmAddress.from(address);

  beforeEach(async function () {
    const [deployer] = await ethers.getSigners();
    signerAddress = await deployer.getAddress();

    hubChainId = CHAIN_IDs.MAINNET;
    l2ChainId = CHAIN_IDs.POLYGON;
    l1WethToken = TOKEN_SYMBOLS_MAP.WETH.addresses[hubChainId];
    l2WethToken = TOKEN_SYMBOLS_MAP.WETH.addresses[l2ChainId];

    adapter = new PolygonERC20Bridge(l2ChainId, hubChainId, deployer, deployer, toAddress(l1WethToken));
  });

  it("constructWithdrawToL1Txns burns the child token", async function () {
    const amountToWithdraw = toBNWei("1.5");
    const result = (
      await adapter.constructWithdrawToL1Txns(
        toAddress(signerAddress),
        toAddress(l2WethToken),
        toAddress(l1WethToken),
        amountToWithdraw
      )
    )[0];

    expect(result.chainId).to.equal(l2ChainId);
    expect(result.method).to.equal("withdraw");
    // The burn is issued against the child token itself, not a separate bridge contract.
    expect(result.contract.address).to.equal(ethers.utils.getAddress(l2WethToken));
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
        toAddress(l2WethToken),
        toAddress(l1WethToken),
        toBNWei("1")
      )
    ).to.be.rejectedWith("always exit to the burner");
  });
});
