import { BigNumber, ERC20, ethers, ZERO_ADDRESS } from "../utils";

const ovmEthAddresses = ["0x4200000000000000000000000000000000000006", "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000"];
const ovmChainIds = [10, 288];

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

  async requestBalanceAllocations(
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

  async requestBalanceAllocation(chainId: number, token: string, holder: string, amount: BigNumber): Promise<boolean> {
    return this.requestBalanceAllocations([{ chainId, token, holder, amount }]);
  }

  async getBalance(chainId: number, token: string, holder: string) {
    if (!this.balances?.[chainId]?.[token]?.[holder]) {
      let balance: BigNumber;
      // If chain is an OVM and the token is a weth address, then sum both weth and eth addresses
      // since the Ovm_SpokePool will automatically deposit ETH into WETH before executing a leaf.
      if (ovmChainIds.includes(chainId) && ovmEthAddresses.includes(token))
        balance = (await ERC20.connect(ovmEthAddresses[0], this.providers[chainId]).balanceOf(holder)).add(
          await ERC20.connect(ovmEthAddresses[1], this.providers[chainId]).balanceOf(holder)
        );
      else
        balance =
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
