import { clients } from "@across-protocol/sdk-v2";
import { Contract, winston, BigNumber } from "../utils";
import { ConfigStoreClient, HubPoolClient } from "../../src/clients";
import { MockConfigStoreClient } from "./MockConfigStoreClient";
import { L1Token } from "../../src/interfaces";

// Adds functions to MockHubPoolClient to facilitate Dataworker unit testing.
export class MockHubPoolClient extends clients.mocks.MockHubPoolClient {
  public latestBundleEndBlocks: { [chainId: number]: number } = {};
  public enableAllL2Tokens: boolean | undefined;
  private tokenInfoMap: { [tokenAddress: string]: L1Token } = {};

  constructor(
    logger: winston.Logger,
    hubPool: Contract,
    configStoreClient: ConfigStoreClient | MockConfigStoreClient,
    deploymentBlock = 0,
    chainId = 1
  ) {
    super(logger, hubPool, configStoreClient, deploymentBlock, chainId);
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

  mapTokenInfo(token: string, symbol: string, l1Token?: string, decimals?: number): void {
    this.tokenInfoMap[token] = {
      symbol,
      address: l1Token ?? token,
      decimals: decimals ?? 18,
    };
  }

  getL1TokenInfoForAddress(token: string): L1Token {
    // If output token is mapped manually to a symbol in the symbol map,
    // use that info.
    if (this.tokenInfoMap[token]) {
      return this.tokenInfoMap[token];
    }
    return {
      symbol: token,
      address: token,
      decimals: 18,
    };
  }

  setEnableAllL2Tokens(enableAllL2Tokens: boolean): void {
    this.enableAllL2Tokens = enableAllL2Tokens;
  }

  l2TokenEnabledForL1Token(l1Token: string, destinationChainId: number): boolean {
    if (this.enableAllL2Tokens === undefined) {
      return super.l2TokenEnabledForL1Token(l1Token, destinationChainId);
    }
    return this.enableAllL2Tokens;
  }
}

export class SimpleMockHubPoolClient extends HubPoolClient {
  private tokenInfoMap: { [tokenAddress: string]: L1Token } = {};

  mapTokenInfo(token: string, symbol: string, l1Token?: string): void {
    this.tokenInfoMap[token] = {
      symbol,
      address: l1Token ?? token,
      decimals: 18,
    };
  }

  getL1TokenInfoForAddress(token: string, chainId: number): L1Token {
    // If output token is mapped manually to a symbol in the symbol map,
    // use that info.
    if (this.tokenInfoMap[token]) {
      return this.tokenInfoMap[token];
    }
    return super.getL1TokenInfoForAddress(token, chainId);
  }
}
