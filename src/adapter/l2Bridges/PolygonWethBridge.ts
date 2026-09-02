import { EventFilter } from "ethers";
import { getContractEntry } from "../../common";
import { Contract, EvmAddress, Signer } from "../../utils";
import { PolygonERC20Bridge } from "./PolygonERC20Bridge";

/**
 * Withdraws WETH from Polygon back to the hub chain.
 *
 * @dev Polygon maps its WETH child token to L1 *ether*, not to L1 WETH: RootChainManager.childToRootToken() returns
 * the 0xEeee..EEeE ether sentinel for it, and that mapping's predicate is the Ether predicate rather than the
 * ERC20 predicate every other bridged token uses. Two things follow, and both differ from PolygonERC20Bridge:
 *   - the claim is announced by ExitedEther(exitor, amount), which carries no rootToken topic, and
 *   - the predicate releases native ETH to the burner, not WETH.
 *
 * The burn side is identical to any other PoS token (`withdraw()` on the child token), so it is inherited.
 */
export class PolygonWethBridge extends PolygonERC20Bridge {
  constructor(l2chainId: number, hubChainId: number, l2Signer: Signer, l1Signer: Signer, l1Token: EvmAddress) {
    super(l2chainId, hubChainId, l2Signer, l1Signer, l1Token);

    // Rebind from the ERC20 predicate that the parent selected to the Ether predicate that actually settles WETH.
    const { address: l1Address, abi: l1Abi } = getContractEntry(hubChainId, "polygonWethBridge");
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);
  }

  protected override exitedEventFilter(fromAddress: EvmAddress): EventFilter {
    // No rootToken topic to filter on: this predicate only ever releases ether.
    return this.getL1Bridge().filters.ExitedEther(fromAddress.toNative());
  }
}
