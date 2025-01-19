import { BigNumber, ERC20, ethers, min, getNativeTokenAddressForChain } from "../utils";

// This type is used to map used and current balances of different users.
export interface BalanceMap {
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
  // The tokens whose balances are depleted first should be placed at the front of the array.
  async requestBalanceAllocations(
    requests: { chainId: number; tokens: string[]; holder: string; amount: BigNumber }[]
  ): Promise<boolean> {
    // Do all async work up-front to avoid atomicity problems with updating used.
    const requestsWithBalances = await Promise.all(
      requests.map(async (request) => {
        const balances = Object.fromEntries(
          await Promise.all(
            request.tokens.map(
              async (token): Promise<[string, BigNumber]> => [
                token,
                await this.getBalance(request.chainId, token, request.holder),
              ]
            )
          )
        );

        const returnedRequest = {
          ...request,
          balances,
        };
        return returnedRequest;
      })
    );

    // Construct a map of available balances for all requests, taking into account used and balances.
    const availableBalances: BalanceMap = {};
    for (const request of requestsWithBalances) {
      if (!availableBalances[request.chainId]) {
        availableBalances[request.chainId] = {};
      }
      for (const token of request.tokens) {
        if (!availableBalances[request.chainId][token]) {
          availableBalances[request.chainId][token] = {};
        }
        availableBalances[request.chainId][token][request.holder] = request.balances[token].sub(
          this.getUsed(request.chainId, token, request.holder)
        );
      }
    }

    // Determine if the entire group will be successful by subtracting the amount from the available balance as we go.
    for (const request of requestsWithBalances) {
      const remainingAmount = request.tokens.reduce((acc, token) => {
        const availableBalance = availableBalances[request.chainId][token][request.holder];
        const amountToDeduct = min(acc, availableBalance);
        if (amountToDeduct.gt(0)) {
          availableBalances[request.chainId][token][request.holder] = availableBalance.sub(amountToDeduct);
        }
        return acc.sub(amountToDeduct);
      }, request.amount);
      // If there is a remaining amount, the entire group will fail, so return false.
      if (remainingAmount.gt(0)) {
        return false;
      }
    }

    // If the entire group is successful commit to using these tokens.
    requestsWithBalances.forEach(({ chainId, tokens, holder, balances, amount }) =>
      tokens.forEach((token) => {
        const used = min(amount, balances[token].sub(this.getUsed(chainId, token, holder)));
        this.addUsed(chainId, token, holder, used);
        amount = amount.sub(used);
      })
    );

    // Return success.
    return true;
  }

  async requestBalanceAllocation(
    chainId: number,
    tokens: string[],
    holder: string,
    amount: BigNumber
  ): Promise<boolean> {
    return this.requestBalanceAllocations([{ chainId, tokens, holder, amount }]);
  }

  async getBalanceSubUsed(chainId: number, token: string, holder: string): Promise<BigNumber> {
    const balance = await this.getBalance(chainId, token, holder);
    const used = this.getUsed(chainId, token, holder);
    return balance.sub(used);
  }

  async getBalance(chainId: number, token: string, holder: string): Promise<BigNumber> {
    if (!this.balances?.[chainId]?.[token]?.[holder]) {
      const balance = await this._queryBalance(chainId, token, holder);
      // To avoid inconsistencies, we recheck the balances value after the query.
      // If it exists, skip the assignment so the value doesn't change after being set.
      if (!this.balances?.[chainId]?.[token]?.[holder]) {
        // Note: cannot use assign because it breaks the BigNumber object.
        this.balances[chainId] ??= {};
        if (!this.balances[chainId][token]) {
          this.balances[chainId][token] = {};
        }
        this.balances[chainId][token][holder] = balance;
      }
    }
    return this.balances[chainId][token][holder];
  }

  testSetBalance(chainId: number, token: string, holder: string, balance: BigNumber): void {
    this.balances[chainId] ??= {};
    this.balances[chainId][token] ??= {};
    this.balances[chainId][token][holder] = balance;
  }

  getUsed(chainId: number, token: string, holder: string): BigNumber {
    if (!this.used?.[chainId]?.[token]?.[holder]) {
      // Note: cannot use assign because it breaks the BigNumber object.
      if (!this.used[chainId]) {
        this.used[chainId] = {};
      }
      if (!this.used[chainId][token]) {
        this.used[chainId][token] = {};
      }
      this.used[chainId][token][holder] = BigNumber.from(0);
    }
    return this.used[chainId][token][holder];
  }

  addUsed(chainId: number, token: string, holder: string, amount: BigNumber): void {
    const used = this.getUsed(chainId, token, holder);
    this.used[chainId][token][holder] = used.add(amount);
  }

  clearUsed(): void {
    this.used = {};
  }

  clearBalances(): void {
    this.balances = {};
  }

  // This method is primarily here to be overridden for testing purposes.
  protected async _queryBalance(chainId: number, token: string, holder: string): Promise<BigNumber> {
    return getNativeTokenAddressForChain(chainId).toLowerCase() === token.toLowerCase()
      ? await this.providers[chainId].getBalance(holder)
      : await ERC20.connect(token, this.providers[chainId]).balanceOf(holder);
  }
}
