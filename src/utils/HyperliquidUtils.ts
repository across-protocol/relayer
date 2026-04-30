import {
  Signer,
  isSignerWallet,
  assert,
  delay,
  CHAIN_IDs,
  submitTransaction,
  TOKEN_SYMBOLS_MAP,
  winston,
  bnZero,
  blockExplorerLink,
  retry,
} from "./";
import * as hl from "@nktkas/hyperliquid";
import { utils as sdkUtils } from "@across-protocol/sdk";
import { ethers } from "ethers";
import { CONTRACT_ADDRESSES } from "../common/ContractAddresses";
import { TransactionClient } from "../clients";

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
  maxRetries = 3,
  delayS = 2
): Promise<NonNullable<hl.L2BookResponse>> {
  const fn = () => infoClient.l2Book.bind(infoClient)(params);
  const l2Book = await retry(fn, maxRetries, delayS);
  assert(l2Book !== null, `L2 order book missing for ${params.coin}`);
  return l2Book;
}

export async function getSpotMeta(infoClient: hl.InfoClient, maxRetries = 3, delayS = 2): Promise<hl.SpotMetaResponse> {
  return await retry(infoClient.spotMeta.bind(infoClient), maxRetries, delayS);
}

export async function getSpotClearinghouseState(
  infoClient: hl.InfoClient,
  params: hl.SpotClearinghouseStateParameters,
  maxRetries = 3,
  delayS = 2
): Promise<hl.SpotClearinghouseStateResponse> {
  const fn = () => infoClient.spotClearinghouseState.bind(infoClient)(params);
  return await retry(fn, maxRetries, delayS);
}

export async function getUserNonFundingLedgerUpdates(
  infoClient: hl.InfoClient,
  params: hl.UserNonFundingLedgerUpdatesParameters,
  maxRetries = 3,
  delayS = 2
): Promise<hl.UserNonFundingLedgerUpdatesResponse> {
  const fn = () => infoClient.userNonFundingLedgerUpdates.bind(infoClient)(params);
  return await retry(fn, maxRetries, delayS);
}

export async function getOpenOrders(
  infoClient: hl.InfoClient,
  params: hl.OpenOrdersParameters,
  maxRetries = 3,
  delayS = 2
): Promise<hl.OpenOrdersResponse> {
  const fn = () => infoClient.openOrders.bind(infoClient)(params);
  return retry(fn, maxRetries, delayS);
}

export async function getUserFees(
  infoClient: hl.InfoClient,
  params: hl.UserFeesParameters,
  maxRetries = 3,
  delayS = 2
): Promise<hl.UserFeesResponse> {
  const fn = () => infoClient.userFees.bind(infoClient)(params);
  return retry(fn, maxRetries, delayS);
}

export async function getHistoricalOrders(
  infoClient: hl.InfoClient,
  params: hl.HistoricalOrdersParameters,
  maxRetries = 3,
  delayS = 2
): Promise<hl.HistoricalOrdersResponse> {
  const fn = () => infoClient.historicalOrders.bind(infoClient)(params);
  return retry(fn, maxRetries, delayS);
}

export async function getUserFillsByTime(
  infoClient: hl.InfoClient,
  params: hl.UserFillsByTimeParameters,
  maxRetries = 3,
  delayS = 2
): Promise<hl.UserFillsByTimeResponse> {
  const fn = () => infoClient.userFillsByTime.bind(infoClient)(params);
  return retry(fn, maxRetries, delayS);
}

export async function getOrderStatus(
  infoClient: hl.InfoClient,
  params: hl.OrderStatusParameters,
  maxRetries = 3,
  delayS = 2
): Promise<hl.OrderStatusResponse> {
  const fn = () => infoClient.orderStatus.bind(infoClient)(params);
  return retry(fn, maxRetries, delayS);
}

export async function depositToHypercore(account: string, signer: Signer, logger: winston.Logger): Promise<string> {
  const transactionClient = new TransactionClient(logger);
  const chainId = CHAIN_IDs.HYPEREVM;
  const contract = new ethers.Contract(
    CONTRACT_ADDRESSES[chainId].hyperliquidDepositHandler.address,
    CONTRACT_ADDRESSES[chainId].hyperliquidDepositHandler.abi,
    signer
  );
  const depositToHypercoreArgs = [TOKEN_SYMBOLS_MAP.USDH.addresses[chainId], bnZero, account];
  const depositToHypercoreTx = await submitTransaction(
    {
      contract: contract,
      method: "depositToHypercore",
      args: depositToHypercoreArgs,
      chainId: chainId,
    },
    transactionClient
  );
  await delay(1);
  const receipt = await depositToHypercoreTx.wait();
  logger.info({
    at: "HyperliquidUtils#depositToHypercore",
    message: `HyperCore account ${account} created 🫡!`,
    transactionHash: blockExplorerLink(receipt.transactionHash, chainId),
  });
  return receipt.transactionHash;
}
