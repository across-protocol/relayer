import { assert, BigNumber, bnZero, getNetworkName, Signer, winston } from "../../utils";
import { RebalanceRoute } from "../utils/interfaces";
import { BaseAdapter } from "./baseAdapter";
import { RebalancerConfig } from "../RebalancerConfig";
import { CctpAdapter } from "./cctpAdapter";
import { OftAdapter } from "./oftAdapter";

/**
 * Intermediate base class for swap adapters (Binance, Hyperliquid, Matcha) that share
 * a common pattern: bridge tokens to an intermediate "swap chain", execute the swap,
 * then bridge back to the final destination chain.
 */
export abstract class SwapAdapterBase extends BaseAdapter {
  constructor(
    readonly logger: winston.Logger,
    readonly config: RebalancerConfig,
    readonly baseSigner: Signer,
    readonly cctpAdapter: CctpAdapter,
    readonly oftAdapter: OftAdapter
  ) {
    super(logger, config, baseSigner);
  }

  // ////////////////////////////////////////////////////////////
  // ABSTRACT METHODS - must be implemented by subclasses
  // ////////////////////////////////////////////////////////////

  /**
   * Returns the chain where the swap will be executed for a given (chainId, token) pair.
   * - Hyperliquid: always HYPEREVM
   * - Binance: the Binance entrypoint network for the chain/token
   * - Matcha: the chain itself if natively supported, otherwise Arbitrum
   */
  protected abstract _getSwapChain(chainId: number, token: string): Promise<number> | number;

  // ////////////////////////////////////////////////////////////
  // SHARED BRIDGE HELPER METHODS
  // ////////////////////////////////////////////////////////////

  protected _getIntermediateAdapter(token: string): CctpAdapter | OftAdapter {
    return token === "USDT" ? this.oftAdapter : this.cctpAdapter;
  }

  protected _getIntermediateAdapterName(token: string): "oft" | "cctp" {
    return token === "USDT" ? "oft" : "cctp";
  }

  protected async _bridgeToChain(
    token: string,
    originChain: number,
    destinationChain: number,
    expectedAmountToTransfer: BigNumber
  ): Promise<BigNumber> {
    switch (token) {
      case "USDT":
        return await this.oftAdapter.initializeRebalance(
          {
            sourceChain: originChain,
            destinationChain,
            sourceToken: "USDT",
            destinationToken: "USDT",
            adapter: "oft",
          },
          expectedAmountToTransfer
        );
      case "USDC":
        return await this.cctpAdapter.initializeRebalance(
          {
            sourceChain: originChain,
            destinationChain,
            sourceToken: "USDC",
            destinationToken: "USDC",
            adapter: "cctp",
          },
          expectedAmountToTransfer
        );
      default:
        throw new Error(`Should never happen: Unsupported bridge for token: ${token}`);
    }
  }

  /**
   * Validates that intermediate CCTP/OFT bridge routes exist for all routes where
   * the source or destination chain is not the swap chain.
   */
  protected async _validateIntermediateRoutes(routes: RebalanceRoute[], adapterLabel: string): Promise<void> {
    for (const route of routes) {
      const { sourceToken, destinationToken, sourceChain, destinationChain } = route;
      const sourceSwapChain = await this._getSwapChain(sourceChain, sourceToken);
      const destinationSwapChain = await this._getSwapChain(destinationChain, destinationToken);

      if (destinationSwapChain !== destinationChain) {
        const intermediateRoute = {
          ...route,
          sourceChain: destinationSwapChain,
          sourceToken: destinationToken,
          adapter: this._getIntermediateAdapterName(destinationToken),
        };
        assert(
          this._getIntermediateAdapter(destinationToken).supportsRoute(intermediateRoute),
          `Destination chain ${getNetworkName(
            destinationChain
          )} is not a valid final destination chain for token ${destinationToken} because it doesn't have a ${this._getIntermediateAdapterName(
            destinationToken
          )} bridge route from the ${adapterLabel} swap chain ${getNetworkName(destinationSwapChain)}`
        );
      }
      if (sourceSwapChain !== sourceChain) {
        const intermediateRoute = {
          ...route,
          destinationChain: sourceSwapChain,
          destinationToken: sourceToken,
          adapter: this._getIntermediateAdapterName(sourceToken),
        };
        assert(
          this._getIntermediateAdapter(sourceToken).supportsRoute(intermediateRoute),
          `Source chain ${getNetworkName(
            sourceChain
          )} is not a valid source chain for token ${sourceToken} because it doesn't have a ${this._getIntermediateAdapterName(
            sourceToken
          )} bridge route to the ${adapterLabel} swap chain ${getNetworkName(sourceSwapChain)}`
        );
      }
    }
  }

  /**
   * Estimates bridge fees for bridging to/from the swap chain.
   * Returns { bridgeToFee, bridgeFromFee } in source token units.
   */
  protected async _estimateBridgeFees(
    rebalanceRoute: RebalanceRoute,
    amountToTransfer: BigNumber
  ): Promise<{ bridgeToFee: BigNumber; bridgeFromFee: BigNumber }> {
    const { sourceToken, destinationToken, sourceChain, destinationChain } = rebalanceRoute;

    // Bridge to swap chain fee:
    let bridgeToFee = bnZero;
    const sourceSwapChain = await this._getSwapChain(sourceChain, sourceToken);
    if (sourceSwapChain !== sourceChain) {
      const _rebalanceRoute = { ...rebalanceRoute, destinationChain: sourceSwapChain };
      if (
        sourceToken === "USDT" &&
        this.oftAdapter.supportsRoute({ ..._rebalanceRoute, destinationToken: "USDT", adapter: "oft" })
      ) {
        bridgeToFee = await this.oftAdapter.getEstimatedCost(
          { ..._rebalanceRoute, destinationToken: "USDT", adapter: "oft" },
          amountToTransfer
        );
      } else if (
        sourceToken === "USDC" &&
        this.cctpAdapter.supportsRoute({ ..._rebalanceRoute, destinationToken: "USDC", adapter: "cctp" })
      ) {
        bridgeToFee = await this.cctpAdapter.getEstimatedCost(
          { ..._rebalanceRoute, destinationToken: "USDC", adapter: "cctp" },
          amountToTransfer
        );
      }
    }

    // Bridge from swap chain fee:
    let bridgeFromFee = bnZero;
    const destinationSwapChain = await this._getSwapChain(destinationChain, destinationToken);
    if (destinationSwapChain !== destinationChain) {
      const _rebalanceRoute = { ...rebalanceRoute, sourceChain: destinationSwapChain };
      if (
        destinationToken === "USDT" &&
        this.oftAdapter.supportsRoute({ ..._rebalanceRoute, sourceToken: "USDT", adapter: "oft" })
      ) {
        bridgeFromFee = await this.oftAdapter.getEstimatedCost(
          { ..._rebalanceRoute, sourceToken: "USDT", adapter: "oft" },
          amountToTransfer
        );
      } else if (
        destinationToken === "USDC" &&
        this.cctpAdapter.supportsRoute({ ..._rebalanceRoute, sourceToken: "USDC", adapter: "cctp" })
      ) {
        bridgeFromFee = await this.cctpAdapter.getEstimatedCost(
          { ..._rebalanceRoute, sourceToken: "USDC", adapter: "cctp" },
          amountToTransfer
        );
      }
    }

    return { bridgeToFee, bridgeFromFee };
  }

  /**
   * Computes virtual balance adjustments for pending rebalances with intermediate bridge accounting.
   * - For PENDING_BRIDGE_PRE_DEPOSIT orders: subtracts from the swap chain to avoid double-counting
   *   (since the bridge adapter already adds a credit on the bridge destination).
   * - For all pending orders: adds a virtual credit on the final destination chain.
   *
   * Returns the pending rebalances map.
   */
  protected async _getPendingRebalancesWithBridgeAccounting(): Promise<{
    [chainId: number]: { [token: string]: BigNumber };
  }> {
    const pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};

    // Subtract intermediate bridge credits from the swap chain to avoid double-counting.
    const pendingBridges = await this._redisGetPendingBridgesPreDeposit();
    for (const cloid of pendingBridges) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { sourceChain, sourceToken, amountToTransfer } = orderDetails;
      const swapChain = await this._getSwapChain(sourceChain, sourceToken);
      const amountConverter = this._getAmountConverter(
        sourceChain,
        this._getTokenInfo(sourceToken, sourceChain).address,
        swapChain,
        this._getTokenInfo(sourceToken, swapChain).address
      );
      const convertedAmount = amountConverter(amountToTransfer);
      pendingRebalances[swapChain] ??= {};
      pendingRebalances[swapChain][sourceToken] = (pendingRebalances[swapChain][sourceToken] ?? bnZero).sub(
        convertedAmount
      );
      this.logger.debug({
        at: `${this.constructor.name}.getPendingRebalances`,
        message: `Subtracting ${convertedAmount.toString()} ${sourceToken} from swap chain ${getNetworkName(swapChain)} for intermediate bridge`,
      });
    }

    // Add virtual destination chain credits for all pending orders.
    const pendingOrders = await this._redisGetPendingOrders();
    if (pendingOrders.length > 0) {
      this.logger.debug({
        at: `${this.constructor.name}.getPendingRebalances`,
        message: `Found ${pendingOrders.length} pending orders`,
        pendingOrders,
      });
    }
    for (const cloid of pendingOrders) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { destinationChain, destinationToken, sourceChain, sourceToken, amountToTransfer } = orderDetails;
      const amountConverter = this._getAmountConverter(
        sourceChain,
        this._getTokenInfo(sourceToken, sourceChain).address,
        destinationChain,
        this._getTokenInfo(destinationToken, destinationChain).address
      );
      const convertedAmount = amountConverter(amountToTransfer);
      this.logger.debug({
        at: `${this.constructor.name}.getPendingRebalances`,
        message: `Adding ${convertedAmount.toString()} ${destinationToken} for pending order cloid ${cloid} to destination chain ${getNetworkName(destinationChain)}`,
      });
      pendingRebalances[destinationChain] ??= {};
      pendingRebalances[destinationChain][destinationToken] = (
        pendingRebalances[destinationChain][destinationToken] ?? bnZero
      ).add(convertedAmount);
    }

    return pendingRebalances;
  }
}
