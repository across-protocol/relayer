/**
 * @file Responsible for managing
 */

import { BigNumber } from "ethers";
import { BaseAdapter } from "./BaseAdapter";
import { OutstandingTransfers } from "../../interfaces";
import { TransactionResponse } from "../../utils";

export class ZKSyncAdapter extends BaseAdapter {
  getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<OutstandingTransfers> {
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
