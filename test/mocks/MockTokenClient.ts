import { BigNumber, bnZero, Contract, Address } from "../../src/utils";
import { TokenClient } from "../../src/clients";
import { L1Token } from "../../src/interfaces";

export class MockTokenClient extends TokenClient {
  public override tokenData: { [chainId: number]: { [token: string]: { balance: BigNumber; allowance: BigNumber } } } =
    {};
  public override tokenShortfall: {
    [chainId: number]: { [token: string]: { deposits: BigNumber[]; totalRequirement: BigNumber } };
  } = {};
  override unfilledDepositAmounts = {};

  setTokenData(chainId: number, token: Address, balance: BigNumber, allowance: BigNumber = bnZero): void {
    this.tokenData[chainId] ??= {};
    this.tokenData[chainId][token.toNative()] = { balance, allowance };
  }

  setTokenShortFallData(chainId: number, token: Address, deposits: BigNumber[], totalRequirement: BigNumber[]): void {
    this.tokenShortfall[chainId] ??= {};
    this.tokenShortfall[chainId][token.toNative()] = {
      deposits,
      totalRequirement: totalRequirement.reduce((acc, curr) => acc.add(curr), bnZero),
    };
    this.unfilledDepositAmounts[chainId] ??= {};
    this.unfilledDepositAmounts[chainId][token.toNative()] = totalRequirement;
  }

  getBalance(chainId: number, token: Address): BigNumber {
    return this.tokenData[chainId]?.[token.toNative()]?.balance ?? bnZero;
  }

  getTokensNeededToCoverShortfall(chainId: number, token: Address): BigNumber {
    return this.tokenShortfall[chainId]?.[token.toNative()]?.totalRequirement ?? bnZero;
  }

  decrementLocalBalance(chainId: number, token: Address, amount: BigNumber): void {
    const tokenAddr = token.toNative();

    this.tokenData[chainId] ??= {};
    this.tokenData[chainId][tokenAddr] ??= { balance: bnZero, allowance: bnZero };
    this.tokenData[chainId][tokenAddr].balance = this.tokenData[chainId][tokenAddr].balance.sub(amount);
  }
}

export class SimpleMockTokenClient extends TokenClient {
  private tokenContracts: Contract[] | undefined = undefined;
  private remoteTokenContracts: { [chainId: number]: Contract[] } | undefined = {};

  setRemoteTokens(tokens: Contract[], remoteTokenContracts?: { [chainId: number]: Contract[] }): void {
    this.tokenContracts = tokens;
    if (remoteTokenContracts) {
      this.remoteTokenContracts = remoteTokenContracts;
    }
  }

  resolveRemoteTokens(chainId: number, hubPoolTokens: L1Token[]): Contract[] {
    if (this.remoteTokenContracts?.[chainId]) {
      return this.remoteTokenContracts[chainId];
    }
    if (this.tokenContracts) {
      return this.tokenContracts;
    }
    return super.resolveRemoteTokens(chainId, hubPoolTokens);
  }
}
