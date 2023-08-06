/**
 * @file Responsible for defining the ZKSync Era adapter for inventory management.
 * @see https://zksync.io/
 * @author Across Product Team
 */

import { BigNumber } from "ethers";
import { BaseAdapter } from "./BaseAdapter";
import { OutstandingTransfers } from "../../interfaces";
import { TransactionResponse, winston } from "../../utils";
import { SpokePoolClient } from "../SpokePoolClient";

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
      }
    }

    throw new Error("Method not implemented.");
  }
  sendTokenToTargetChain(
    address: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<TransactionResponse> {
    throw new Error("Method not implemented.");
  }
  checkTokenApprovals(address: string, l1Tokens: string[]): Promise<void> {
    throw new Error("Method not implemented.");
  }
}
