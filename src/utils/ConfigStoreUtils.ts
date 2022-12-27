import { AcrossConfigStoreClient } from "../clients";
import { CONFIG_STORE_VERSION } from "../common";

export function checkConfigStoreVersion(client: AcrossConfigStoreClient): void {
  if (client.configStoreVersion !== CONFIG_STORE_VERSION)
    throw new Error(
      `Config store version mismatch: { on-chain: ${client.configStoreVersion}, local: ${CONFIG_STORE_VERSION} }`
    );
}
