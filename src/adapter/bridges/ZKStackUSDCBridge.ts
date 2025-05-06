import {
  Contract,
  compareAddressesSimple,
  BigNumber,
  Signer,
  Provider,
  EventSearchConfig,
  EvmAddress,
  paginatedEventQuery,
  isDefined,
  bnZero,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { processEvent } from "../utils";
import { BridgeEvents, BridgeTransactionDetails } from "./BaseBridgeAdapter";
import { ZKStackBridge } from "./ZKStackBridge";

/* For both the canonical bridge (this bridge) and the ZkStackWethBridge
 * bridge, we need to assume that the l1 and l2 signers contain
 * associated providers, since we need to get information about
 * addresses and gas prices (this is also why `constructL1toL2Txn`
 * is an async fn).
 */
export class ZKStackUSDCBridge extends ZKStackBridge {
  readonly usdcBridge: Contract;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress
  ) {
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, l1Token);
    const { address: l1Bridge, abi: l1ABI } = CONTRACT_ADDRESSES[hubChainId][`zkStackUSDCBridge_${l2chainId}`];
    this.usdcBridge = new Contract(l1Bridge, l1ABI, l1Signer);

    const { address: l2Bridge, abi: l2ABI } = CONTRACT_ADDRESSES[l2chainId].usdcBridge;
    this.l2Bridge = new Contract(l2Bridge, l2ABI, l2SignerOrProvider);

    this.l1Gateways.push(EvmAddress.from(this.usdcBridge.address));
  }

  async constructL1ToL2Txn(
    toAddress: EvmAddress,
    l1Token: EvmAddress,
    _l2Token: EvmAddress,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    // The zkStack bridges need to know the l2 gas price bid beforehand. If this bid is too small, the transaction will revert.
    const txBaseCost = await this._txBaseCost();
    const secondBridgeCalldata = this._secondBridgeCalldata(toAddress, l1Token, amount);
    const contract = this.getL1Bridge();

    const args = [
      [
        this.l2chainId,
        txBaseCost,
        0,
        this.l2GasLimit,
        this.gasPerPubdataLimit,
        toAddress.toAddress(),
        this.usdcBridge.address,
        0,
        secondBridgeCalldata,
      ],
    ];
    const value = isDefined(this.gasToken) ? bnZero : txBaseCost;

    return { contract, method: "requestL2TransactionTwoBridges", args, value };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    _from: EvmAddress,
    to: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const filter = this.usdcBridge.filters.BridgehubDepositInitiated(this.l2chainId, null, null);
    const events = await paginatedEventQuery(this.usdcBridge, filter, eventConfig);

    const processedEvents = events
      .filter(
        ({ args }) =>
          compareAddressesSimple(args.to, to.toAddress()) && compareAddressesSimple(args.l1Token, l1Token.toAddress())
      )
      .map((e) => processEvent(e, "amount"));

    return {
      [this.resolveL2TokenAddress(l1Token)]: processedEvents,
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
    _from: EvmAddress,
    to: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l2Token = this.resolveL2TokenAddress(l1Token);
    const l2Bridge = this.getL2Bridge();
    const filter = l2Bridge.filters.FinalizeDeposit(null, to.toAddress(), l2Token);
    const events = await paginatedEventQuery(l2Bridge, filter, eventConfig);

    return {
      [l2Token]: events.map((event) => processEvent(event, "amount")),
    };
  }
}
