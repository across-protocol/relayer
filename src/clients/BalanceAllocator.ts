import {
  BigNumber,
  bnZero,
  ERC20,
  ethers,
  min,
  getNativeTokenAddressForChain,
  Address,
  assert,
  chainIsEvm,
  getSvmProvider,
  getSolanaTokenBalance,
  getRedisCache,
} from "../utils";

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
    requests: { chainId: number; tokens: Address[]; holder: Address; amount: BigNumber }[]
  ): Promise<boolean> {
    // Do all async work up-front to avoid atomicity problems with updating used.
    const requestsWithBalances = await Promise.all(
      requests.map(async (request) => {
        const balances = Object.fromEntries(
          await Promise.all(
            request.tokens.map(
              async (token): Promise<[string, BigNumber]> => [
                token.toBytes32(),
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
    for (const { balances, chainId, holder, tokens } of requestsWithBalances) {
      availableBalances[chainId] ??= {};

      for (const token of tokens) {
        const tokenAddr = token.toBytes32();
        const holderAddr = holder.toBytes32();
        const used = this.getUsed(chainId, token, holder);

        availableBalances[chainId][tokenAddr] ??= {};
        availableBalances[chainId][tokenAddr][holderAddr] = balances[tokenAddr].sub(used);
      }
    }

    // Determine if the entire group will be successful by subtracting the amount from the available balance as we go.
    for (const { amount, chainId, holder, tokens } of requestsWithBalances) {
      const remainingAmount = tokens.reduce((acc, token) => {
        const tokenAddr = token.toBytes32();
        const holderAddr = holder.toBytes32();

        const availableBalance = availableBalances[chainId][tokenAddr][holderAddr];
        const amountToDeduct = min(acc, availableBalance);
        if (amountToDeduct.gt(bnZero)) {
          availableBalances[chainId][tokenAddr][holderAddr] = availableBalance.sub(amountToDeduct);
        }
        return acc.sub(amountToDeduct);
      }, amount);

      // If there is a remaining amount, the entire group will fail, so return false.
      if (remainingAmount.gt(bnZero)) {
        return false;
      }
    }

    // If the entire group is successful commit to using these tokens.
    requestsWithBalances.forEach(({ chainId, tokens, holder, balances, amount }) =>
      tokens.forEach((token) => {
        const used = min(amount, balances[token.toBytes32()].sub(this.getUsed(chainId, token, holder)));
        this.addUsed(chainId, token, holder, used);
        amount = amount.sub(used);
      })
    );

    // Return success.
    return true;
  }

  async requestBalanceAllocation(
    chainId: number,
    tokens: Address[],
    holder: Address,
    amount: BigNumber
  ): Promise<boolean> {
    return this.requestBalanceAllocations([{ chainId, tokens, holder, amount }]);
  }

  async getBalanceSubUsed(chainId: number, token: Address, holder: Address): Promise<BigNumber> {
    const balance = await this.getBalance(chainId, token, holder);
    const used = this.getUsed(chainId, token, holder);
    return balance.sub(used);
  }

  async getBalance(chainId: number, token: Address, holder: Address): Promise<BigNumber> {
    const tokenAddr = token.toBytes32();
    const holderAddr = holder.toBytes32();

    if (!this.balances?.[chainId]?.[tokenAddr]?.[holderAddr]) {
      const balance = await this._queryBalance(chainId, token, holder);

      // To avoid inconsistencies, we recheck the balances value after the query.
      // If it exists, skip the assignment so the value doesn't change after being set.
      // Note: cannot use assign because it breaks the BigNumber object.
      this.balances[chainId] ??= {};
      this.balances[chainId][tokenAddr] ??= {};
      this.balances[chainId][tokenAddr][holderAddr] ??= balance;
    }

    return this.balances[chainId][tokenAddr][holderAddr];
  }

  testSetBalance(chainId: number, token: Address, holder: Address, balance: BigNumber): void {
    const tokenAddr = token.toBytes32();
    const holderAddr = holder.toBytes32();

    this.balances[chainId] ??= {};
    this.balances[chainId][tokenAddr] ??= {};
    this.balances[chainId][tokenAddr][holderAddr] = balance;
  }

  getUsed(chainId: number, token: Address, holder: Address): BigNumber {
    const tokenAddr = token.toBytes32();
    const holderAddr = holder.toBytes32();

    this.used[chainId] ??= {};
    this.used[chainId][tokenAddr] ??= {};
    this.used[chainId][tokenAddr][holderAddr] ??= bnZero;

    return this.used[chainId][tokenAddr][holderAddr];
  }

  addUsed(chainId: number, token: Address, holder: Address, amount: BigNumber): void {
    const used = this.getUsed(chainId, token, holder);
    this.used[chainId][token.toBytes32()][holder.toBytes32()] = used.add(amount);
  }

  clearUsed(): void {
    this.used = {};
  }

  clearBalances(): void {
    this.balances = {};
  }

  // This method is primarily here to be overridden for testing purposes.
  protected async _queryBalance(chainId: number, token: Address, holder: Address): Promise<BigNumber> {
    if (chainIsEvm(chainId)) {
      const holderAddr = holder.toNative();
      return getNativeTokenAddressForChain(chainId).eq(token)
        ? await this.providers[chainId].getBalance(holderAddr)
        : await ERC20.connect(token.toNative(), this.providers[chainId]).balanceOf(holderAddr);
    } else {
      assert(token.isSVM());
      assert(holder.isSVM());
      return getSolanaTokenBalance(getSvmProvider(await getRedisCache()), token, holder);
    }
  }
}
