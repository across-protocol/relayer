import { clients } from "@across-protocol/sdk";
import { Contract, winston, BigNumber, assert } from "../utils";
import { ConfigStoreClient, HubPoolClient } from "../../src/clients";
import { MockConfigStoreClient } from "./MockConfigStoreClient";
import { L1Token, ProposedRootBundle, TokenInfo } from "../../src/interfaces";
import { Address, EvmAddress } from "../../src/utils/SDKUtils";

// Adds functions to MockHubPoolClient to facilitate Dataworker unit testing.
export class MockHubPoolClient extends clients.mocks.MockHubPoolClient {
  public latestBundleEndBlocks: { [chainId: number]: number } = {};
  public enableAllL2Tokens: boolean | undefined;
  private tokenInfoMap: { [tokenBytes32Str: string]: TokenInfo } = {};
  validatedRootBundles: ProposedRootBundle[] = [];

  constructor(
    logger: winston.Logger,
    hubPool: Contract,
    configStoreClient: ConfigStoreClient | MockConfigStoreClient,
    deploymentBlock = 0,
    chainId = 1
  ) {
    super(logger, hubPool, configStoreClient, deploymentBlock, chainId);
  }

  setValidatedRootBundles(validatedRootBundles: ProposedRootBundle[]): void {
    this.validatedRootBundles = validatedRootBundles;
  }

  getValidatedRootBundles(): ProposedRootBundle[] {
    return this.validatedRootBundles.length > 0 ? this.validatedRootBundles : super.getValidatedRootBundles();
  }

  setLatestBundleEndBlockForChain(chainId: number, latestBundleEndBlock: number): void {
    this.latestBundleEndBlocks[chainId] = latestBundleEndBlock;
  }
  getLatestBundleEndBlockForChain(chainIdList: number[], latestMainnetBlock: number, chainId: number): number {
    return (
      this.latestBundleEndBlocks[chainId] ??
      super.getLatestBundleEndBlockForChain(chainIdList, latestMainnetBlock, chainId) ??
      0
    );
  }
  setLpTokenInfo(l1Token: string, lastLpFeeUpdate: number, liquidReserves: BigNumber): void {
    this.lpTokens[l1Token] = { lastLpFeeUpdate, liquidReserves };
  }

  mapTokenInfo(address: Address, symbol: string, decimals?: number): void {
    this.tokenInfoMap[address.toBytes32()] = {
      symbol: symbol,
      address: address,
      decimals: decimals ?? 18,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getTokenInfoForAddress(address: Address, _chainId: number): TokenInfo {
    // If output token is mapped manually to a symbol in the symbol map,
    // use that info.
    const key = address.toBytes32();
    if (this.tokenInfoMap[key]) {
      return this.tokenInfoMap[key];
    }
    return {
      symbol: address.toString(),
      address: address,
      decimals: 18,
    };
  }

  setEnableAllL2Tokens(enableAllL2Tokens: boolean): void {
    this.enableAllL2Tokens = enableAllL2Tokens;
  }

  l2TokenEnabledForL1Token(l1Token: EvmAddress, destinationChainId: number): boolean {
    if (this.enableAllL2Tokens === undefined) {
      return super.l2TokenEnabledForL1Token(l1Token, destinationChainId);
    }
    return this.enableAllL2Tokens;
  }

  l2TokenHasPoolRebalanceRoute(l2Token: Address, l2ChainId: number, hubPoolBlock: number): boolean {
    if (this.enableAllL2Tokens === undefined) {
      return super.l2TokenHasPoolRebalanceRoute(l2Token, l2ChainId, hubPoolBlock);
    }
    return this.enableAllL2Tokens;
  }
}

export class SimpleMockHubPoolClient extends HubPoolClient {
  private tokenInfoMap: { [tokenBytes32Str: string]: TokenInfo } = {};

  mapTokenInfo(address: Address, symbol: string, decimals?: number): void {
    const key = address.toBytes32();
    this.tokenInfoMap[key] = {
      symbol,
      address,
      decimals: decimals ?? 18,
    };
  }

  getTokenInfoForAddress(address: Address, chainId: number): TokenInfo {
    // If output token is mapped manually to a symbol in the symbol map,
    // use that info.
    const key = address.toBytes32();
    if (this.tokenInfoMap[key]) {
      return this.tokenInfoMap[key];
    }
    return super.getTokenInfoForAddress(address, chainId);
  }

  getTokenInfoForL1Token(l1Token: EvmAddress): L1Token | undefined {
    const key = l1Token.toBytes32();
    if (this.tokenInfoMap[key]) {
      const value = this.tokenInfoMap[key];
      assert(value.address.isEVM(), "getTokenInfoForL1Token: non-EVM address stored for an L1 token");
      return { ...value, address: value.address };
    }
    return super.getTokenInfoForL1Token(l1Token);
  }

  setCurrentTime(time: number): void {
    this.currentTime = time;
  }
}
