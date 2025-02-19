import { AugmentedTransaction } from "../../clients/TransactionClient";
import { BigNumber, Contract, Signer } from "../../utils";

export abstract class BaseL2BridgeAdapter {
  protected l2Bridge: Contract;

  constructor(protected l2chainId: number, protected hubChainId: number, protected l2Signer: Signer) {}

  abstract constructWithdrawToL1Txns(
    toAddress: string,
    l2Token: string,
    l1Token: string,
    amount: BigNumber
  ): AugmentedTransaction[];
}
