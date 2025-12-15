import {
  Signer,
  isSignerWallet,
  assert,
  delay,
  CHAIN_IDs,
  runTransaction,
  TOKEN_SYMBOLS_MAP,
  winston,
  bnZero,
} from "./";
import * as hl from "@nktkas/hyperliquid";
import { utils as sdkUtils } from "@across-protocol/sdk";
import { ethers } from "ethers";
import { CONTRACT_ADDRESSES } from "../common/ContractAddresses";

export function getHlExchangeClient(
  signer: Signer,
  transport: hl.HttpTransport | hl.WebSocketTransport = sdkUtils.getDefaultHlTransport()
) {
  assert(
    isSignerWallet(signer),
    "HyperliquidUtils#getHlExchangeClient: Cannot define an exchange client without a wallet."
  );
  return new hl.ExchangeClient({ wallet: signer, transport });
}

export async function getL2Book(
  infoClient: hl.InfoClient,
  params: hl.L2BookParameters,
  nRetries = 0,
  maxRetries = 3
): Promise<hl.L2BookResponse> {
  return await _callWithRetry(infoClient.l2Book.bind(infoClient), [params], nRetries, maxRetries);
}

export async function getSpotMeta(
  infoClient: hl.InfoClient,
  nRetries = 0,
  maxRetries = 3
): Promise<hl.SpotMetaResponse> {
  return await _callWithRetry(infoClient.spotMeta.bind(infoClient), [], nRetries, maxRetries);
}

export async function getSpotClearinghouseState(
  infoClient: hl.InfoClient,
  params: hl.SpotClearinghouseStateParameters,
  nRetries = 0,
  maxRetries = 3
): Promise<hl.SpotClearinghouseStateResponse> {
  return await _callWithRetry(infoClient.spotClearinghouseState.bind(infoClient), [params], nRetries, maxRetries);
}

export async function getUserNonFundingLedgerUpdates(
  infoClient: hl.InfoClient,
  params: hl.UserNonFundingLedgerUpdatesParameters,
  nRetries = 0,
  maxRetries = 3
): Promise<hl.UserNonFundingLedgerUpdatesResponse> {
  return await _callWithRetry(infoClient.userNonFundingLedgerUpdates.bind(infoClient), [params], nRetries, maxRetries);
}

export async function getOpenOrders(
  infoClient: hl.InfoClient,
  params: hl.OpenOrdersParameters,
  nRetries = 0,
  maxRetries = 3
): Promise<hl.OpenOrdersResponse> {
  return _callWithRetry(infoClient.openOrders.bind(infoClient), [params], nRetries, maxRetries);
}

export async function getHistoricalOrders(
  infoClient: hl.InfoClient,
  params: hl.HistoricalOrdersParameters,
  nRetries = 0,
  maxRetries = 3
): Promise<hl.HistoricalOrdersResponse> {
  return _callWithRetry(infoClient.historicalOrders.bind(infoClient), [params], nRetries, maxRetries);
}

export async function getOrderStatus(
  infoClient: hl.InfoClient,
  params: hl.OrderStatusParameters,
  nRetries = 0,
  maxRetries = 3
): Promise<hl.OrderStatusResponse> {
  return _callWithRetry(infoClient.orderStatus.bind(infoClient), [params], nRetries, maxRetries);
}

async function _callWithRetry<T, A extends any[]>(
  apiCall: (...args: A) => Promise<T>,
  args: A,
  nRetries: number,
  maxRetries: number
): Promise<T> {
  try {
    return await apiCall(...args);
  } catch (e) {
    if (nRetries > maxRetries) {
      throw new Error(`Max retries exceeded when querying the hyperliquid API: ${e}`);
    }
    const delaySeconds = 2 ** nRetries + Math.random();
    await delay(delaySeconds);
    // @todo Once we have a better idea on the types of errors we can suppress/retry on, then choose appropriate action based on the error thrown.
    return await _callWithRetry(apiCall, args, ++nRetries, maxRetries);
  }
}

export async function depositToHypercore(account: string, signer: Signer, logger: winston.Logger): Promise<string> {
  const contract = new ethers.Contract(
    CONTRACT_ADDRESSES[CHAIN_IDs.HYPEREVM].hyperliquidDepositHandler.address,
    CONTRACT_ADDRESSES[CHAIN_IDs.HYPEREVM].hyperliquidDepositHandler.abi,
    signer
  );
  const depositToHypercoreArgs = [TOKEN_SYMBOLS_MAP.USDH.addresses[CHAIN_IDs.HYPEREVM], bnZero, account];
  const depositToHypercoreTx = await runTransaction(logger, contract, "depositToHypercore", depositToHypercoreArgs);
  const receipt = await depositToHypercoreTx.wait();
  return receipt.transactionHash;
}
