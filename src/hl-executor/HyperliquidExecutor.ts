import winston from "winston";
import { HyperliquidExecutorConfig } from "./HyperliquidExecutorConfig";
import {
  Contract,
  getRedisCache,
  Signer,
  Provider,
  isDefined,
  CHAIN_IDs,
  getTokenInfo,
  EvmAddress,
  BigNumber,
} from "../utils";
import { MultiCallerClient } from "../clients";
import { CONTRACT_ADDRESSES } from "../common";
import { RedisCache } from "../caching/RedisCache";

export interface HyperliquidExecutorClients {
  // We can further constrain the HubPoolClient type since we don't call any functions on it.
  hubPoolClient: { hubPool: Contract; chainId: number };
  multiCallerClient: MultiCallerClient;
  l2ProvidersByChain: { [chainId: number]: Provider };
}

/**
 */
export class HyperliquidExecutor {
  private redisCache: RedisCache;
  private baseSigner: Signer;
  private srcOftMessengers: { [chainId: number]: Contract };
  private srcCctpMessengers: { [chainId: number]: Contract };
  private dstOftMessenger: Contract;
  private dstCctpMessenger: Contract;

  public initialized = false;
  private chainId = CHAIN_IDs.HYPEREVM;

  public constructor(
    readonly logger: winston.Logger,
    readonly config: HyperliquidExecutorConfig,
    readonly clients: HyperliquidExecutorClients
  ) {
    this.baseSigner = this.clients.hubPoolClient.hubPool.signer;

    const { l2ProvidersByChain } = clients;
    this.srcOftMessengers = Object.fromEntries(
      Object.entries(l2ProvidersByChain)
        .map(([chainId, provider]) => {
          const srcOftMessenger = CONTRACT_ADDRESSES[chainId]?.srcOftMessenger;
          if (isDefined(srcOftMessenger?.address)) {
            return [chainId, new Contract(srcOftMessenger.address, srcOftMessenger.abi, provider)];
          }
          return undefined;
        })
        .filter(isDefined)
    );
    this.srcCctpMessengers = Object.fromEntries(
      Object.entries(l2ProvidersByChain)
        .map(([chainId, provider]) => {
          const srcCctpMessenger = CONTRACT_ADDRESSES[chainId]?.srcCctpMessenger;
          if (isDefined(srcCctpMessenger?.address)) {
            return [chainId, new Contract(srcCctpMessenger.address, srcCctpMessenger.abi, provider)];
          }
          return undefined;
        })
        .filter(isDefined)
    );
    const { address: oftAddress, abi } = CONTRACT_ADDRESSES[this.chainId].dstOftMessenger;
    const { address: cctpAddress } = CONTRACT_ADDRESSES[this.chainId].dstCctpMessenger;
    this.dstOftMessenger = new Contract(oftAddress, abi, l2ProvidersByChain[this.chainId]);
    this.dstCctpMessenger = new Contract(cctpAddress, abi, l2ProvidersByChain[this.chainId]);
  }

  public async initialize(): Promise<void> {
    this.redisCache = (await getRedisCache(this.logger)) as RedisCache;
    this.initialized = true;
  }

  private async placeOrder(
    baseToken: EvmAddress,
    finalToken: EvmAddress,
    price: number,
    size: number,
    cloid: BigNumber
  ) {
    const l2TokenInfo = getTokenInfo(baseToken, this.chainId);
    const finalTokenInfo = getTokenInfo(finalToken, this.chainId);
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

  private async sendSponsorshipFundsToSwapHandler(baseToken: EvmAddress, amount: BigNumber) {
    const l2TokenInfo = getTokenInfo(baseToken, this.chainId);
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

  private async cancelLimitOrderByCloid(baseToken: EvmAddress, finalToken: EvmAddress, cloid: BigNumber) {
    const l2TokenInfo = getTokenInfo(baseToken, this.chainId);
    const finalTokenInfo = getTokenInfo(finalToken, this.chainId);
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
}
