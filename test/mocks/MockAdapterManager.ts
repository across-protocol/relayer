import { AdapterManager } from "../../src/clients/bridges";
import { BigNumber, TransactionResponse } from "../../src/utils";

import { createRandomBytes32 } from "../utils";
import { OutstandingTransfers } from "../../src/interfaces";

export class MockAdapterManager extends AdapterManager {
  public adapterChains: number[] | undefined;
  public tokensSentCrossChain: {
    [chainId: number]: { [l1Token: string]: { amount: BigNumber; hash: string } };
  } = {};

  public mockedOutstandingCrossChainTransfers: { [chainId: number]: OutstandingTransfers } = {};
  async sendTokenCrossChain(address: string, chainId: number, l1Token: string, amount: BigNumber) {
    if (!this.tokensSentCrossChain[chainId]) {
      this.tokensSentCrossChain[chainId] = {};
    }
    const hash = createRandomBytes32();
    this.tokensSentCrossChain[chainId][l1Token] = { amount, hash };
    return { hash } as TransactionResponse;
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

  setMockedOutstandingCrossChainTransfers(chainId: number, address: string, l1Token: string, amount: BigNumber) {
    if (!this.mockedOutstandingCrossChainTransfers[chainId]) {
      this.mockedOutstandingCrossChainTransfers[chainId] = {};
    }
    const transfers = this.mockedOutstandingCrossChainTransfers[chainId];
    if (!transfers[address]) {
      transfers[address] = {};
    }
    transfers[address][l1Token] = { totalAmount: amount, depositTxHashes: [] };
  }
}
