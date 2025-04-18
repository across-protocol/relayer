import { AdapterManager } from "../../src/clients/bridges";
import { BigNumber, TransactionResponse, bnZero, getTranslatedTokenAddress } from "../../src/utils";

import { createRandomBytes32 } from "../utils";
import { OutstandingTransfers } from "../../src/interfaces";
import { BaseChainAdapter } from "../../src/adapter";

type L2Withdrawal = { l2Token: string; amountToWithdraw: BigNumber; l2ChainId: number; address: string };
export class MockAdapterManager extends AdapterManager {
  public adapterChains: number[] | undefined;
  public tokensSentCrossChain: {
    [chainId: number]: { [l1Token: string]: { amount: BigNumber; hash: string } };
  } = {};
  public pendingL2WithdrawalAmounts: {
    [timePeriod: number]: BigNumber;
  } = {};
  public withdrawalsRequired: L2Withdrawal[] = [];

  public mockedOutstandingCrossChainTransfers: { [chainId: number]: OutstandingTransfers } = {};
  async sendTokenCrossChain(
    _address: string,
    chainId: number,
    l1Token: string,
    amount: BigNumber
  ): Promise<TransactionResponse> {
    if (!this.tokensSentCrossChain[chainId]) {
      this.tokensSentCrossChain[chainId] = {};
    }
    const hash = createRandomBytes32();
    this.tokensSentCrossChain[chainId][l1Token] = { amount, hash };
    return { hash } as TransactionResponse;
  }

  setAdapters(chainId, adapter: BaseChainAdapter): void {
    this.adapters[chainId] = adapter;
  }

  setSupportedChains(chains: number[]): void {
    this.adapterChains = chains;
  }
  supportedChains(): number[] {
    return this.adapterChains ?? super.supportedChains();
  }

  override async getOutstandingCrossChainTokenTransferAmount(
    chainId: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _l1Tokens: string[]
  ): Promise<OutstandingTransfers> {
    return this.mockedOutstandingCrossChainTransfers[chainId];
  }

  setMockedOutstandingCrossChainTransfers(
    chainId: number,
    address: string,
    l1Token: string,
    amount: BigNumber,
    l2Token?: string
  ): void {
    this.mockedOutstandingCrossChainTransfers[chainId] ??= {};

    const transfers = this.mockedOutstandingCrossChainTransfers[chainId];

    transfers[address] ??= {};
    transfers[address][l1Token] ??= {};

    l2Token ??= getTranslatedTokenAddress(l1Token, 1, chainId, false);

    transfers[address][l1Token][l2Token] = {
      totalAmount: amount,
      depositTxHashes: [],
    };
  }

  setL2PendingWithdrawalAmount(timePeriod: number, amount: BigNumber): void {
    this.pendingL2WithdrawalAmounts ??= {};
    this.pendingL2WithdrawalAmounts[timePeriod] = amount;
  }

  getL2PendingWithdrawalAmount(withdrawExcessPeriod: number): Promise<BigNumber> {
    const pendingWithdrawalThresholds = Object.entries(this.pendingL2WithdrawalAmounts)
      .filter(([timePeriod]) => Number(timePeriod) >= withdrawExcessPeriod)
      .sort(([timePeriod]) => Number(timePeriod));
    if (pendingWithdrawalThresholds.length > 0) {
      return Promise.resolve(pendingWithdrawalThresholds[0][1]);
    } else {
      return Promise.resolve(bnZero);
    }
  }

  withdrawTokenFromL2(
    address: string,
    l2ChainId: number,
    l2Token: string,
    amountToWithdraw: BigNumber
  ): Promise<string[]> {
    this.withdrawalsRequired.push({
      l2Token,
      amountToWithdraw,
      l2ChainId,
      address,
    });
    return Promise.resolve(["0xabcd"]);
  }
}
