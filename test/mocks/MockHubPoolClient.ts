import { clients } from "@across-protocol/sdk-v2";
import { Contract, winston, BigNumber } from "../utils";
import { ConfigStoreClient } from "../../src/clients";
import { MockConfigStoreClient } from "./MockConfigStoreClient";

// Adds functions to MockHubPoolClient to facilitate Dataworker unit testing.
export class MockHubPoolClient extends clients.mocks.MockHubPoolClient {
  public latestBundleEndBlocks: { [chainId: number]: number } = {};

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
}
