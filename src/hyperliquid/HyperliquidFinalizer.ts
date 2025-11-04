import winston from "winston";
import { HyperliquidBotConfig } from "./HyperliquidBotConfig";
import { HyperliquidBaseClients, HyperliquidBase } from "./HyperliquidBase";
import {
  Contract,
  Provider,
  isDefined,
  paginatedEventQuery,
  mapAsync,
  EventSearchConfig,
  getBlockForTimestamp,
} from "../utils";
import { CONTRACT_ADDRESSES, CHAIN_MAX_BLOCK_LOOKBACK } from "../common";

export interface HyperliquidFinalizerClients extends HyperliquidBaseClients {
  l2ProvidersByChain: { [chainId: number]: Provider };
}

/**
 */
export class HyperliquidFinalizer extends HyperliquidBase {
  private srcOftMessengers: { [chainId: number]: Contract };
  private srcCctpMessengers: { [chainId: number]: Contract };
  private searchConfigs: { [chainId: number]: EventSearchConfig };

  public constructor(
    readonly logger: winston.Logger,
    readonly config: HyperliquidBotConfig,
    readonly clients: HyperliquidFinalizerClients
  ) {
    super(logger, config, clients);
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
  }

  public override async initialize(): Promise<void> {
    this.searchConfigs = Object.fromEntries(
      await mapAsync(Object.entries(this.clients.l2ProvidersByChain), async ([_chainId, provider]) => {
        const chainId = Number(_chainId);
        const to = await provider.getBlock("latest");
        const from = await getBlockForTimestamp(this.logger, chainId, to.timestamp - this.config.depositLookback);
        const searchConfig = {
          to: to.number,
          from,
          maxLookBack: CHAIN_MAX_BLOCK_LOOKBACK[chainId],
        };
        return [chainId, searchConfig];
      })
    );
    await super.initialize();
  }

  private async getOutstandingCrossChainOrders(): Promise<void> {
    // Query the orders initiated on origin.
    const [oftOrdersInitiated, cctpOrdersInitiated] = await Promise.all([
      Object.fromEntries(
        await mapAsync(Object.entries(this.srcOftMessengers), async ([chainId, oftMessenger]) => {
          const ordersInitiatedOnChain = await paginatedEventQuery(
            oftMessenger,
            oftMessenger.filters.SponsoredOFTSend(),
            this.searchConfigs[chainId]
          );
          return [chainId, ordersInitiatedOnChain];
        })
      ),
      Object.fromEntries(
        await mapAsync(Object.entries(this.srcCctpMessengers), async ([chainId, cctpMessenger]) => {
          const ordersInitiatedOnChain = await paginatedEventQuery(
            cctpMessenger,
            cctpMessenger.SponsoredDepositForBurn(),
            this.searchConfigs[chainId]
          );
          return [chainId, ordersInitiatedOnChain];
        })
      ),
    ]);
    oftOrdersInitiated;
    cctpOrdersInitiated;
    // Query the filled orders on HyperEVM. There are two cases: The order was successfully marked as a sponsored order and should have
    // a matching send event, or it exceeded the slippage threshold during the cross chain transfer and was aborted by the contract.
  }
}
