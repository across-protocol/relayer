import { BundleDataApproxClient } from "../../src/clients";
import { Address, EvmAddress, toAddressType } from "../../src/utils";

type TokenMapping = { [l1Token: string]: { [chainId: number]: string } };
export class MockBundleDataApproxClient extends BundleDataApproxClient {
  tokenMappings: TokenMapping | undefined = undefined;

  setTokenMapping(tokenMapping: TokenMapping): void {
    this.tokenMappings = tokenMapping;
  }

  override getL1TokenAddress(l2Token: Address, chainId: number): EvmAddress {
    if (this.tokenMappings) {
      const tokenMapping = Object.entries(this.tokenMappings).find(
        ([, mapping]) => mapping[chainId] === l2Token.toEvmAddress()
      );
      if (tokenMapping) {
        return toAddressType(tokenMapping[0], chainId);
      }
    }
    return super.getL1TokenAddress(l2Token, chainId);
  }
}
