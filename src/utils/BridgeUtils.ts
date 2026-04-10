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
  fetchWithTimeout,
  postWithTimeout,
  FetchHeaders,
  mapAsync,
} from "./";
import { Log } from "../interfaces";
import ERC20_ABI from "../common/abi/MinimalERC20.json";

// We need to instruct this bridge what tokens we expect to receive on L2, since the bridge
// API supports multiple destination tokens for a single L1 token.
export const BRIDGE_API_DESTINATION_TOKENS: { [l2ChainId: number]: string } = {
  [CHAIN_IDs.TEMPO]: TOKEN_SYMBOLS_MAP.pathUSD.addresses[CHAIN_IDs.TEMPO],
  [CHAIN_IDs.TRON]: TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.TRON],
};

export const BRIDGE_API_DESTINATION_TOKEN_SYMBOLS: { [address: string]: string } = {
  [TOKEN_SYMBOLS_MAP.pathUSD.addresses[CHAIN_IDs.TEMPO]]: "path_usd",
  [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: "usdc",
  [TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.TRON]]: "usdt",
};

const NETWORK_NAMES: { [chainId: number]: string } = {
  [CHAIN_IDs.MAINNET]: "ethereum",
  [CHAIN_IDs.TEMPO]: "tempo",
  [CHAIN_IDs.TRON]: "tron",
};

export const BRIDGE_API_MINIMUMS: { [sourceChainId: number]: { [dstChainId: number]: BigNumber } } = {
  [CHAIN_IDs.MAINNET]: {
    [CHAIN_IDs.TEMPO]: toBN(5_000_000), // 5 USD
    [CHAIN_IDs.TRON]: toBN(5_000_000), // 5 USD
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
    readonly srcNetworkId: number,
    readonly dstNetworkId: number,
    readonly logger?: winston.Logger,
    readonly nRetries: number = 2
  ) {
    this.srcNetwork = NETWORK_NAMES[srcNetworkId];
    this.dstNetwork = NETWORK_NAMES[dstNetworkId];
  }

  async getAllTransfersInRange(toAddress: Address, fromTimestampMs: number): Promise<BridgeResponse[]> {
    const headers = this.defaultHeaders();
    const { data: pendingTransfers } = await this.getWithRetry<{ data: BridgeResponse[] }>(
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
    originProvider: Provider
  ): Promise<BridgeResponse[]> {
    const getOriginTokenInfo = (deposit: BridgeResponse) => {
      const originToken = Object.entries(BRIDGE_API_DESTINATION_TOKEN_SYMBOLS).find(
        ([, bridgeSymbol]) => bridgeSymbol === deposit.source_deposit_instructions.currency
      );
      assert(isDefined(originToken));
      return getTokenInfo(toAddressType(originToken[0], this.srcNetworkId), this.srcNetworkId);
    };

    // Deduplicate queries by toAddress to avoid redundant event fetches.
    const seen = new Set<string>();
    const uniqueDeposits = deposits.filter((deposit) => {
      const { to_address: toAddress, currency: originToken } = deposit.source_deposit_instructions;
      const seenKey = `${toAddress}:${originToken}`;
      if (seen.has(seenKey)) {
        return false;
      }
      seen.add(seenKey);
      return true;
    });
    // Map containing all origin chain transfers for a specific deposit address/token address combo.
    const cachedTransfers: Record<string, Record<string, Log[]>> = {};
    await mapAsync(uniqueDeposits, async (deposit) => {
      const { address: originTokenAddress } = getOriginTokenInfo(deposit);
      const toAddress = deposit.source_deposit_instructions.to_address;
      const tokenContract = new Contract(originTokenAddress.toNative(), ERC20_ABI, originProvider);
      cachedTransfers[toAddress] ??= {};
      cachedTransfers[toAddress][originTokenAddress.toNative()] = await paginatedEventQuery(
        tokenContract,
        tokenContract.filters.Transfer(fromAddress.toNative(), toAddress),
        eventConfig
      );
    });

    // Sort so that confirmed deposits (state != "awaiting_funds") match events first,
    // since they are guaranteed to have a corresponding transfer event.
    const sortedDeposits = [...deposits].sort((a, b) => {
      const aWaiting = a.state === "awaiting_funds" ? 1 : 0;
      const bWaiting = b.state === "awaiting_funds" ? 1 : 0;
      return aWaiting - bWaiting;
    });

    return sortedDeposits.filter((deposit) => {
      const { decimals: originTokenDecimals, address: originTokenAddress } = getOriginTokenInfo(deposit);
      const expectedAmount = floatToBN(deposit.receipt?.final_amount ?? deposit.amount, originTokenDecimals);
      const toAddress = deposit.source_deposit_instructions.to_address;
      const events = cachedTransfers[toAddress][originTokenAddress.toNative()];
      const matchIdx = events.findIndex((log) => expectedAmount.eq(log.args.value));
      if (matchIdx === -1) {
        return false;
      }
      // Remove matched event so it can't be double-matched to another deposit.
      events.splice(matchIdx, 1);
      // Completed transfers must still consume their event above, but should be
      // excluded from the outstanding result set.
      return deposit.state !== "payment_processed";
    });
  }

  defaultHeaders(): FetchHeaders {
    return {
      "Api-Key": `${this.bridgeApiKey}`,
      "Content-Type": "application/json",
    };
  }

  async getWithRetry<T>(endpoint: string, headers: FetchHeaders, nRetries = this.nRetries): Promise<T> {
    try {
      return await fetchWithTimeout<T>(`${this.bridgeApiBase}/${endpoint}`, {}, headers);
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
    headers: FetchHeaders,
    nRetries = this.nRetries
  ): Promise<T> {
    try {
      return await postWithTimeout<T>(`${this.bridgeApiBase}/${endpoint}`, data, {}, headers);
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
