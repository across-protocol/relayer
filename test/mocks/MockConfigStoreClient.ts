import { AcrossConfigStoreClient } from "../../src/clients";

export class MockConfigStoreClient extends AcrossConfigStoreClient {
  public isValidConfigStoreVersion(_version: number): boolean {
    return true
  }
}
