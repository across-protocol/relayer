import { BigNumber, ERC20, ethers, ZERO_ADDRESS } from "../utils";

// This type is used to map used and current balances of different users.
interface BalanceMap {
  [chainId: number]: {
    [token: string]: {
      [holder: string]: BigNumber;
    };
  };
}

export class BalanceAllocator {
  public balances: BalanceMap = {};

  public used: BalanceMap = {};

  constructor(readonly providers: { [chainId: number]: ethers.providers.Provider }) {}

  // Note: The caller is suggesting that `tokens` for a request are interchangeable.
  async requestBalanceAllocations(
    requests: { chainId: number; tokens: string[]; holder: string; amount: BigNumber }[]
  ): Promise<boolean> {
    // Do all async work up-front to avoid atomicity problems with updating used.
    const requestsWithbalances = await Promise.all(
      requests.map(async (request) => {
        const balances = await Promise.all(
          request.tokens.map((token) => this.getBalance(request.chainId, token, request.holder))
        );

        // Replace `tokens` property with one of the interchangeable tokens.
        const returnedRequest = {
          ...request,
          token: request.tokens[0],
          balance: balances.reduce((acc, curr) => acc.add(curr), BigNumber.from(0)),
        };
        delete returnedRequest.tokens;
        return returnedRequest;
      })
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

  async requestBalanceAllocation(
    chainId: number,
    tokens: string[],
    holder: string,
    amount: BigNumber
  ): Promise<boolean> {
    return this.requestBalanceAllocations([{ chainId, tokens, holder, amount }]);
  }

  async getBalance(chainId: number, token: string, holder: string) {
    if (!this.balances?.[chainId]?.[token]?.[holder]) {
      const balance =
        token === ZERO_ADDRESS
          ? await this.providers[chainId].getBalance(holder)
          : await ERC20.connect(token, this.providers[chainId]).balanceOf(holder);

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
