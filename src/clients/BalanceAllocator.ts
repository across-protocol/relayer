import { BigNumber, ERC20, ethers, ZERO_ADDRESS, min } from "../utils";

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

  /**
   * @notice Caller is assumiing that all `tokens` are interchangeable and that if their balances are not collapsed
   * into one, then the accounting could be messed up and future calls to getBalance or getUsed could be incorrect.
   * @dev: The caller is suggesting that `tokens` for a request are interchangeable.
   * This assumes therefore that the balance of all `tokens` are ultimately treated as one, so for accounting
   * purposes we'll credit balances and debut usage to the first token address in the list.
   * The tokens whose balances are depleted first should be placed at the front of the array.
   */
  async requestBalanceAllocations(
    requests: { chainId: number; tokens: string[]; holder: string; amount: BigNumber }[]
  ): Promise<boolean> {
    // Do all async work up-front to avoid atomicity problems with updating used.
    const requestsWithBalances = await Promise.all(
      requests.map(async (request) => {
        // Add up balances of all `tokens` and store in address of first token in list.
        const balance = (
          await Promise.all(
            request.tokens.map(
              async (token): Promise<BigNumber> => this.getBalance(request.chainId, token, request.holder)
            )
          )
        ).reduce((acc, balance) => acc.add(balance), BigNumber.from(0));

        // Zero out all token balances besides the first.
        this.balances[request.chainId][request.tokens[0]][request.holder] = balance;
        request.tokens.forEach((token, index) => {
          if (index === 0) {
            return;
          }
          this.balances[request.chainId][token][request.holder] = BigNumber.from(0);
        });

        const returnedRequest = {
          ...request,
          tokenKey: request.tokens[0],
          balance,
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
      if (!availableBalances[request.chainId][request.tokenKey]) {
        availableBalances[request.chainId][request.tokenKey] = {};
      }
      availableBalances[request.chainId][request.tokenKey][request.holder] = request.balance.sub(
        this.getUsed(request.chainId, request.tokenKey, request.holder)
      );
    }
    // Determine if the entire group will be successful by subtracting the amount from the available balance as we go.
    for (const request of requestsWithBalances) {
      const availableBalance = availableBalances[request.chainId][request.tokenKey][request.holder];
      if (availableBalance.lt(request.amount)) {
        return false;
      } else {
        availableBalances[request.chainId][request.tokenKey][request.holder] = availableBalance.sub(request.amount);
      }
    }

    // If the entire group is successful commit to using these tokens.
    requestsWithBalances.forEach(({ chainId, tokenKey, holder, balance, amount }) => {
      const used = min(amount, balance.sub(this.getUsed(chainId, tokenKey, holder)));
      this.addUsed(chainId, tokenKey, holder, used);
    });

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

  async getBalance(chainId: number, token: string, holder: string): Promise<BigNumber> {
    if (!this.balances?.[chainId]?.[token]?.[holder]) {
      const balance = await this._queryBalance(chainId, token, holder);
      // To avoid inconsitencies, we recheck the balances value after the query.
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

  // This method is primarily here to be overriden for testing purposes.
  protected async _queryBalance(chainId: number, token: string, holder: string): Promise<BigNumber> {
    return token === ZERO_ADDRESS
      ? await this.providers[chainId].getBalance(holder)
      : await ERC20.connect(token, this.providers[chainId]).balanceOf(holder);
  }
}
