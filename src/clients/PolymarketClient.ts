import { utils as ethersUtils } from "ethers";
import winston from "winston";
import type { Wallet } from "@ethersproject/wallet";
import type { JsonRpcSigner } from "@ethersproject/providers";
import { EvmAddress, Signer, isDefined } from "../utils";
import { PolymarketIntentV1 } from "../utils/PolymarketUtils";
// eslint-disable-next-line import/no-extraneous-dependencies
import type { ClobClient, TickSize, OrderType as OrderTypeType, Side as SideType } from "@polymarket/clob-client";
import type { SignatureType } from "@polymarket/order-utils";

type ClobModule = typeof import("@polymarket/clob-client");
let cachedClobModule: ClobModule | undefined;

const Side = {
  BUY: "BUY" as unknown as SideType,
  SELL: "SELL" as unknown as SideType,
} as const;

const OrderType = {
  FOK: "FOK" as unknown as OrderTypeType,
} as const;

async function loadClobModule(): Promise<ClobModule> {
  if (cachedClobModule) return cachedClobModule;
  const dynamicImport = new Function("modulePath", "return import(modulePath)") as (
    modulePath: string
  ) => Promise<ClobModule>;
  cachedClobModule = await dynamicImport("@polymarket/clob-client");
  return cachedClobModule;
}

export type PolymarketApiCreds = {
  key: string;
  secret: string;
  passphrase: string;
};

export type PolymarketClientConfig = {
  host: string;
  chainId: number;
  signatureType: SignatureType;
  funder: EvmAddress;
  apiCreds?: PolymarketApiCreds;
  defaultTickSize: TickSize;
  defaultNegRisk: boolean;
};

export type PolymarketOrderResult = {
  orderId: string;
  status: string;
};

export class PolymarketClient {
  private client?: ClobClient;
  private creds?: PolymarketApiCreds;

  constructor(
    private readonly logger: winston.Logger,
    private readonly signer: Signer,
    private readonly config: PolymarketClientConfig
  ) {}

  async init(): Promise<void> {
    if (this.client) return;

    const signer = this.signer as unknown as Wallet | JsonRpcSigner;
    const { ClobClient } = await loadClobModule();
    const baseClient = new ClobClient(this.config.host, this.config.chainId, signer);

    if (isDefined(this.config.apiCreds)) {
      this.creds = this.config.apiCreds;
    } else {
      this.creds = await baseClient.createOrDeriveApiKey();
    }

    this.client = new ClobClient(
      this.config.host,
      this.config.chainId,
      signer,
      this.creds,
      this.config.signatureType,
      this.config.funder.toNative()
    );

    this.logger.debug({
      at: "PolymarketClient#init",
      message: "Initialized Polymarket CLOB client",
      host: this.config.host,
      chainId: this.config.chainId,
      funder: this.config.funder.toNative(),
    });
  }

  async placeFokOrder(intent: PolymarketIntentV1): Promise<PolymarketOrderResult | undefined> {
    if (!this.client) {
      await this.init();
    }
    const client = this.client as ClobClient;

    const price = ethersUtils.formatUnits(intent.limitPrice, 6);
    const size = ethersUtils.formatUnits(intent.outcomeAmount, 6);

    const tickSize: TickSize =
      (await this.safeGetTickSize(intent.tokenId.toString())) ?? this.config.defaultTickSize;
    const negRisk = (await this.safeGetNegRisk(intent.tokenId.toString())) ?? this.config.defaultNegRisk;

    this.logger.debug({
      at: "PolymarketClient#placeFokOrder",
      message: "Submitting Polymarket FOK order",
      tokenId: intent.tokenId.toString(),
      price,
      size,
      tickSize,
      negRisk,
      clientOrderId: intent.clientOrderId,
    });

    const signed = await client.createOrder(
      {
        tokenID: intent.tokenId.toString(),
        price: Number(price),
        size: Number(size),
        side: Side.BUY,
      },
      {
        tickSize,
        negRisk,
      }
    );

    const order = await client.postOrder(signed, OrderType.FOK);

    if (!order?.success || order?.errorMsg) {
      this.logger.warn({
        at: "PolymarketClient#placeFokOrder",
        message: "Polymarket order rejected",
        response: order,
        clientOrderId: intent.clientOrderId,
      });
      return;
    }

    if (!order?.orderID) {
      this.logger.warn({
        at: "PolymarketClient#placeFokOrder",
        message: "Polymarket order missing orderID",
        response: order,
        clientOrderId: intent.clientOrderId,
      });
      return;
    }

    return {
      orderId: order.orderID,
      status: order.status ?? "unknown",
    };
  }

  private async safeGetTickSize(tokenId: string): Promise<TickSize | undefined> {
    try {
      return await (this.client as ClobClient).getTickSize(tokenId);
    } catch (err) {
      this.logger.warn({
        at: "PolymarketClient#safeGetTickSize",
        message: "Failed to fetch Polymarket tick size",
        tokenId,
        error: (err as Error).message,
      });
      return;
    }
  }

  private async safeGetNegRisk(tokenId: string): Promise<boolean | undefined> {
    try {
      return await (this.client as ClobClient).getNegRisk(tokenId);
    } catch (err) {
      this.logger.warn({
        at: "PolymarketClient#safeGetNegRisk",
        message: "Failed to fetch Polymarket negRisk flag",
        tokenId,
        error: (err as Error).message,
      });
      return;
    }
  }
}
