import { Contract, Signer, Provider } from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { ArbitrumOneBridge } from "./ArbitrumOneBridge";
import { PRODUCTION_NETWORKS, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";

export class AlephZeroBridge extends ArbitrumOneBridge {
  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: string
  ) {
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId][`orbitErc20L1Gateway_${l2chainId}`];
    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].erc20Gateway;

    // The constructor defines the l1GatewayRouter contract. We need to overwrite the bridge/gateway addresses.
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, l1Token);

    const nativeToken = PRODUCTION_NETWORKS[l2chainId].nativeToken;
    this.gasToken = TOKEN_SYMBOLS_MAP[nativeToken].addresses[hubChainId];
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
    this.l1Gateways = [l1Address]; // There is only one gateway for all tokens for Aleph Zero.
  }
}
