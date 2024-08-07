import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  EventSearchConfig,
  Signer,
  Provider,
  toWei,
  fixedPointAdjustment,
  isContractDeployedToAddress,
  bnZero,
  compareAddressesSimple,
  TOKEN_SYMBOLS_MAP,
} from "../../utils";
import { CONTRACT_ADDRESSES, SCROLL_CUSTOM_GATEWAY } from "../../common";
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";

const SCROLL_STANDARD_GATEWAY: { l1: string; l2: string } = {
  l1: "0xD8A791fE2bE73eb6E6cF1eb0cb3F36adC9B3F8f9",
  l2: "0xE2b4795039517653c5Ae8C2A9BFdd783b48f447A",
};

export class ScrollERC20Bridge extends BaseBridgeAdapter {
  // Gas limit obtained here: https://docs.scroll.io/en/developers/l1-and-l2-bridging/eth-and-erc20-token-bridge
  protected l2Gas = 200000;
  protected feeMultiplier = toWei(1.5);
  protected readonly scrollGasPriceOracle: Contract;

  protected readonly scrollGatewayRouter;
  protected readonly hubPoolAddress;
  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: string
  ) {
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].scrollGatewayRouter;
    const l2Abi = CONTRACT_ADDRESSES[l2chainId].scrollGatewayRouter.abi;
    const { l1: l1BridgeAddress, l2: l2BridgeAddress } = SCROLL_CUSTOM_GATEWAY[l1Token] ?? SCROLL_STANDARD_GATEWAY;

    const { address: gasPriceOracleAddress, abi: gasPriceOracleAbi } =
      CONTRACT_ADDRESSES[hubChainId].scrollGasPriceOracle;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [l1Address]);

    this.l1Bridge = new Contract(l1BridgeAddress, l1Abi, l1Signer);
    this.l2Bridge = new Contract(l2BridgeAddress, l2Abi, l2SignerOrProvider);

    this.scrollGatewayRouter = new Contract(l1Address, l1Abi, l1Signer);
    this.scrollGasPriceOracle = new Contract(gasPriceOracleAddress, gasPriceOracleAbi, l1Signer);

    this.hubPoolAddress = CONTRACT_ADDRESSES[hubChainId].hubPool.address;
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
      contract: this.getScrollGatewayRouter(),
      method: "depositERC20",
      args: [l1Token, toAddress, amount, this.l2Gas],
      value: bufferedFee,
    });
  }

  // The deposit/finalize events that Scroll gateways emit do not index the recipient of transfers. This makes cross-chain transfer tracking a bit
  // tricky since the recipient of a deposit may not be the same as the depositor (e.g. hub -> spoke transfers, or randomEoa -> monitoredEoa transfers).
  // For both queryL1BridgeInitiationEvents and queryL2BridgeFinalizationEvents, we currently make the assumption that if we are sending to an L2 contract, then
  // this L2 contract is the spoke pool, and the original depositor is the hub pool. Likewise, if we are sending to an EOA, then the recipient is the same as the depositor.
  // While this limits our ability to track all types of events (and incurs an extra RPC call), we must do this to prevent an expensive event query
  // (i.e. ...filters.DepositERC20(l1Token, undefined, undefined), which would return, for example, all WETH deposits to Scroll within the past 10,000 blocks).
  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const isL2Contract = await isContractDeployedToAddress(toAddress, this.l2Bridge.provider);
    const monitoredFromAddress = isL2Contract ? this.hubPoolAddress : fromAddress;

    const l1Bridge = this.getL1Bridge();
    const events = await paginatedEventQuery(
      l1Bridge,
      l1Bridge.filters.DepositERC20(l1Token, undefined, monitoredFromAddress),
      eventConfig
    );
    // Take all events which are sending an amount greater than 0.
    const processedEvents = events
      .map((event) => processEvent(event, "amount", "to", "from"))
      .filter(({ amount }) => amount > bnZero);
    return {
      [this.resolveL2TokenAddress(l1Token)]: processedEvents.filter(({ to }) => to === toAddress), // Only return the events which match to the toAddress
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const isL2Contract = await isContractDeployedToAddress(toAddress, this.l2Bridge.provider);
    const monitoredFromAddress = isL2Contract ? this.hubPoolAddress : fromAddress;

    const l2Bridge = this.getL2Bridge();
    const events = await paginatedEventQuery(
      l2Bridge,
      l2Bridge.filters.FinalizeDepositERC20(l1Token, undefined, monitoredFromAddress),
      eventConfig
    );
    const processedEvents = events
      .map((event) => processEvent(event, "amount", "to", "from"))
      .filter(({ amount }) => amount > bnZero);
    return {
      [this.resolveL2TokenAddress(l1Token)]: processedEvents.filter(({ to }) => to === toAddress),
    };
  }

  protected getScrollGasPriceOracle(): Contract {
    return this.scrollGasPriceOracle;
  }

  protected getScrollGatewayRouter(): Contract {
    return this.scrollGatewayRouter;
  }

  protected override resolveL2TokenAddress(l1Token: string): string {
    if (compareAddressesSimple(TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId], l1Token)) {
      return TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId]; // Scroll only has one USDC token type.
    }
    return super.resolveL2TokenAddress(l1Token);
  }
}
