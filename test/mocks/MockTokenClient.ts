import { BigNumber, toBN } from "../../src/utils";
import { TokenClient } from "../../src/clients";

export class MockTokenClient extends TokenClient {
  public override tokenData: { [chainId: number]: { [token: string]: { balance: BigNumber; allowance: BigNumber } } } =
    {};
  public tokenShortfall: {
    [chainId: number]: { [token: string]: { deposits: number[]; totalRequirement: BigNumber } };
  } = {};

  setTokenData(chainId: number, token: string, balance: BigNumber, allowance: BigNumber = toBN(0)) {
    if (!this.tokenData[chainId]) {
      this.tokenData[chainId] = {};
    }
    this.tokenData[chainId][token] = { balance, allowance };
  }
  setTokenShortFallData(chainId: number, token: string, deposits: number[], totalRequirement: BigNumber) {
    if (!this.tokenShortfall[chainId]) {
      this.tokenShortfall[chainId] = {};
    }
    this.tokenShortfall[chainId][token] = { deposits, totalRequirement };
  }

  getBalance(chainId: number, token: string) {
    if (!this.tokenData[chainId]) {
      return toBN(0);
    }
    if (!this.tokenData[chainId][token]) {
      return toBN(0);
    }
    return this.tokenData[chainId][token].balance;
  }

  getTokensNeededToCoverShortfall(chainId: number, token: string) {
    if (!this.tokenShortfall[chainId]) {
      return toBN(0);
    }
    if (!this.tokenShortfall[chainId][token]) {
      return toBN(0);
    }
    return this.tokenShortfall[chainId][token].totalRequirement;
  }

  decrementLocalBalance(chainId: number, token: string, amount: BigNumber) {
    if (!this.tokenData[chainId]) {
      this.tokenData[chainId] = {};
    }
    if (!this.tokenData[chainId][token]) {
      this.tokenData[chainId][token] = { balance: toBN(0), allowance: toBN(0) };
    }
    this.tokenData[chainId][token].balance = this.tokenData[chainId][token].balance.sub(amount);
  }
}
