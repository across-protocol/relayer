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
import * as zksync from "zksync";

class ZKSyncWallet extends zksync.Wallet {}

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
    // Call into the deposit transaction to get create the transaction to Sync
    const depositTxn = await signer.depositToSyncFromEthereum({
      token: l1Token, // The ZKSync SDK only requires the Ethereum token address
      depositTo: address, // The address to deposit to
      amount: amount.toString(), // The amount to transmit
      approveDepositAmountForERC20: true, // Will approve the ERC20 token if it hasn't been already
    });
    // Resolve just the ETH transaction from the deposit transaction
    return depositTxn.ethTx;
  }

  async checkTokenApprovals(address: string, l1Tokens: string[]): Promise<void> {
    // Resolve the signer from the L1Signer
    const signer = await this.getL1Signer();
    // Approve all tokens
    await Promise.all(
      l1Tokens.map(async (l1Token) => {
        // We want to approve the maximum amount of tokens
        const txn = await signer.approveERC20TokenDeposits(l1Token, BigNumber.from(MAX_SAFE_ALLOWANCE));
        // Wait for the transaction to be mined
        return txn.wait();
      })
    );
  }

  /**
   * Resolves an L1Signer from the ZKSync chain
   * @returns The L1Signer for the ZKSync chain
   */
  private async getL1Signer(): Promise<ZKSyncWallet> {
    const signerOnEthereum = this.spokePoolClients[1].spokePool.signer;
    const wallet = ZKSyncWallet.fromEthSigner(
      signerOnEthereum,
      this.spokePoolClients[324].spokePool.provider as unknown as zksync.SyncProvider
    );
    return wallet;
  }
}
