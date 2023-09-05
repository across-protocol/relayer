import { clients } from "@across-protocol/sdk-v2";
import { Contract, winston } from "../utils";
import { ConfigStoreClient } from "../../src/clients";

// Adds functions to MockHubPoolClient to facilitate Dataworker unit testing.
export class MockHubPoolClient extends clients.mocks.MockHubPoolClient {
  public latestBundleEndBlocks: { [chainId: number]: number } = {};

  constructor(
    logger: winston.Logger,
    hubPool: Contract,
    configStoreClient: ConfigStoreClient,
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
}
