import { clients, utils } from "@across-protocol/sdk-v2";
export const { UBA_MIN_CONFIG_STORE_VERSION } = utils;
export const GLOBAL_CONFIG_STORE_KEYS = clients.GLOBAL_CONFIG_STORE_KEYS;

export class ConfigStoreClient extends clients.AcrossConfigStoreClient {}
