import { AcrossConfigStoreClient } from "../clients";
import { CONFIG_STORE_VERSION } from "../common";
require("dotenv").config();

export function checkConfigStoreVersion(client: AcrossConfigStoreClient): void {
  const localVersion = process.env.CONFIG_STORE_VERSION ?? CONFIG_STORE_VERSION;
  if (client.configStoreVersion !== localVersion)
    throw new Error(
      `Config store version mismatch: { on-chain: ${client.configStoreVersion}, local: ${localVersion} }`
    );
}
