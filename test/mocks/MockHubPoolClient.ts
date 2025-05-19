import { clients } from "@across-protocol/sdk";
import { Contract, winston, BigNumber } from "../utils";
import { ConfigStoreClient } from "../../src/clients";
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

  mapTokenInfo(token: string, symbol: string, decimals?: number): void {
    this.tokenInfoMap[token] = {
      symbol,
      address: token,
      decimals: decimals ?? 18,
    };
  }

  getTokenInfoForAddress(token: string): L1Token {
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

  l2TokenHasPoolRebalanceRoute(l2Token: string, l2ChainId: number, hubPoolBlock: number): boolean {
    if (this.enableAllL2Tokens === undefined) {
      return super.l2TokenHasPoolRebalanceRoute(l2Token, l2ChainId, hubPoolBlock);
    }
    return this.enableAllL2Tokens;
  }
}

export class SimpleMockHubPoolClient extends clients.HubPoolClient {
  private tokenInfoMap: { [tokenAddress: string]: L1Token } = {};

  mapTokenInfo(token: string, symbol: string, decimals = 18): void {
    this.tokenInfoMap[token] = {
      symbol,
      address: token,
      decimals,
    };
  }

  getTokenInfoForAddress(token: string, chainId: number): L1Token {
    // If output token is mapped manually to a symbol in the symbol map,
    // use that info.
    if (this.tokenInfoMap[token]) {
      return this.tokenInfoMap[token];
    }
    return super.getTokenInfoForAddress(token, chainId);
  }

  getTokenInfoForL1Token(l1Token: string): L1Token | undefined {
    if (this.tokenInfoMap[l1Token]) {
      return this.tokenInfoMap[l1Token];
    }
    return super.getTokenInfoForL1Token(l1Token);
  }
}
