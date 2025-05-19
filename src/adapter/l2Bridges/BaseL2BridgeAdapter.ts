import { AugmentedTransaction } from "../../clients/TransactionClient";
import { BigNumber, Contract, EventSearchConfig, Provider, Signer, EvmAddress, Address } from "../../utils";

export abstract class BaseL2BridgeAdapter {
  protected l2Bridge: Contract;
  protected l1Bridge: Contract;

  constructor(
    protected l2chainId: number,
    protected hubChainId: number,
    protected l2Signer: Signer,
    protected l1Provider: Provider | Signer,
    protected l1Token: EvmAddress
  ) {}

  abstract constructWithdrawToL1Txns(
    toAddress: Address,
    l2Token: Address,
    l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]>;

  abstract getL2PendingWithdrawalAmount(
    l2EventSearchConfig: EventSearchConfig,
    l1EventSearchConfig: EventSearchConfig,
    fromAddress: Address,
    l2Token: Address
  ): Promise<BigNumber>;
}
