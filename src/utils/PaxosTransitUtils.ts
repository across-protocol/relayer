import type { TypedDataSigner } from "@ethersproject/abstract-signer";
import type { TypedDataDomain, TypedDataField } from "ethers";
import {
  CHAIN_IDs,
  assert,
  BigNumber,
  delay,
  fetchWithTimeout,
  FetchHeaders,
  isDefined,
  MAX_SAFE_ALLOWANCE,
  Signer,
  TOKEN_SYMBOLS_MAP,
  toBN,
  winston,
  Address,
} from "./";

export const PAXOS_TRANSIT_DESTINATION_TOKENS: { [dstChainId: number]: { [l1TokenAddress: string]: string } } = {
  [CHAIN_IDs.ROBINHOOD]: {
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: TOKEN_SYMBOLS_MAP.USDG.addresses[CHAIN_IDs.ROBINHOOD],
    [TOKEN_SYMBOLS_MAP.USDG.addresses[CHAIN_IDs.MAINNET]]: TOKEN_SYMBOLS_MAP.USDG.addresses[CHAIN_IDs.ROBINHOOD],
  },
};

export const PAXOS_TRANSIT_MINIMUMS: { [sourceChainId: number]: { [dstChainId: number]: BigNumber } } = {
  [CHAIN_IDs.MAINNET]: {
    [CHAIN_IDs.ROBINHOOD]: toBN(1_000_000), // 1 USD
  },
  [CHAIN_IDs.ROBINHOOD]: {
    [CHAIN_IDs.MAINNET]: toBN(1_000_000), // 1 USD
  },
};

export type PaxosTransitAuthorizationMethod = "permit" | "approval" | "already_approved";

export type PaxosTransitPermitData = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  value: Record<string, string>;
  deadline: string;
};

export type PaxosTransitAuthorizationResponse = {
  method: PaxosTransitAuthorizationMethod;
  permitData?: PaxosTransitPermitData;
  approvalTransaction?: { encoded: string };
};

export type PaxosTransitOrderDataResponse = {
  transaction: {
    to: string;
    data: string;
    value: string;
  };
};

export function getPaxosTransitStationAddress(chainId: number): string {
  const envKey = `PAXOS_TRANSIT_STATION_${chainId}`; // @TODO: Should this be per chain per token or just per chain?
  const address = process.env[envKey];
  assert(isDefined(address) && address.length > 0, `${envKey} must be set in the environment`);
  return address;
}

export function getPaxosTransitDestinationToken(dstChainId: number, l1Token: Address): string | undefined {
  return PAXOS_TRANSIT_DESTINATION_TOKENS[dstChainId]?.[l1Token.toNative()];
}

export class PaxosTransitClient {
  constructor(
    readonly baseUrl: string,
    readonly apiKey: string,
    readonly logger?: winston.Logger,
    readonly nRetries: number = 2
  ) {}

  async getAuthorization(params: {
    vaultAddress: string;
    tokenAddress: string;
    amount: BigNumber;
    userAddress: string;
    chainId: number;
  }): Promise<PaxosTransitAuthorizationResponse> {
    const query = new URLSearchParams({
      vaultAddress: params.vaultAddress,
      tokenAddress: params.tokenAddress,
      amount: params.amount.toString(),
      userAddress: params.userAddress,
      chainId: String(params.chainId),
    });
    return this.getWithRetry<PaxosTransitAuthorizationResponse>(`v2/core/authorization?${query.toString()}`);
  }

  async getOrderData(params: {
    userAddress: string;
    offerAmount: BigNumber;
    offerAsset: string;
    wantAsset: string;
    sourceChainId: number;
    destinationChainId: number;
    permitSignature?: string;
    permitDeadline?: string;
  }): Promise<PaxosTransitOrderDataResponse> {
    const query = new URLSearchParams({
      userAddress: params.userAddress,
      offerAmount: params.offerAmount.toString(),
      offerAsset: params.offerAsset,
      wantAsset: params.wantAsset,
      sourceChainId: String(params.sourceChainId),
      destinationChainId: String(params.destinationChainId),
    });
    if (isDefined(params.permitSignature)) {
      query.set("permitSignature", params.permitSignature);
    }
    if (isDefined(params.permitDeadline)) {
      query.set("permitDeadline", params.permitDeadline);
    }
    return this.getWithRetry<PaxosTransitOrderDataResponse>(`v1/transit/orders/data?${query.toString()}`);
  }

  defaultHeaders(): FetchHeaders {
    return {
      "x-api-key": this.apiKey,
    };
  }

  async getWithRetry<T>(endpoint: string, nRetries = this.nRetries): Promise<T> {
    try {
      return await fetchWithTimeout<T>(`${this.baseUrl}/${endpoint}`, {}, this.defaultHeaders());
    } catch (e) {
      this.logger?.debug({
        at: "PaxosTransitClient#getWithRetry",
        message: "Failed to query Paxos Transit API",
        endpoint,
        e,
      });
      if (nRetries > 0) {
        await delay(1);
        return this.getWithRetry<T>(endpoint, --nRetries);
      }
      throw e;
    }
  }
}

export function createPaxosTransitClient(logger?: winston.Logger): PaxosTransitClient {
  const { PAXOS_API_BASE = "https://api.paxoslabs.com", PAXOS_API_KEY } = process.env;
  assert(isDefined(PAXOS_API_KEY), "PAXOS_API_KEY must be set in the environment");
  return new PaxosTransitClient(PAXOS_API_BASE, PAXOS_API_KEY, logger);
}

function isTypedDataSigner(signer: Signer): signer is Signer & TypedDataSigner {
  return typeof (signer as unknown as TypedDataSigner)._signTypedData === "function";
}

export async function resolvePaxosTransitAuthorization(
  client: PaxosTransitClient,
  signer: Signer,
  params: {
    vaultAddress: string;
    tokenAddress: string;
    userAddress: string;
    chainId: number;
  }
): Promise<{ permitSignature?: string; permitDeadline?: string }> {
  const auth = await client.getAuthorization({
    ...params,
    amount: toBN(MAX_SAFE_ALLOWANCE), // @TODO: Should we use MAX_SAFE_ALLOWANCE or amount we want to transfer?
  });

  if (auth.method === "already_approved") {
    return {};
  }

  if (auth.method === "permit") {
    assert(isDefined(auth.permitData), "Paxos Transit authorization missing permitData");
    const { domain, types, value, deadline } = auth.permitData;
    assert(isTypedDataSigner(signer), "Signer must support EIP-712 signing for Paxos Transit permit flow");
    const permitSignature = await signer._signTypedData(
      domain as TypedDataDomain,
      types as Record<string, TypedDataField[]>,
      value
    );
    return { permitSignature, permitDeadline: deadline };
  }

  if (auth.method === "approval") {
    assert(isDefined(auth.approvalTransaction), "Paxos Transit authorization missing approvalTransaction");
    const provider = signer.provider;
    assert(isDefined(provider), "Signer must have a provider to submit Paxos Transit approval transaction");
    const tx = await signer.sendTransaction({
      to: params.tokenAddress,
      data: auth.approvalTransaction.encoded,
    });
    await provider.waitForTransaction(tx.hash);
    return {};
  }

  throw new Error(`Unsupported Paxos Transit authorization method: ${auth.method}`);
}

export async function buildPaxosTransitSubmitOrderTxn(
  client: PaxosTransitClient,
  signer: Signer,
  params: {
    userAddress: string;
    offerAmount: BigNumber;
    offerAsset: string;
    wantAsset: string;
    sourceChainId: number;
    destinationChainId: number;
    vaultAddress: string;
  }
): Promise<PaxosTransitOrderDataResponse> {
  const authorization = await resolvePaxosTransitAuthorization(client, signer, {
    vaultAddress: params.vaultAddress,
    tokenAddress: params.offerAsset,
    userAddress: params.userAddress,
    chainId: params.sourceChainId,
  });
  return client.getOrderData({
    userAddress: params.userAddress,
    offerAmount: params.offerAmount,
    offerAsset: params.offerAsset,
    wantAsset: params.wantAsset,
    sourceChainId: params.sourceChainId,
    destinationChainId: params.destinationChainId,
    permitSignature: authorization.permitSignature,
    permitDeadline: authorization.permitDeadline,
  });
}
