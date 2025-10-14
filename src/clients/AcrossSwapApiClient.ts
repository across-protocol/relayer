import axios, { AxiosError } from "axios";
import { BigNumber, EvmAddress, winston } from "../utils";
import { SWAP_ROUTES } from "../common";

interface Route {
  inputToken: EvmAddress;
  outputToken: EvmAddress;
  originChainId: number;
  destinationChainId: number;
}
interface SwapApiResponse {
  swapTx: {
    simulationSuccess: boolean;
    to: string;
    data: string;
    value: string;
  };
}
interface SwapData {
  target: EvmAddress;
  calldata: string;
  value: BigNumber;
}

/**
 * @notice This class interfaces with the Across Swap API to execute swaps between chains.
 */
export class AcrossSwapApiClient {
  private routesSupported: Set<Route> = new Set(Object.values(SWAP_ROUTES));
  private initialized = false;
  private readonly urlBase = "https://app.across.to/api/swap/approval";
  private readonly apiResponseTimeout = 3000;
  private readonly swapExactOutputCacheTtl = 10 * 60; // Allow exactly one swap per route per 10 minutes.

  constructor(readonly logger: winston.Logger) {}

  /**
   * @notice Returns calldata necessary to swap exact output using the Across Swap API.
   * @param route The route to swap on.
   * @param amountOut The amount of output tokens to swap for.
   * @param swapper The address of the swapper.
   * @param recipient The address of the recipient.
   * @returns The swap data if the swap is successful, undefined otherwise.
   */
  async swapExactOutput(
    route: Route,
    amountOut: BigNumber,
    swapper: EvmAddress,
    recipient: EvmAddress
  ): Promise<SwapData | undefined> {
    if (!this._isRouteSupported(route)) {
      throw new Error(
        `Route ${route.inputToken.toNative()} -> ${route.outputToken.toNative()} on ${route.originChainId} -> ${
          route.destinationChainId
        } is not supported`
      );
    }

    const params = {
      originChainId: route.originChainId,
      destinationChainId: route.destinationChainId,
      inputToken: route.inputToken.toNative(),
      outputToken: route.outputToken.toNative(),
      tradeType: "exactOutput",
      amount: amountOut.toString(),
      depositor: swapper.toNative(),
      recipient: recipient.toNative(),
    };
    let swapData: SwapData;
    try {
      const response = await axios.get<SwapApiResponse>(`${this.urlBase}`, {
        timeout: this.apiResponseTimeout,
        params,
      });
      if (!response?.data) {
        this.logger.warn({
          at: "AcrossAPIClient",
          message: `Invalid response from ${this.urlBase}`,
          url: this.urlBase,
          params,
          response,
        });
        return;
      }
      if (!response.data.swapTx.simulationSuccess) {
        this.logger.warn({
          at: "AcrossSwapApiClient",
          message: "Swap simulation failed in API",
          url: this.urlBase,
          params,
          response,
        });
        return;
      }
      swapData = {
        target: EvmAddress.from(response.data.swapTx.to),
        calldata: response.data.swapTx.data,
        value: BigNumber.from(response.data.swapTx.value),
      };
    } catch (err) {
      this.logger.warn({
        at: "AcrossSwapApiClient",
        message: `Failed to post to ${this.urlBase}`,
        url: this.urlBase,
        params,
        error: (err as AxiosError).message,
      });
      return;
    }

    this.logger.debug({
      at: "AcrossSwapApiClient",
      message: `Successfully fetched swap calldata for ${route.originChainId}-${route.inputToken.toNative()} -> ${
        route.destinationChainId
      }-${route.outputToken.toNative()}`,
      swapData,
    });

    return swapData;
  }

  private _isRouteSupported(route: Route): boolean {
    return Array.from(this.routesSupported).some(
      (r) =>
        r.inputToken.eq(route.inputToken) &&
        r.outputToken.eq(route.outputToken) &&
        r.originChainId === route.originChainId &&
        r.destinationChainId === route.destinationChainId
    );
  }
}
