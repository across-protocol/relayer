import { BigNumber, toBN } from "../../src/utils";
import { TokenClient } from "../../src/clients";

export class MockTokenClient extends TokenClient {
  public override tokenData: { [chainId: number]: { [token: string]: { balance: BigNumber; allowance: BigNumber } } } =
    {};
  public tokenShortfall: {
    [chainId: number]: { [token: string]: { deposits: number[]; totalRequirement: BigNumber } };
  } = {};

  setTokenData(chainId: number, token: string, balance: BigNumber, allowance: BigNumber = toBN(0)): void {
    if (!this.tokenData[chainId]) {
      this.tokenData[chainId] = {};
    }
    this.tokenData[chainId][token] = { balance, allowance };
  }
  setTokenShortFallData(chainId: number, token: string, deposits: number[], totalRequirement: BigNumber): void {
    if (!this.tokenShortfall[chainId]) {
      this.tokenShortfall[chainId] = {};
    }
    this.tokenShortfall[chainId][token] = { deposits, totalRequirement };
  }

  getBalance(chainId: number, token: string): BigNumber {
    return this.tokenData[chainId]?.[token]?.balance || toBN(0);
  }

  getTokensNeededToCoverShortfall(chainId: number, token: string): BigNumber {
    return this.tokenShortfall[chainId]?.[token]?.totalRequirement || toBN(0);
  }

  decrementLocalBalance(chainId: number, token: string, amount: BigNumber): void {
    if (!this.tokenData[chainId]) {
      this.tokenData[chainId] = {};
    }
    if (!this.tokenData[chainId][token]) {
      this.tokenData[chainId][token] = { balance: toBN(0), allowance: toBN(0) };
    }
    this.tokenData[chainId][token].balance = this.tokenData[chainId][token].balance.sub(amount);
  }
}
