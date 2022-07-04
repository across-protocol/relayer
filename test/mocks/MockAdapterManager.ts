import { AdapterManager } from "../../src/clients/bridges";
import { BigNumber } from "../../src/utils";

import { createRandomBytes32 } from "../utils";

export class MockAdapterManager extends AdapterManager {
  public tokensSentCrossChain: {
    [chainId: number]: { [l1Token: string]: { amount: BigNumber; hash: string } };
  } = {};

  public mockedOutstandingCrossChainTransfers: {
    [chainId: number]: { [address: string]: { [l1Token: string]: BigNumber } };
  } = {};
  async sendTokenCrossChain(address: string, chainId: number, l1Token: string, amount: BigNumber) {
    if (!this.tokensSentCrossChain[chainId]) this.tokensSentCrossChain[chainId] = {};
    const hash = createRandomBytes32();
    this.tokensSentCrossChain[chainId][l1Token] = { amount, hash };
    return { hash };
  }

  override async getOutstandingCrossChainTokenTransferAmount(
    chainId: number,
    l1Tokens: string[]
  ): Promise<{ [address: string]: { [l1Token: string]: BigNumber } }> {
    return this.mockedOutstandingCrossChainTransfers[chainId];
  }

  setMockedOutstandingCrossChainTransfers(chainId: number, address: string, l1Token: string, amount: BigNumber) {
    if (!this.mockedOutstandingCrossChainTransfers[chainId]) this.mockedOutstandingCrossChainTransfers[chainId] = {};
    const transfers = this.mockedOutstandingCrossChainTransfers[chainId];
    if (!transfers[address]) transfers[address] = {};
    transfers[address][l1Token] = amount;
  }
}
