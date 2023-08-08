/**
 * @file Responsible for defining the ZKSync Era adapter for inventory management.
 * @see https://zksync.io/
 * @author Across Product Team
 */

import { BigNumber } from "ethers";
import { BaseAdapter } from "./BaseAdapter";
import { OutstandingTransfers } from "../../interfaces";
import { MAX_SAFE_ALLOWANCE, TransactionResponse, winston } from "../../utils";
import { SpokePoolClient } from "../SpokePoolClient";
import { L1Signer, Provider, Signer } from "zksync-web3";

/**
 * Responsible for providing a common interface for interacting with the ZKSync Era
 * where related to Across' inventory management.
 */
export class ZKSyncAdapter extends BaseAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    super(spokePoolClients, 324, monitoredAddresses, logger);
  }

  getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<OutstandingTransfers> {
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();
    this.log("Getting cross-chain txs", { l1Tokens, l1Config: l1SearchConfig, l2Config: l2SearchConfig });

    for (const l1Token of l1Tokens) {
      for (const monitoredAddress of this.monitoredAddresses) {
        l1Token;
        monitoredAddress;
        continue;
      }
    }
    throw new Error("Method not implemented.");
  }
  async sendTokenToTargetChain(
    address: string,
    l1Token: string,
    _l2Token: string,
    amount: BigNumber
  ): Promise<TransactionResponse> {
    // Let's first confirm that we're only here for the right chain
    if (this.chainId !== 324) {
      throw new Error("This method should only be called for the ZKSync chain");
    }
    // Resolve the signer from the L1Signer
    const signer = await this.getL1Signer();
    const depositTxn = await signer.deposit({
      token: l1Token, // The ZKSync SDK only requires the Ethereum token address
      amount: amount.toString(), // The amount to transmit
      to: address, // The address to receive the tokens on the L2 chain
      approveERC20: true, // Will approve the ERC20 token if it hasn't been already
    });
    return depositTxn;
  }

  async checkTokenApprovals(address: string, l1Tokens: string[]): Promise<void> {
    const signer = await this.getL1Signer();
    await Promise.all(
      l1Tokens.map(async (l1Token) => {
        const txn = await signer.approveERC20(l1Token, MAX_SAFE_ALLOWANCE);
        return txn.wait();
      })
    );
  }

  /**
   * Resolves an L1Signer from the ZKSync chain
   * @returns The L1Signer for the ZKSync chain
   */
  private async getL1Signer(): Promise<L1Signer> {
    const signerOnZKSync = this.spokePoolClients[324].spokePool.signer;
    const signerOnEthereum = this.spokePoolClients[1].spokePool.signer;

    const signer = L1Signer.from(signerOnEthereum as Signer, signerOnZKSync.provider as Provider);
    return signer;
  }
}
