import { AugmentedTransaction } from "../../clients/TransactionClient";
import { BigNumber, Contract, EventSearchConfig, Provider, Signer } from "../../utils";

export abstract class BaseL2BridgeAdapter {
  protected l2Bridge: Contract;
  protected l1Bridge: Contract;

  constructor(
    protected l2chainId: number,
    protected hubChainId: number,
    protected l2Signer: Signer,
    protected l1Provider: Provider | Signer,
    protected l1Token: string
  ) {}

  abstract constructWithdrawToL1Txns(
    toAddress: string,
    l2Token: string,
    l1Token: string,
    amount: BigNumber
  ): AugmentedTransaction[];

  abstract getL2PendingWithdrawalAmount(
    l2EventSearchConfig: EventSearchConfig,
    l1EventSearchConfig: EventSearchConfig,
    fromAddress: string,
    l2Token: string
  ): Promise<BigNumber>;
}
