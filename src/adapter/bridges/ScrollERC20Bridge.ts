import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  EventSearchConfig,
  Signer,
  Provider,
  toWei,
  fixedPointAdjustment,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";

export class ScrollERC20Bridge extends BaseBridgeAdapter {
  // Gas limit obtained here: https://docs.scroll.io/en/developers/l1-and-l2-bridging/eth-and-erc20-token-bridge
  protected l2Gas = 200000;
  protected feeMultiplier = toWei(1.5);
  protected readonly scrollGasPriceOracle: Contract;
  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    _l1Token: string
  ) {
    // Lint Appeasement
    _l1Token;
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].scrollGatewayRouter;
    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].scrollGatewayRouter;
    const { address: gasPriceOracleAddress, abi: gasPriceOracleAbi } =
      CONTRACT_ADDRESSES[hubChainId].scrollGasPriceOracle;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [l1Address]);

    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
    this.scrollGasPriceOracle = new Contract(gasPriceOracleAddress, gasPriceOracleAbi, l1Signer);
  }

  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    const baseFee = await this.getScrollGasPriceOracle().estimateCrossDomainMessageFee(this.l2Gas);
    const bufferedFee = baseFee.mul(this.feeMultiplier).div(fixedPointAdjustment);
    return Promise.resolve({
      contract: this.getL1Bridge(),
      method: "depositERC20",
      args: [l1Token, toAddress, amount, this.l2Gas],
      value: bufferedFee,
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l1Bridge = this.getL1Bridge();
    const events = await paginatedEventQuery(
      l1Bridge,
      l1Bridge.filters.DepositERC20(l1Token, undefined, fromAddress),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "amount", "to", "from")),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l2Bridge = this.getL2Bridge();
    const events = await paginatedEventQuery(
      l2Bridge,
      l2Bridge.filters.FinalizeDepositERC20(l1Token, undefined, fromAddress),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "amount", "to", "from")),
    };
  }

  protected getScrollGasPriceOracle(): Contract {
    return this.scrollGasPriceOracle;
  }
}
