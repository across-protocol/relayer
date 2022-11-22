import { BigNumber, ERC20, ethers, ZERO_ADDRESS } from "../utils";
import lodash from "lodash";

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
  // The tokens whose balances are depleted first should be placed at the front of the array.
  async requestBalanceAllocations(
    requests: { chainId: number; tokens: string[]; holder: string; amount: BigNumber }[]
  ): Promise<boolean> {

    // Validate that all input tokens are unique.
    const tokens = requests.map(({ tokens }) => tokens.map(token => token.toLowerCase())).flat();
    if (!lodash.uniq(tokens)) throw new Error("BalanceAllocator::requestBalanceAllocations input tokens not unique!");

    // Do all async work up-front to avoid atomicity problems with updating used.
    const requestsWithbalances = await Promise.all(
      requests.map(async (request) => {
        const balances = Object.fromEntries(await Promise.all(
          request.tokens.map(async (token): Promise<[string, BigNumber]> => [token, await this.getBalance(request.chainId, token, request.holder)])
        ));

        // Replace `tokens` property with one of the interchangeable tokens.
        const returnedRequest = {
          ...request,
          balances,
        };
        return returnedRequest;
      })
    );

    // Determine if the entire group will be successful.
    const success = requestsWithbalances.every(({ chainId, tokens, holder, amount, balances }) => {
      const availableBalance = tokens.reduce((acc, token) => acc.add(balances[token].sub(this.getUsed(chainId, token, holder))), BigNumber.from(0));
      return availableBalance.gte(amount);
    });

    // If the entire group is successful commit to using these tokens.
    if (success)
      requestsWithbalances.forEach(({ chainId, tokens, holder, balances, amount }) =>
        tokens.forEach(token => {
          const used = amount.gt(balances[token]) ? balances[token] : amount;
          this.addUsed(chainId, token, holder, used);
          amount = amount.sub(used);
        })
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
