import { clients } from "@across-protocol/sdk-v2";

// Adds mocked functions to HubPoolClient to facilitate Dataworker unit testing.
export class MockHubPoolClient extends clients.mocks.MockHubPoolClient {
  public latestBundleEndBlocks: { [chainId: number]: number } = {};

  public chainId: number;

  // For convenience, allow caller to base this Mock after already constructed HubPoolClient.
  constructor(
    hubPoolClient: clients.HubPoolClient
    ) {
    super(hubPoolClient.logger, hubPoolClient.hubPool, hubPoolClient.configStoreClient, hubPoolClient.deploymentBlock);
    this.chainId = hubPoolClient.chainId;
    }

    setLatestBundleEndBlockForChain(chainId: number, latestBundleEndBlock: number): void {
        this.latestBundleEndBlocks[chainId] = latestBundleEndBlock;
    }
    getLatestBundleEndBlockForChain(_chainIdList: number[], _latestMainnetBlock: number, chainId: number): number {
        return this.latestBundleEndBlocks[chainId] ?? 0;
    }
}
