import { clients } from "@across-protocol/sdk";
import { EventSearchConfig, MakeOptional, winston } from "../../src/utils";
import { Contract } from "../utils";
import { CHAIN_ID_TEST_LIST } from "../constants";

export const DEFAULT_CONFIG_STORE_VERSION = clients.DEFAULT_CONFIG_STORE_VERSION;

// @dev This mocked class must re-implement any customisations in the local extended ConfigStoreClient.
export class MockConfigStoreClient extends clients.mocks.MockConfigStoreClient {
  constructor(
    logger: winston.Logger,
    configStore: Contract,
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    configStoreVersion = DEFAULT_CONFIG_STORE_VERSION,
    enabledChainIds = CHAIN_ID_TEST_LIST,
    chainId = 1,
    mockUpdate = false
  ) {
    super(
      logger,
      configStore,
      eventSearchConfig as EventSearchConfig,
      configStoreVersion,
      chainId,
      mockUpdate,
      enabledChainIds
    );
  }

  _updateLiteChains(chainIds: number[], blockNumber = 0, blockTimestamp = 0) {
    this.liteChainIndicesUpdates = [
      {
        ...this.liteChainIndicesUpdates,
        value: [...(this.liteChainIndicesUpdates.value ?? []), ...chainIds],
        blockNumber,
        timestamp: blockTimestamp,
        transactionIndex: Math.floor(Math.random() * 10),
        logIndex: Math.floor(Math.random() * 10),
        transactionHash: "",
      },
    ];
  }
}
