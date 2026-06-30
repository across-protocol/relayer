import type { TypedDataSigner } from "@ethersproject/abstract-signer";
import type { TypedDataDomain, TypedDataField } from "ethers";
import { getContractAddress } from "../common/ContractAddresses";
import {
  CHAIN_IDs,
  assert,
  BigNumber,
  bnZero,
  ConvertDecimals,
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

export function getMainnetUsdgAddress(): string {
  const address = TOKEN_SYMBOLS_MAP["USDG-MAINNET"].addresses[CHAIN_IDs.MAINNET];
  assert(isDefined(address), "USDG-MAINNET is not configured on mainnet");
  return address;
}

export const PAXOS_TRANSIT_DESTINATION_TOKENS: { [dstChainId: number]: { [l1TokenAddress: string]: string } } = {
  [CHAIN_IDs.ROBINHOOD]: {
    [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: TOKEN_SYMBOLS_MAP.USDG.addresses[CHAIN_IDs.ROBINHOOD],
    [TOKEN_SYMBOLS_MAP["USDG-MAINNET"].addresses[CHAIN_IDs.MAINNET]]: TOKEN_SYMBOLS_MAP.USDG.addresses[CHAIN_IDs.ROBINHOOD],
  },
};

// Paxos enforces a $5 minimum per order (5 * 10^decimals for 6-decimal stables).
export const PAXOS_TRANSIT_MINIMUMS: { [sourceChainId: number]: { [dstChainId: number]: BigNumber } } = {
  [CHAIN_IDs.MAINNET]: {
    [CHAIN_IDs.ROBINHOOD]: toBN(5_000_000), // $5
  },
  [CHAIN_IDs.ROBINHOOD]: {
    [CHAIN_IDs.MAINNET]: toBN(5_000_000), // $5
  },
};

export type PaxosTransitAuthorizationMethodType = "eip2612_permit" | "erc20_approve";

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

export type PaxosTransitAuthorizationMethod = {
  type: PaxosTransitAuthorizationMethodType;
  description?: string;
  permitData?: PaxosTransitPermitData;
  transaction?: { encoded: string };
};

export type PaxosTransitAuthorizationResponse = {
  spenderAddress: string;
  alreadyApproved: boolean;
  methods: PaxosTransitAuthorizationMethod[];
};

export type PaxosTransitOrderQuoteResponse = {
  transaction: {
    to: string;
    data: string;
    value: string;
  };
  amountOut?: string;
  protocolFee?: string;
  integratorFee?: string;
  totalFees?: string;
  estimatedLatencyMs?: number;
};

/** @deprecated Use PaxosTransitOrderQuoteResponse */
export type PaxosTransitOrderDataResponse = PaxosTransitOrderQuoteResponse;

export type PaxosTransitOrderStatus = "PENDING_BRIDGE" | "PROCESSING" | "PROCESSED" | "REMOVED";

export const PAXOS_TRANSIT_OUTSTANDING_ORDER_STATUSES: ReadonlySet<PaxosTransitOrderStatus> = new Set([
  "PENDING_BRIDGE",
  "PROCESSING",
]);

export const PAXOS_TRANSIT_OUTSTANDING_ORDERS_FILTER = "status=PROCESSING OR status=PENDING_BRIDGE";

export type PaxosTransitOrder = {
  id: string;
  offerAsset: string;
  wantAsset: string;
  offerAmount: string;
  amountDue: string;
  remainingAmountDue?: string;
  receiver: string;
  sourceChainId: number;
  destinationChainId: number;
  status: PaxosTransitOrderStatus;
  orderExecuteds?: unknown[];
};

export function getPaxosTransitOrderOutstandingWantAmount(order: PaxosTransitOrder): BigNumber {
  const remainingAmountDue = order.remainingAmountDue;
  if (isDefined(remainingAmountDue)) {
    return BigNumber.from(remainingAmountDue);
  }
  return BigNumber.from(order.amountDue);
}

export function isPaxosTransitOrderOutstanding(order: PaxosTransitOrder): boolean {
  if (order.status === "REMOVED") {
    return false;
  }
  const outstandingWantAmount = getPaxosTransitOrderOutstandingWantAmount(order);
  if (outstandingWantAmount.lte(bnZero)) {
    return false;
  }
  return PAXOS_TRANSIT_OUTSTANDING_ORDER_STATUSES.has(order.status);
}

export function getPaxosTransitOfferAssetsForWantAsset(dstChainId: number, wantAsset: string): string[] {
  const destinations = PAXOS_TRANSIT_DESTINATION_TOKENS[dstChainId];
  if (!isDefined(destinations)) {
    return [];
  }
  return Object.entries(destinations)
    .filter(([, destinationWantAsset]) => destinationWantAsset.toLowerCase() === wantAsset.toLowerCase())
    .map(([offerAsset]) => offerAsset);
}

export function paxosTransitOrderMatchesRoute(
  order: PaxosTransitOrder,
  params: {
    wantAsset: string;
    sourceChainId: number;
    destinationChainId: number;
    receiver: string;
  }
): boolean {
  return (
    order.wantAsset.toLowerCase() === params.wantAsset.toLowerCase() &&
    order.sourceChainId === params.sourceChainId &&
    order.destinationChainId === params.destinationChainId &&
    order.receiver.toLowerCase() === params.receiver.toLowerCase()
  );
}

export async function listPaxosTransitOrders(
  client: PaxosTransitClient,
  userAddress: string,
  filter?: string
): Promise<PaxosTransitOrder[]> {
  const orders: PaxosTransitOrder[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.listOrders({
      userAddress,
      filter,
      pageSize: 100,
      pageToken,
    });
    orders.push(...response.orders);
    pageToken = isDefined(response.nextPageToken) ? response.nextPageToken : undefined;
  } while (isDefined(pageToken));
  return orders;
}

/** @deprecated Use listPaxosTransitOrders or listOutstandingPaxosTransitOrders */
export async function listAllPaxosTransitOrders(
  client: PaxosTransitClient,
  userAddress: string
): Promise<PaxosTransitOrder[]> {
  return listPaxosTransitOrders(client, userAddress);
}

/**
 * Fetch only in-flight Paxos orders. Finalized PROCESSED history is excluded at the API layer
 * via status filters (AIP-160), then route-scoped client-side in the bridge adapter.
 */
export async function listOutstandingPaxosTransitOrders(
  client: PaxosTransitClient,
  userAddress: string
): Promise<PaxosTransitOrder[]> {
  return listPaxosTransitOrders(client, userAddress, PAXOS_TRANSIT_OUTSTANDING_ORDERS_FILTER);
}

export function getPaxosTransitOutstandingOrderAmountInL1Decimals(
  order: PaxosTransitOrder,
  wantAssetDecimals: number,
  offerAssetDecimals: number
): BigNumber {
  return ConvertDecimals(wantAssetDecimals, offerAssetDecimals)(getPaxosTransitOrderOutstandingWantAmount(order));
}

export function getPaxosTransitStationAddress(chainId: number): string {
  const envKey = `PAXOS_TRANSIT_STATION_${chainId}`;
  const envAddress = process.env[envKey];
  if (isDefined(envAddress) && envAddress.length > 0) {
    return envAddress;
  }
  return getContractAddress(chainId, "paxosTransitStation");
}

export function getPaxosTransitBoringVaultAddress(chainId: number): string {
  const envKey = `PAXOS_TRANSIT_BORING_VAULT_${chainId}`;
  const envAddress = process.env[envKey];
  if (isDefined(envAddress) && envAddress.length > 0) {
    return envAddress;
  }
  return getContractAddress(chainId, "paxosTransitBoringVault");
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
    spenderAddress: string;
    tokenAddress: string;
    amount: BigNumber;
    userAddress: string;
    chainId: number;
  }): Promise<PaxosTransitAuthorizationResponse> {
    const query = new URLSearchParams({
      spenderAddress: params.spenderAddress,
      tokenAddress: params.tokenAddress,
      amount: params.amount.toString(),
      userAddress: params.userAddress,
      chainId: String(params.chainId),
    });
    return this.getWithRetry<PaxosTransitAuthorizationResponse>(`v3/core/authorization?${query.toString()}`);
  }

  async getOrderQuote(params: {
    userAddress: string;
    offerAmount: BigNumber;
    offerAsset: string;
    wantAsset: string;
    sourceChainId: number;
    destinationChainId: number;
    permitSignature?: string;
    permitDeadline?: string;
    integratorFee?: string;
    integratorFeeReceiver?: string;
    responseFormat?: "default" | "full" | "structured";
  }): Promise<PaxosTransitOrderQuoteResponse> {
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
    if (isDefined(params.integratorFee)) {
      query.set("integratorFee", params.integratorFee);
    }
    if (isDefined(params.integratorFeeReceiver)) {
      query.set("integratorFeeReceiver", params.integratorFeeReceiver);
    }
    if (isDefined(params.responseFormat)) {
      query.set("responseFormat", params.responseFormat);
    }
    return this.getWithRetry<PaxosTransitOrderQuoteResponse>(`v1/transit/orders/quote?${query.toString()}`);
  }

  /** @deprecated Use getOrderQuote */
  async getOrderData(
    params: Parameters<PaxosTransitClient["getOrderQuote"]>[0]
  ): Promise<PaxosTransitOrderQuoteResponse> {
    return this.getOrderQuote(params);
  }

  async getOrderStatus(orderId: string): Promise<{ order: PaxosTransitOrder }> {
    return this.getWithRetry<{ order: PaxosTransitOrder }>(`v1/transit/orders/${orderId}`);
  }

  async listOrders(params: {
    userAddress: string;
    filter?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<{ orders: PaxosTransitOrder[]; nextPageToken: string | null }> {
    const query = new URLSearchParams({
      userAddress: params.userAddress,
    });
    if (isDefined(params.filter)) {
      query.set("filter", params.filter);
    }
    if (isDefined(params.pageSize)) {
      query.set("pageSize", String(params.pageSize));
    }
    if (isDefined(params.pageToken)) {
      query.set("pageToken", params.pageToken);
    }
    return this.getWithRetry<{ orders: PaxosTransitOrder[]; nextPageToken: string | null }>(
      `v1/transit/orders?${query.toString()}`
    );
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

function permitTypesForSigning(
  types: Record<string, Array<{ name: string; type: string }>>
): Record<string, TypedDataField[]> {
  const { EIP712Domain: _domainType, ...signTypes } = types;
  return signTypes as Record<string, TypedDataField[]>;
}

async function submitPaxosTransitApproval(
  signer: Signer,
  tokenAddress: string,
  approvalCalldata: string
): Promise<void> {
  const provider = signer.provider;
  assert(isDefined(provider), "Signer must have a provider to submit Paxos Transit approval transaction");
  const tx = await signer.sendTransaction({
    to: tokenAddress,
    data: approvalCalldata,
  });
  await provider.waitForTransaction(tx.hash);
}

export async function resolvePaxosTransitAuthorization(
  client: PaxosTransitClient,
  signer: Signer,
  params: {
    spenderAddress: string;
    tokenAddress: string;
    userAddress: string;
    chainId: number;
    amount: BigNumber;
  }
): Promise<{ permitSignature?: string; permitDeadline?: string }> {
  const probeAuth = await client.getAuthorization(params);

  if (probeAuth.alreadyApproved) {
    return {};
  }

  const auth = await client.getAuthorization({
    ...params,
    amount: toBN(MAX_SAFE_ALLOWANCE),
  });

  if (auth.alreadyApproved || auth.methods.length === 0) {
    return {};
  }

  const approve = auth.methods.find((method) => method.type === "erc20_approve");
  if (isDefined(approve?.transaction?.encoded)) {
    await submitPaxosTransitApproval(signer, params.tokenAddress, approve.transaction.encoded);
    return {};
  }

  const permit = auth.methods.find((method) => method.type === "eip2612_permit");
  if (isDefined(permit?.permitData)) {
    const { domain, types, value, deadline } = permit.permitData;
    assert(isTypedDataSigner(signer), "Signer must support EIP-712 signing for Paxos Transit permit flow");
    const permitSignature = await signer._signTypedData(domain as TypedDataDomain, permitTypesForSigning(types), value);
    return { permitSignature, permitDeadline: deadline };
  }

  throw new Error("No supported Paxos Transit authorization method available");
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
    spenderAddress: string;
  }
): Promise<PaxosTransitOrderQuoteResponse> {
  const authorization = await resolvePaxosTransitAuthorization(client, signer, {
    spenderAddress: params.spenderAddress,
    tokenAddress: params.offerAsset,
    userAddress: params.userAddress,
    chainId: params.sourceChainId,
    amount: params.offerAmount,
  });
  return client.getOrderQuote({
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
