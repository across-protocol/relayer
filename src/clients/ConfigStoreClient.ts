import { clients } from "@across-protocol/sdk-v2";
import { Contract } from "ethers";
import { EventSearchConfig, MakeOptional, winston } from "../utils";
import { CHAIN_ID_LIST_INDICES, CONFIG_STORE_VERSION, DEFAULT_CONFIG_STORE_VERSION } from "../common";
import { HubPoolClient } from "./HubPoolClient";

export const GLOBAL_CONFIG_STORE_KEYS = clients.GLOBAL_CONFIG_STORE_KEYS;

export class AcrossConfigStoreClient extends clients.AcrossConfigStoreClient {
  constructor(
    logger: winston.Logger,
    configStore: Contract,
    hubPoolClient: HubPoolClient,
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    enabledChainIds: number[] = CHAIN_ID_LIST_INDICES
  ) {
    super(logger, configStore, hubPoolClient, eventSearchConfig, {
      enabledChainIds,
      defaultConfigStoreVersion: DEFAULT_CONFIG_STORE_VERSION,
      configStoreVersion: CONFIG_STORE_VERSION,
    });
  }
}
