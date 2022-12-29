import { AcrossConfigStoreClient } from "../../src/clients";
import { DEFAULT_CONFIG_STORE_VERSION } from "../../src/common";

export class MockConfigStoreClient extends AcrossConfigStoreClient {
  public configStoreVersion = DEFAULT_CONFIG_STORE_VERSION;

  setConfigStoreVersion(version: number): void {
    this.configStoreVersion = version;
  }

  override isValidConfigStoreVersion(_version: number): boolean {
    return this.configStoreVersion >= _version;
  }
}
