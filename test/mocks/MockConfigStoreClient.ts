import { clients } from "@across-protocol/sdk-v2";
import { CONFIG_STORE_VERSION, CHAIN_ID_LIST_INDICES } from "../../src/common";
import { EventSearchConfig, MakeOptional, winston } from "../../src/utils";
import { Contract } from "../utils";

export const DEFAULT_CONFIG_STORE_VERSION = clients.DEFAULT_CONFIG_STORE_VERSION;

// @dev This mocked class must re-implement any customisations in the local extended ConfigStoreClient.
export class MockConfigStoreClient extends clients.mocks.MockConfigStoreClient {
  constructor(
    logger: winston.Logger,
    configStore: Contract,
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    configStoreVersion = CONFIG_STORE_VERSION,
    enabledChainIds = CHAIN_ID_LIST_INDICES,
  ) {
    super(logger, configStore, eventSearchConfig, configStoreVersion, enabledChainIds);
  }
};
