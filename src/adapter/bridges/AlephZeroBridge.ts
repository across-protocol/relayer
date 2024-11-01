import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  Signer,
  EventSearchConfig,
  Provider,
  toBN,
  toWei,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";
import { PRODUCTION_NETWORKS, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";

export class AlephZeroBridge extends BaseBridgeAdapter {
  public gasToken: string;
  protected l1GatewayRouter: Contract;

  private readonly transactionSubmissionData =
    "0x000000000000000000000000000000000000000000000000002386f26fc1000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000";
  private readonly l2GasLimit = toBN(150000);
  private readonly l2GasPrice = toBN(20e9);
  private readonly l1SubmitValue = toWei(0.013);

  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    const { address: gatewayAddress, abi: gatewayRouterAbi } =
      CONTRACT_ADDRESSES[hubChainId].alephZeroErc20GatewayRouter;
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].alephZeroL1Gateway;
    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].erc20Gateway;

    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [l1Address]);

    const nativeToken = PRODUCTION_NETWORKS[l2chainId].nativeToken;
    this.gasToken = TOKEN_SYMBOLS_MAP[nativeToken].addresses[hubChainId];
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
    this.l1GatewayRouter = new Contract(gatewayAddress, gatewayRouterAbi, l1Signer);
  }

  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    const { l1GatewayRouter, l2GasLimit, l2GasPrice, transactionSubmissionData, l1SubmitValue } = this;
    return Promise.resolve({
      contract: l1GatewayRouter,
      method: "outboundTransfer",
      args: [l1Token, toAddress, amount, l2GasLimit, l2GasPrice, transactionSubmissionData],
      value: l1SubmitValue,
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const events = await paginatedEventQuery(
      this.getL1Bridge(),
      this.getL1Bridge().filters.DepositInitiated(undefined, undefined, toAddress),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events
        .filter(({ args }) => args.l1Token === l1Token)
        .map((event) => processEvent(event, "_amount", "_to", "_from")),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const events = await paginatedEventQuery(
      this.getL2Bridge(),
      this.getL2Bridge().filters.DepositFinalized(l1Token, undefined, toAddress),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "amount", "to", "from")),
    };
  }
}
