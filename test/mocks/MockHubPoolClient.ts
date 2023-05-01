import { random } from "lodash";
import { Deposit, L1Token, PendingRootBundle } from "../../src/interfaces";
import { HubPoolClient, HubPoolUpdate } from "../../src/clients";
import { Event } from "../../src/utils";

export class MockHubPoolClient extends HubPoolClient {
  public readonly minBlockRange = 10;
  public rootBundleProposal: PendingRootBundle;

  private events: Event[] = [];
  private logIndexes: Record<string, number> = {};
  private l1TokensMock: L1Token[] = []; // L1Tokens and their associated info.
  private tokenInfoToReturn: L1Token;
  private l1TokensToDestinationTokensMock: { [l1Token: string]: { [destinationChainId: number]: string } } = {};
  private returnedL1TokenForDeposit: string;

  addEvent(event: Event): void {
    this.events.push(event);
  }

  addL1Token(l1Token: L1Token) {
    this.l1TokensMock.push(l1Token);
  }

  getL1Tokens() {
    return this.l1TokensMock;
  }

  getTokenInfoForDeposit() {
    return this.tokenInfoToReturn;
  }

  getTokenInfoForL1Token(l1Token: string): L1Token | undefined {
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
    return this.l1TokensToDestinationTokensMock[l1Token][destinationChainId];
  }

  setReturnedL1TokenForDeposit(l1Token: string) {
    this.returnedL1TokenForDeposit = l1Token;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getL1TokenForDeposit(_deposit: Deposit) {
    return this.returnedL1TokenForDeposit;
  }

  async _update(eventNames: string[]): Promise<HubPoolUpdate> {
    // Generate new "on chain" responses.
    const latestBlockNumber = (this.latestBlockNumber ?? 0) + random(this.minBlockRange, this.minBlockRange * 5, false);
    const currentTime = Math.floor(Date.now() / 1000);

    // Ensure an array for every requested event exists, in the requested order.
    // All requested event types must be populated in the array (even if empty).
    const _events: Event[][] = eventNames.map(() => []);
    this.events.flat().forEach((event) => {
      const idx = eventNames.indexOf(event.event as string);
      if (idx !== -1) {
        _events[idx].push(event);
      }
    });
    this.events = [];

    // Transform 2d-events array into a record.
    const events = Object.fromEntries(eventNames.map((eventName, idx) => [eventName, _events[idx]]));

    return {
      success: true,
      currentTime,
      latestBlockNumber,
      pendingRootBundleProposal: this.rootBundleProposal,
      events,
      searchEndBlock: this.eventSearchConfig.toBlock || latestBlockNumber,
    };
  }
}
