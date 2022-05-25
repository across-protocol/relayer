import { BigNumber, winston, assign, ERC20 } from "../utils";
import { SpokePoolClient } from ".";

export class BalanceAllocator {
  public balances: {
    [chainId: number]: { [token: string]: { [holder: string]: BigNumber } };
  } = {};

  public used: {
    [chainId: number]: { [token: string]: { [holder: string]: BigNumber } };
  } = {};

  // TODO: ideally this should just take a set of providers. This should probably be refactored to reduce coupling to
  // SpokePoolClients.
  constructor(readonly spokePoolClients: { [chainId: number]: SpokePoolClient }) {}

  async requestMultipleTokens(requests: { chainId: number; token: string; holder: string; amount: BigNumber }[]) {
    // Do all async work up-front to avoid atomicity problems with updating used.
    const requestsWithbalances = await Promise.all(
      requests.map(async (request) => ({
        ...request,
        balance: await this.getBalance(request.chainId, request.token, request.holder),
      }))
    );

    // Determine if the entire group will be successful.
    const success = requestsWithbalances.every(({ chainId, token, holder, amount, balance }) => {
      const used = this.getUsed(chainId, token, holder);
      return balance.gte(used.add(amount));
    });

    // If the entire group is successful commit to using these tokens.
    if (success)
      requestsWithbalances.forEach(({ chainId, token, holder, amount }) =>
        this.addUsed(chainId, token, holder, amount)
      );

    // Return success.
    return success;
  }

  async requestTokens(chainId: number, token: string, holder: string, amount: BigNumber): Promise<Boolean> {
    return this.requestMultipleTokens([{ chainId, token, holder, amount }]);
  }

  async getBalance(chainId: number, token: string, holder: string) {
    if (!this.balances?.[chainId]?.[token]?.[holder]) {
      const balance = await ERC20.connect(token, this.spokePoolClients[chainId].spokePool.provider).balanceOf(holder);
      assign(this.balances, [chainId, token, holder], balance);
    }
    return this.balances[chainId][token][holder];
  }

  getUsed(chainId: number, token: string, holder: string) {
    if (!this.used?.[chainId]?.[token]?.[holder]) {
      assign(this.used, [chainId, token, holder], BigNumber.from(0));
    }
    return this.used[chainId][token][holder];
  }

  addUsed(chainId: number, token: string, holder: string, amount: BigNumber) {
    const used = this.getUsed(chainId, token, holder);
    this.used[chainId][token][holder] = used.add(amount);
  }

  clearUsed() {
    this.used = {};
  }

  clearBalances() {
    this.balances = {};
  }
}
