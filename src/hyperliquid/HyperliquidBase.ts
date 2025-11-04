import winston from "winston";
import { HyperliquidBotConfig } from "./HyperliquidBotConfig";
import { Contract, Signer, CHAIN_IDs, getTokenInfo, EvmAddress, BigNumber, getHlInfoClient, Provider } from "../utils";
import { MultiCallerClient, ConfigStoreClient } from "../clients";
import { CONTRACT_ADDRESSES } from "../common";
import { RedisCache } from "../caching/RedisCache";

export interface HyperliquidBaseClients {
  // We can further constrain the HubPoolClient type since we don't call any functions on it.
  hubPoolClient: { hubPool: Contract; chainId: number };
  configStoreClient: ConfigStoreClient;
  multiCallerClient: MultiCallerClient;
  dstProvider: Provider;
}

/**
 */
export class HyperliquidBase {
  protected redisCache: RedisCache;
  protected baseSigner: Signer;
  protected dstOftMessenger: Contract;
  protected dstCctpMessenger: Contract;
  protected infoClient;

  public initialized = false;
  protected chainId = CHAIN_IDs.HYPEREVM;

  public constructor(
    readonly logger: winston.Logger,
    readonly config: HyperliquidBotConfig,
    readonly clients: HyperliquidBaseClients
  ) {
    this.baseSigner = this.clients.hubPoolClient.hubPool.signer;

    // These must be defined.
    const { address: oftAddress, abi } = CONTRACT_ADDRESSES[this.chainId].dstOftMessenger;
    const { address: cctpAddress } = CONTRACT_ADDRESSES[this.chainId].dstCctpMessenger;
    this.dstOftMessenger = new Contract(oftAddress, abi, clients.dstProvider);
    this.dstCctpMessenger = new Contract(cctpAddress, abi, clients.dstProvider);
    this.infoClient = getHlInfoClient();
  }

  public async initialize(): Promise<void> {
    this.initialized = true;
  }

  protected async placeOrder(
    baseToken: EvmAddress,
    finalToken: EvmAddress,
    price: number,
    size: number,
    cloid: BigNumber
  ) {
    const l2TokenInfo = this._getTokenInfo(baseToken, this.chainId);
    const finalTokenInfo = this._getTokenInfo(finalToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;

    const mrkdwn = `baseToken: ${l2TokenInfo.symbol}\n finalToken: ${finalTokenInfo.symbol}\n price: ${price}\n size: ${size}\n cloid: ${cloid}`;
    this.clients.multiCallerClient.enqueueTransaction({
      contract: dstHandler,
      chainId: this.chainId,
      method: "submitLimitOrderFromBot",
      args: [finalToken.toNative(), price, size, cloid],
      message: "Submitted limit order to Hypercore.",
      mrkdwn,
      nonMulticall: true, // Cannot multicall this since it is a permissioned action.
    });
  }

  protected async sendSponsorshipFundsToSwapHandler(baseToken: EvmAddress, amount: BigNumber) {
    const l2TokenInfo = this._getTokenInfo(baseToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;

    const mrkdwn = `baseToken: ${l2TokenInfo.symbol}\n amount: ${amount}`;
    this.clients.multiCallerClient.enqueueTransaction({
      contract: dstHandler,
      chainId: this.chainId,
      method: "sendSponsorshipFundsToSwapHandler",
      args: [baseToken.toNative(), amount],
      message: "Sent sponsored funds to the swap handler.",
      mrkdwn,
      nonMulticall: true, // Cannot multicall this since it is a permissioned action.
    });
  }

  protected async cancelLimitOrderByCloid(baseToken: EvmAddress, finalToken: EvmAddress, cloid: BigNumber) {
    const l2TokenInfo = this._getTokenInfo(baseToken, this.chainId);
    const finalTokenInfo = this._getTokenInfo(finalToken, this.chainId);
    const dstHandler = l2TokenInfo.symbol === "USDC" ? this.dstCctpMessenger : this.dstOftMessenger;

    const mrkdwn = `baseToken: ${l2TokenInfo}\n finalToken: ${finalTokenInfo.symbol}\n cloid: ${cloid}`;
    this.clients.multiCallerClient.enqueueTransaction({
      contract: dstHandler,
      chainId: this.chainId,
      method: "cancelLimitOrderByCloid",
      args: [finalToken.toNative(), cloid],
      message: `Cancelled limit order ${cloid}.`,
      mrkdwn,
      nonMulticall: true, // Cannot multicall this since it is a permissioned action.
    });
  }

  protected _getTokenInfo(token: EvmAddress, chainId: number) {
    const tokenInfo = getTokenInfo(token, chainId);
    if (tokenInfo.symbol === "USDT") {
      tokenInfo.symbol = "USDT0";
    }
    return tokenInfo;
  }
}
