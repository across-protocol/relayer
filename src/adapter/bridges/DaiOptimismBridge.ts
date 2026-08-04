import { Contract, Signer, Provider, EvmAddress, winston } from "../../utils";
import { getContractEntry } from "../../common";
import { OpStackDefaultERC20Bridge } from "./OpStackDefaultErc20Bridge";

export class DaiOptimismBridge extends OpStackDefaultERC20Bridge {
  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress,
    logger: winston.Logger
  ) {
    const { address: l1Address, abi: l1Abi } = getContractEntry(hubChainId, "daiOptimismBridge");
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, l1Token, logger);

    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = getContractEntry(l2chainId, "daiOptimismBridge");
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);

    // Since we define this bridge as an extension of the OpStackDefaultERC20Bridge,
    // we will need to overwrite the l1Gateways parameter, since when calling the super()
    // constructor, l1Gateways will be incorrectly set to the OVM standard bridge address,
    // not the DaiOptimismBridgeAddress.
    this.l1Gateways = [EvmAddress.from(l1Address)];
  }
}
