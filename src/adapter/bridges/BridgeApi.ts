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
  TOKEN_SYMBOLS_MAP,
  getTimestampForBlock,
  groupObjectCountsByProp,
  toAddressType,
  getTokenInfo,
  delay,
} from "../../utils";
import { TransferTokenParams } from "../utils";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";
import axios, { AxiosHeaders } from "axios";

export const BRIDGE_API_MINIMUMS: { [l2ChainId: number]: BigNumber } = {
  [CHAIN_IDs.MAINNET]: toBN(5_000_000), // 5 USDC
  [CHAIN_IDs.TEMPO]: toBN(5_000_000), // 5 USDC
};

export type BridgeResponse = {
  state: string;
  created_at: string;
  updated_at: string;
  destination: {
    payment_rail: string;
    currency: string;
    to_address: string;
  };
  source_deposit_instructions: {
    payment_rail: string;
    currency: string;
    to_address: string;
    from_address: string;
  };
  receipt:
    | {
        initial_amount: string;
        final_amount: string;
        source_tx_hash: string;
      }
    | undefined;
};

// We need to instruct this bridge what tokens we expect to receive on L2, since the bridge
// API supports multiple destination tokens for a single L1 token.
const BRIDGE_API_DESTINATION_TOKENS: { [l2ChainId: number]: string } = {
  [CHAIN_IDs.TEMPO]: TOKEN_SYMBOLS_MAP.pathUSD.addresses[CHAIN_IDs.TEMPO],
};

export class BridgeApi extends BaseBridgeAdapter {
  protected bridgeApiBase: string;
  protected bridgeApiKey: string;
  protected customerId: string;
  protected l1TokenInfo: TokenInfo;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    readonly logger: winston.Logger
  ) {
    // Bridge API is only valid on mainnet.
    assert(hubChainId === CHAIN_IDs.MAINNET);

    super(l2chainId, hubChainId, l1Signer, []);
    this.l1Bridge = new Contract(l1Token.toNative(), ERC20_ABI, l1Signer);
    this.l2Bridge = new Contract(BRIDGE_API_DESTINATION_TOKENS[this.l2chainId], ERC20_ABI, l2SignerOrProvider);

    // We need to fetch some API configuration details from environment.
    const { BRIDGE_API_BASE, BRIDGE_API_KEY, BRIDGE_CUSTOMER_ID } = process.env;
    this.bridgeApiBase = String(BRIDGE_API_BASE);
    this.bridgeApiKey = String(BRIDGE_API_KEY);
    this.customerId = String(BRIDGE_CUSTOMER_ID);

    this.l1TokenInfo = getTokenInfo(l1Token, this.hubChainId);
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _optionalParams?: TransferTokenParams
  ): Promise<BridgeTransactionDetails> {
    assert(
      this.getL2Bridge().address === l2Token.toNative(),
      `Attempting to bridge unsupported l2 token ${l2Token.toNative()}`
    );
    // If amount is less than the network minimums, then throw.
    if (amount.lt(BRIDGE_API_MINIMUMS[this.l2chainId])) {
      throw new Error(`Cannot bridge to ${getNetworkName(this.l2chainId)} due to invalid amount ${amount}`);
    }
    const transferRouteAddress = await this.createTransferRouteEscrowAddress(toAddress);
    return Promise.resolve({
      contract: this.getL1Bridge(),
      method: "transfer",
      args: [transferRouteAddress, amount],
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const fromTimestamp = await getTimestampForBlock(this.l1Signer.provider, eventConfig.from);
    const { data: pendingTransfers } = await this._getAllTransfersInRange(toAddress, fromTimestamp * 1000);

    const statusesGrouped = groupObjectCountsByProp(pendingTransfers, (pendingTransfer) => pendingTransfer.state);
    this.logger.debug({
      at: "BridgeApi#queryL1BridgeInitiationEvents",
      message: "Pending transfer statuses",
      statusesGrouped,
    });

    const pendingRebalances = pendingTransfers
      .filter((pendingTransfer) => {
        const destinationAddress = toAddressType(pendingTransfer.destination.to_address, this.l2chainId);
        return (
          destinationAddress.eq(toAddress) &&
          pendingTransfer.state !== "awaiting_funds" &&
          pendingTransfer.state !== "payment_processed"
        );
      })
      .map(({ receipt }) => {
        return {
          txnRef: receipt.source_tx_hash,
          logIndex: 0, // logIndex and txnIndex are irrelevant since the bridge transaction is a `transfer`.
          txnIndex: 0,
          amount: toBN(Math.floor(Number(receipt.final_amount) * 10 ** this.l1TokenInfo.decimals)),
        };
      });
    return {
      [this.getL2Bridge().address]: pendingRebalances,
    };
  }

  async queryL2BridgeFinalizationEvents(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _l1Token: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _fromAddress: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _toAddress: Address,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    return Promise.resolve({});
  }

  private async _getAllTransfersInRange(toAddress: Address, fromTimestampMs: number) {
    const headers = this._defaultHeaders();
    return this._get<BridgeResponse>(`v0/transfers?updated_after_ms=${fromTimestampMs}`, headers);
  }

  private async createTransferRouteEscrowAddress(toAddress: Address) {
    const data = {
      on_behalf_of: `${this.customerId}`,
      source: {
        payment_rail: "ethereum",
        currency: "usdc",
      },
      destination: {
        payment_rail: "tempo",
        currency: "path_usd",
        to_address: toAddress.toNative(),
      },
      return_instructions: {
        address: toAddress.toNative(),
      },
      features: {
        allow_any_from_address: true,
        flexible_amount: true,
      },
    };
    const idempotencyKey = String(Date.now());
    const headers = {
      ...this._defaultHeaders(),
      "Idempotency-Key": idempotencyKey,
    };
    const transferRequestData = await this._post<BridgeResponse>(
      "v0/transfers",
      data,
      headers as unknown as AxiosHeaders
    );
    return transferRequestData.source_deposit_instructions.to_address;
  }

  private _defaultHeaders() {
    return {
      "Api-Key": `${this.bridgeApiKey}`,
      "Content-Type": "application/json",
    } as unknown as AxiosHeaders;
  }

  private async _get<T>(endpoint: string, headers: AxiosHeaders, nRetries = 2) {
    try {
      const response = await axios.get<T>(`${this.bridgeApiBase}/${endpoint}`, { headers });
      return response.data;
    } catch (e) {
      this.logger.debug({
        at: "BridgeApi#_get",
        message: "Failed to query bridge API",
        endpoint,
        e,
      });
      if (nRetries > 0) {
	await delay(1);
        return this._get<T>(endpoint, headers, --nRetries);
      }
      throw e;
    }
  }

  private async _post<T>(endpoint: string, data: Record<string, unknown>, headers: AxiosHeaders, nRetries = 2) {
    try {
      const response = await axios.post<T>(`${this.bridgeApiBase}/${endpoint}`, data, { headers });
      return response.data;
    } catch (e) {
      this.logger.debug({
        at: "BridgeApi#_post",
        message: "Failed to post to bridge API",
        endpoint,
        data,
        e,
      });
      if (nRetries > 0) {
	await delay(1);
        return this._post<T>(endpoint, data, headers, --nRetries);
      }
      throw e;
    }
  }
}
