import { BundleDataApproxClient } from "../../src/clients";
import { Address, BigNumber, EvmAddress, toAddressType } from "../../src/utils";

type TokenMapping = { [l1Token: string]: { [chainId: number]: string | string[] } };
export class MockBundleDataApproxClient extends BundleDataApproxClient {
  tokenMappings: TokenMapping | undefined = undefined;

  setTokenMapping(tokenMapping: TokenMapping): void {
    this.tokenMappings = tokenMapping;
  }

  override getL1TokenAddress(l2Token: Address, chainId: number): EvmAddress {
    if (this.tokenMappings) {
      const tokenMapping = Object.entries(this.tokenMappings).find(([, mapping]) => {
        const mapped = mapping[chainId];
        if (Array.isArray(mapped)) {
          return mapped.includes(l2Token.toEvmAddress());
        }
        return mapped === l2Token.toEvmAddress();
      });
      if (tokenMapping) {
        return toAddressType(tokenMapping[0], chainId);
      }
    }
    return super.getL1TokenAddress(l2Token, chainId);
  }

  override getApproximateRefundsForToken(
    l1Token: EvmAddress,
    fromBlocks: { [chainId: number]: number }
  ): { [repaymentChainId: number]: { [relayer: string]: BigNumber } } {
    return super.getApproximateRefundsForToken(l1Token, fromBlocks);
  }

  // Return the next starting block for each chain following the bundle end block of the last executed bundle that
  // was relayed to that chain.
  override getUnexecutedBundleStartBlocks(l1Token: Address, requireExecution: boolean): { [chainId: number]: number } {
    return super.getUnexecutedBundleStartBlocks(l1Token, requireExecution);
  }
}
