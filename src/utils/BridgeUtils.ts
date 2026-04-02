import { CHAIN_IDs, Address, delay, TOKEN_SYMBOLS_MAP, toBN, winston, BigNumber, fetchWithTimeout, postWithTimeout } from "./";
import type { FetchHeaders } from "./";

// We need to instruct this bridge what tokens we expect to receive on L2, since the bridge
// API supports multiple destination tokens for a single L1 token.
export const BRIDGE_API_DESTINATION_TOKENS: { [l2ChainId: number]: string } = {
  [CHAIN_IDs.TEMPO]: TOKEN_SYMBOLS_MAP.pathUSD.addresses[CHAIN_IDs.TEMPO],
};

export const BRIDGE_API_DESTINATION_TOKEN_SYMBOLS: { [address: string]: string } = {
  [TOKEN_SYMBOLS_MAP.pathUSD.addresses[CHAIN_IDs.TEMPO]]: "path_usd",
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
  receipt:
    | {
        initial_amount: string;
        final_amount: string;
        source_tx_hash: string;
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
    readonly logger: winston.Logger,
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
    _l1TokenSymbol: string,
    _l2TokenSymbol: string
  ): Promise<string> {
    const l1TokenSymbol = _l1TokenSymbol.toLowerCase();
    const l2TokenSymbol = _l2TokenSymbol.toLowerCase();
    const data = {
      on_behalf_of: `${this.customerId}`,
      source: {
        payment_rail: this.srcNetwork,
        currency: l1TokenSymbol,
      },
      destination: {
        payment_rail: this.dstNetwork,
        currency: l2TokenSymbol,
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
      ...this.defaultHeaders(),
      "Idempotency-Key": idempotencyKey,
    };
    const transferRequestData = await this.postWithRetry<BridgeResponse>("v0/transfers", data, headers);
    return transferRequestData.source_deposit_instructions.to_address;
  }

  defaultHeaders(): FetchHeaders {
    return {
      "Api-Key": `${this.bridgeApiKey}`,
      "Content-Type": "application/json",
    };
  }

  async getWithRetry<T>(endpoint: string, headers: FetchHeaders, nRetries = this.nRetries) {
    try {
      return await fetchWithTimeout<T>(`${this.bridgeApiBase}/${endpoint}`, {}, headers);
    } catch (e) {
      this.logger.debug({
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
  ) {
    try {
      return await postWithTimeout<T>(`${this.bridgeApiBase}/${endpoint}`, data, {}, headers);
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
        return this.postWithRetry<T>(endpoint, data, headers, --nRetries);
      }
      throw e;
    }
  }
}
