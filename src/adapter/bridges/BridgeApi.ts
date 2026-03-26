import { Contract, Signer } from "ethers";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { TokenInfo } from "../../interfaces";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  assert,
  Address,
  EvmAddress,
  winston,
  toBN,
  getNetworkName,
  CHAIN_IDs,
  getTimestampForBlock,
  groupObjectCountsByProp,
  toAddressType,
  getTokenInfo,
  isDefined,
  BridgeApiClient,
  BRIDGE_API_MINIMUMS,
  BRIDGE_API_DESTINATION_TOKENS,
  BRIDGE_API_DESTINATION_TOKEN_SYMBOLS,
  roundAmountToSend,
  mapAsync,
  floatToBN,
} from "../../utils";
import { TransferTokenParams } from "../utils";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";

export class BridgeApi extends BaseBridgeAdapter {
  protected api: BridgeApiClient;
  protected l1TokenInfo: TokenInfo;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress,
    readonly logger: winston.Logger
  ) {
    // Bridge API is only valid on mainnet.
    assert(hubChainId === CHAIN_IDs.MAINNET);

    super(l2chainId, hubChainId, l1Signer, []);
    this.l1Bridge = new Contract(l1Token.toNative(), ERC20_ABI, l1Signer);
    this.l2Bridge = new Contract(BRIDGE_API_DESTINATION_TOKENS[this.l2chainId], ERC20_ABI, l2SignerOrProvider);

    // We need to fetch some API configuration details from environment.
    const { BRIDGE_API_BASE, BRIDGE_API_KEY, BRIDGE_CUSTOMER_ID } = process.env;

    assert(isDefined(BRIDGE_API_BASE), "BRIDGE_API_BASE must be set in the environment");
    assert(isDefined(BRIDGE_API_KEY), "BRIDGE_API_KEY must be set in the environment");
    assert(isDefined(BRIDGE_CUSTOMER_ID), "BRIDGE_CUSTOMER_ID must be set in the environment");

    this.api = new BridgeApiClient(
      BRIDGE_API_BASE,
      BRIDGE_API_KEY,
      BRIDGE_CUSTOMER_ID,
      this.hubChainId,
      this.l2chainId,
      this.logger
    );

    this.l1TokenInfo = getTokenInfo(l1Token, this.hubChainId);
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    _l1Token: EvmAddress,
    l2Token: Address,
    _amount: BigNumber,
    _optionalParams?: TransferTokenParams
  ): Promise<BridgeTransactionDetails> {
    const amount = roundAmountToSend(_amount, this.l1TokenInfo.decimals, 2); // The bridge API only deals with values up to 2 decimals.
    assert(
      this.getL2Bridge().address === l2Token.toNative(),
      `Attempting to bridge unsupported l2 token ${l2Token.toNative()}`
    );
    // If amount is less than the network minimums, then throw.
    if (amount.lt(BRIDGE_API_MINIMUMS[this.hubChainId]?.[this.l2chainId] ?? toBN(Number.MAX_SAFE_INTEGER))) {
      throw new Error(`Cannot bridge to ${getNetworkName(this.l2chainId)} due to invalid amount ${amount}`);
    }
    const transferRouteAddress = await this.api.createTransferRouteEscrowAddress(
      toAddress,
      this.l1TokenInfo.symbol,
      BRIDGE_API_DESTINATION_TOKEN_SYMBOLS[this.getL2Bridge().address]
    );
    return Promise.resolve({
      contract: this.getL1Bridge(),
      method: "transfer",
      args: [transferRouteAddress, amount],
    });
  }

  async queryL1BridgeInitiationEvents(
    _l1Token: EvmAddress,
    _fromAddress: EvmAddress,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const fromTimestamp = await getTimestampForBlock(this.l1Signer.provider, eventConfig.from);
    const pendingTransfers = await this.api.getAllTransfersInRange(toAddress, fromTimestamp * 1000);

    const statusesGrouped = groupObjectCountsByProp(pendingTransfers, (pendingTransfer) => pendingTransfer.state);
    this.logger.debug({
      at: "BridgeApi#queryL1BridgeInitiationEvents",
      message: "Pending transfer statuses",
      statusesGrouped,
    });

    const pendingRebalances = await mapAsync(
      pendingTransfers.filter((pendingTransfer) => {
        const destinationAddress = toAddressType(pendingTransfer.destination.to_address, this.l2chainId);
        return (
          destinationAddress.eq(toAddress) &&
          pendingTransfer.state !== "awaiting_funds" &&
          pendingTransfer.state !== "payment_processed" &&
          pendingTransfer.source_deposit_instructions.currency === this.l1TokenInfo.symbol.toLowerCase()
        );
      }),
      async ({ receipt }) => {
        const transaction = await this.l1Signer.provider.getTransactionReceipt(receipt.source_tx_hash);
        return {
          txnRef: receipt.source_tx_hash,
          logIndex: 0, // logIndex is zero since the only call for initiation is a `Transfer`.
          txnIndex: transaction?.transactionIndex,
          blockNumber: transaction?.blockNumber,
          amount: floatToBN(receipt.final_amount, this.l1TokenInfo.decimals),
        };
      }
    );
    return {
      [this.getL2Bridge().address]: pendingRebalances,
    };
  }

  async queryL2BridgeFinalizationEvents(
    _l1Token: EvmAddress,
    _fromAddress: EvmAddress,
    _toAddress: Address,
    _eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    return Promise.resolve({});
  }
}
