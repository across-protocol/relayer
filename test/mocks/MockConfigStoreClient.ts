import { AcrossConfigStoreClient } from "../../src/clients";

export class MockConfigStoreClient extends AcrossConfigStoreClient {
  public validateConfigStoreVersion() {
    // do nothing.
  }
}
