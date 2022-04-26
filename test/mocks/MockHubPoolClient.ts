import { L1Token } from "../../src/interfaces";
import { HubPoolClient } from "../../src/clients";

export class MockHubPoolClient extends HubPoolClient {
  private l1TokensMock: L1Token[] = []; // L1Tokens and their associated info.
  private tokenInfoToReturn: L1Token;

  addL1Token(l1Token: L1Token) {
    this.l1TokensMock.push(l1Token);
  }

  getL1Tokens() {
    return this.l1TokensMock;
  }

  getTokenInfoForDeposit() {
    return this.tokenInfoToReturn;
  }

  setTokenInfoToReturn(tokenInfo: L1Token) {
    this.tokenInfoToReturn = tokenInfo;
  }
}
