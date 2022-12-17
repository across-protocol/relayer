import { L1Token } from "../../src/interfaces";
import { HubPoolClient } from "../../src/clients";
import { ZERO_ADDRESS } from "../../src/utils";

export class MockHubPoolClient extends HubPoolClient {
  private l1TokensMock: L1Token[] = []; // L1Tokens and their associated info.
  private tokenInfoToReturn: L1Token;
  private l1TokensToDestinationTokensMock: { [l1Token: string]: { [destinationChainId: number]: string } } = {};
  private returnedL1TokenForDeposit: string = ZERO_ADDRESS;

  addL1Token(l1Token: L1Token) {
    this.l1TokensMock.push(l1Token);
  }

  getL1Tokens() {
    return this.l1TokensMock;
  }

  getTokenInfoForDeposit() {
    return this.tokenInfoToReturn;
  }

  getTokenInfoForL1Token(l1Token: string): L1Token {
    return this.l1TokensMock.find((token) => token.address === l1Token);
  }

  setTokenInfoToReturn(tokenInfo: L1Token) {
    this.tokenInfoToReturn = tokenInfo;
  }

  setL1TokensToDestinationTokens(l1TokensToDestinationTokens: {
    [l1Token: string]: { [destinationChainId: number]: string };
  }) {
    this.l1TokensToDestinationTokensMock = l1TokensToDestinationTokens;
  }

  getDestinationTokenForL1Token(l1Token: string, destinationChainId: number) {
    if (!this.l1TokensToDestinationTokensMock[l1Token]) return ZERO_ADDRESS;
    return this.l1TokensToDestinationTokensMock[l1Token][destinationChainId] ?? ZERO_ADDRESS;
  }

  setReturnedL1TokenForDeposit(l1Token: string) {
    this.returnedL1TokenForDeposit = l1Token;
  }

  getL1TokenForDeposit(_deposit: { originChainId: number; originToken: string }): string {
    return this.returnedL1TokenForDeposit;
  }
}
