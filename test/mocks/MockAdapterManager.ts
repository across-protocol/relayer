import { AdapterManager } from "../../src/clients/bridges";
import { BigNumber, TransactionResponse, getTranslatedTokenAddress } from "../../src/utils";

import { createRandomBytes32 } from "../utils";
import { OutstandingTransfers } from "../../src/interfaces";

export class MockAdapterManager extends AdapterManager {
  public adapterChains: number[] | undefined;
  public tokensSentCrossChain: {
    [chainId: number]: { [l1Token: string]: { amount: BigNumber; hash: string } };
  } = {};

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
}
