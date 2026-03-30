import {
  CHAIN_IDs,
  Address,
  delay,
  TOKEN_SYMBOLS_MAP,
  toBN,
  winston,
  BigNumber,
  EventSearchConfig,
  Provider,
  assert,
  isDefined,
  paginatedEventQuery,
  Contract,
  floatToBN,
  toAddressType,
  getTokenInfo,
  mapAsync,
} from "./";
import axios, { RawAxiosRequestHeaders } from "axios";
import ERC20_ABI from "../common/abi/MinimalERC20.json";

// We need to instruct this bridge what tokens we expect to receive on L2, since the bridge
// API supports multiple destination tokens for a single L1 token.
export const BRIDGE_API_DESTINATION_TOKENS: { [l2ChainId: number]: string } = {
  [CHAIN_IDs.TEMPO]: TOKEN_SYMBOLS_MAP.pathUSD.addresses[CHAIN_IDs.TEMPO],
};

export const BRIDGE_API_DESTINATION_TOKEN_SYMBOLS: { [address: string]: string } = {
  [TOKEN_SYMBOLS_MAP.pathUSD.addresses[CHAIN_IDs.TEMPO]]: "path_usd",
  [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: "usdc",
};

const NETWORK_NAMES: { [chainId: number]: string } = {
  [CHAIN_IDs.MAINNET]: "ethereum",
  [CHAIN_IDs.TEMPO]: "tempo",
};

export const BRIDGE_API_MINIMUMS: { [sourceChainId: number]: { [dstChainId: number]: BigNumber } } = {
  [CHAIN_IDs.MAINNET]: {
    [CHAIN_IDs.TEMPO]: toBN(5_000_000), // 5 USD
  },
  [CHAIN_IDs.TEMPO]: {
    [CHAIN_IDs.MAINNET]: toBN(5_000_000), // 5 USD
  },
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
  amount: string;
  receipt:
    | {
        initial_amount: string;
        final_amount: string;
        source_tx_hash?: string;
      }
    | undefined;
};

export class BridgeApiClient {
  protected srcNetwork: string;
  protected dstNetwork: string;

  constructor(
    readonly bridgeApiBase: string,
    readonly bridgeApiKey: string,
    readonly customerId: string,
    srcNetworkId: number,
    dstNetworkId: number,
    readonly logger?: winston.Logger,
    readonly nRetries: number = 2
  ) {
    this.srcNetwork = NETWORK_NAMES[srcNetworkId];
    this.dstNetwork = NETWORK_NAMES[dstNetworkId];
  }

  async getAllTransfersInRange(toAddress: Address, fromTimestampMs: number): Promise<BridgeResponse[]> {
    const headers = this.defaultHeaders();
    const { data: pendingTransfers } = await this.getWithRetry<BridgeResponse>(
      `v0/transfers?updated_after_ms=${fromTimestampMs}`,
      headers
    );
    return pendingTransfers.filter(
      ({ destination, source_deposit_instructions }) =>
        destination.payment_rail === this.dstNetwork && source_deposit_instructions.payment_rail === this.srcNetwork
    );
  }

  async createTransferRouteEscrowAddress(
    toAddress: Address,
    _srcTokenSymbol: string,
    _dstTokenSymbol: string,
    normalizedAmount: string
  ): Promise<string> {
    const srcTokenSymbol = _srcTokenSymbol.toLowerCase();
    const dstTokenSymbol = _dstTokenSymbol.toLowerCase();
    const data = {
      on_behalf_of: `${this.customerId}`,
      source: {
        payment_rail: this.srcNetwork,
        currency: srcTokenSymbol,
        amount: normalizedAmount,
      },
      amount: normalizedAmount,
      destination: {
        payment_rail: this.dstNetwork,
        currency: dstTokenSymbol,
        to_address: toAddress.toNative(),
      },
      return_instructions: {
        address: toAddress.toNative(),
      },
      features: {
        allow_any_from_address: true,
      },
    };
    const idempotencyKey = String(Date.now());
    const headers = {
      ...this.defaultHeaders(),
      "Idempotency-Key": idempotencyKey,
    };
    const transferRequestData = await this.postWithRetry<BridgeResponse>("v0/transfers", data, headers);
    return transferRequestData.source_deposit_instructions.to_address;
  }

  async filterInitiatedTransfers(
    deposits: BridgeResponse[],
    fromAddress: Address,
    eventConfig: EventSearchConfig,
    originChainId: number,
    originProvider: Provider
  ): Promise<BridgeResponse[]> {
    // Get the origin token info.
    const originTokenInfo = (deposit: BridgeResponse) => {
      const originToken = Object.entries(BRIDGE_API_DESTINATION_TOKEN_SYMBOLS).find(
        ([, bridgeSymbol]) => bridgeSymbol === deposit.source_deposit_instructions.currency
      );
      assert(isDefined(originToken));
      const originTokenAddress = originToken[0];

      return getTokenInfo(toAddressType(originTokenAddress, originChainId), originChainId);
    };
    const cachedTransfers = {};
    // We need to get all relevant ERC20 transfers from the depositor to the deposit address before applying the filter so
    // that there is no race in the filtering process (i.e. while a paginated event query is fetching transfers, another, equivalent
    // paginated event query is run to overwrite the same piece of memory).
    await mapAsync(deposits, async (deposit) => {
      const { address: originTokenAddress } = originTokenInfo(deposit);
      const toAddress = deposit.source_deposit_instructions.to_address;
      const tokenContract = new Contract(originTokenAddress.toNative(), ERC20_ABI, originProvider);
      cachedTransfers[toAddress] ??= await paginatedEventQuery(
        tokenContract,
        tokenContract.filters.Transfer(fromAddress.toNative(), toAddress),
        eventConfig
      );
    });

    // We need to prioritize returning deposits with a status != `awaiting_funds`. This is because
    // `awaiting_funds` transfers may or may not have an associated ERC20 transfer event, but all other
    // statuses WILL have an associated transfer event.
    const sortedDeposits = deposits.sort((deposit) => {
      if (deposit.state === "awaiting_funds") {
        return 1;
      }
      // It does not matter what the ordering of all other states are. All that matters is `awaiting_funds`
      // state deposits are last.
      return -1;
    });
    return sortedDeposits.filter((deposit) => {
      const { decimals: originTokenDecimals } = originTokenInfo(deposit);
      const normalizedAmount = deposit.receipt?.final_amount ?? deposit.amount;
      const expectedAmount = floatToBN(normalizedAmount, originTokenDecimals);

      const toAddress = deposit.source_deposit_instructions.to_address;
      const cachedTransfer = cachedTransfers[toAddress];
      return cachedTransfer.some((event, idx) => {
        if (expectedAmount.eq(event.args.value)) {
          cachedTransfer.splice(idx, 1);
          return deposit.state !== "payment_processed";
        }
        return false;
      });
    });
  }

  defaultHeaders(): RawAxiosRequestHeaders {
    return {
      "Api-Key": `${this.bridgeApiKey}`,
      "Content-Type": "application/json",
    };
  }

  async getWithRetry<T>(endpoint: string, headers: RawAxiosRequestHeaders, nRetries = this.nRetries) {
    try {
      const response = await axios.get<T>(`${this.bridgeApiBase}/${endpoint}`, { headers });
      return response.data;
    } catch (e) {
      this.logger?.debug({
        at: "BridgeApi#_get",
        message: "Failed to query bridge API",
        endpoint,
        e,
      });
      if (nRetries > 0) {
        await delay(1);
        return this.getWithRetry<T>(endpoint, headers, --nRetries);
      }
      throw e;
    }
  }

  async postWithRetry<T>(
    endpoint: string,
    data: Record<string, unknown>,
    headers: RawAxiosRequestHeaders,
    nRetries = this.nRetries
  ) {
    try {
      const response = await axios.post<T>(`${this.bridgeApiBase}/${endpoint}`, data, { headers });
      return response.data;
    } catch (e) {
      this.logger?.debug({
        at: "BridgeApi#_post",
        message: "Failed to post to bridge API",
        endpoint,
        data,
        e,
      });
      if (nRetries > 0) {
        await delay(1);
        return this.postWithRetry<T>(endpoint, data, headers, --nRetries);
      }
      throw e;
    }
  }
}
