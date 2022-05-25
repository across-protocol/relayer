import { BigNumber, assign, ERC20, ethers } from "../utils";

export class BalanceAllocator {
  public balances: {
    [chainId: number]: { [token: string]: { [holder: string]: BigNumber } };
  } = {};

  public used: {
    [chainId: number]: { [token: string]: { [holder: string]: BigNumber } };
  } = {};

  constructor(readonly providers: { [chainId: number]: ethers.providers.Provider }) {}

  async requestMultipleTokens(
    requests: { chainId: number; token: string; holder: string; amount: BigNumber }[]
  ): Promise<boolean> {
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
      console.log(balance.toString(), used.toString(), amount.toString());
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

  async requestTokens(chainId: number, token: string, holder: string, amount: BigNumber): Promise<boolean> {
    return this.requestMultipleTokens([{ chainId, token, holder, amount }]);
  }

  async getBalance(chainId: number, token: string, holder: string) {
    if (!this.balances?.[chainId]?.[token]?.[holder]) {
      const balance = await ERC20.connect(token, this.providers[chainId]).balanceOf(holder);

      // Note: cannot use assign because it breaks the BigNumber object.
      if (!this.balances[chainId]) this.balances[chainId] = {};
      if (!this.balances[chainId][token]) this.balances[chainId][token] = {};
      this.balances[chainId][token][holder] = balance;
    }
    return this.balances[chainId][token][holder];
  }

  getUsed(chainId: number, token: string, holder: string) {
    if (!this.used?.[chainId]?.[token]?.[holder]) {

      // Note: cannot use assign because it breaks the BigNumber object.
      if (!this.used[chainId]) this.used[chainId] = {};
      if (!this.used[chainId][token]) this.used[chainId][token] = {};
      this.used[chainId][token][holder] = BigNumber.from(0);
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
