import axios, { AxiosError } from "axios";
import { BigNumber, bnZero, EvmAddress, winston } from "../utils";
import { SWAP_ROUTES, SwapRoute } from "../common";

interface SwapApiResponse {
  approvalTxns?: {
    chainId: number;
    to: string;
    data: string;
  }[];
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
  private routesSupported: Set<SwapRoute> = new Set(Object.values(SWAP_ROUTES));
  private readonly urlBase = "https://app.across.to/api/swap/approval";
  private readonly apiResponseTimeout = 3000;

  constructor(readonly logger: winston.Logger) {}

  async getApproval(
    route: SwapRoute,
    amountOut: BigNumber,
    swapper: EvmAddress,
    recipient: EvmAddress
  ): Promise<SwapData | undefined> {
    const swapResponse = await this.getQuote(route, amountOut, swapper, recipient);
    if (!swapResponse) {
      return;
    }

    const [approvalData] = swapResponse.approvalTxns ?? [];
    if (!swapResponse.swapTx.simulationSuccess && !approvalData) {
      this.logger.warn({
        at: "AcrossSwapApiClient",
        message: "Swap simulation failed in API",
        url: this.urlBase,
        route,
        amountOut,
        swapper: swapper.toNative(),
        recipient: recipient.toNative(),
      });
      return;
    }

    const approval = {
      target: EvmAddress.from(approvalData.to),
      calldata: approvalData.data,
      value: bnZero,
    };

    this.logger.debug({
      at: "AcrossSwapApiClient",
      message: "Produced approval for Swap API.",
      approval,
      route,
    });

    return approval;
  }

  /**
   * @notice Returns calldata necessary to swap exact output using the Across Swap API.
   * @param route The route to swap on.
   * @param amountOut The amount of output tokens to swap for.
   * @param swapper The address of the swapper.
   * @param recipient The address of the recipient.
   * @returns The swap data if the swap is successful, undefined otherwise.
   */
  async swapWithRoute(
    route: SwapRoute,
    amountOut: BigNumber,
    swapper: EvmAddress,
    recipient: EvmAddress
  ): Promise<SwapData | undefined> {
    const swapResponse = await this.getQuote(route, amountOut, swapper, recipient);
    if (!swapResponse) {
      return;
    }

    if (!swapResponse.swapTx.simulationSuccess) {
      this.logger.warn({
        at: "AcrossSwapApiClient",
        message: "Swap simulation failed in API",
        url: this.urlBase,
        route,
        amountOut,
        swapper: swapper.toNative(),
        recipient: recipient.toNative(),
      });
      return;
    }

    const swapData = {
      target: EvmAddress.from(swapResponse.swapTx.to),
      calldata: swapResponse.swapTx.data,
      value: BigNumber.from(swapResponse.swapTx.value ?? 0),
    };

    const { inputToken, originChainId, outputToken, destinationChainId, tradeType } = route;
    this.logger.debug({
      at: "AcrossSwapApiClient",
      message: `Successfully fetched ${tradeType} swap calldata for ${originChainId}-${inputToken} -> ${destinationChainId}-${outputToken}`,
      swapData,
    });

    return swapData;
  }

  private async getQuote(
    route: SwapRoute,
    amountOut: BigNumber,
    swapper: EvmAddress,
    recipient: EvmAddress
  ): Promise<SwapApiResponse | undefined> {
    if (!this._isRouteSupported(route)) {
      throw new Error(
        `Route ${route.inputToken} -> ${route.outputToken} on ${route.originChainId} -> ${route.destinationChainId} is not supported`
      );
    }

    const params = {
      originChainId: route.originChainId,
      destinationChainId: route.destinationChainId,
      inputToken: route.inputToken.toNative(),
      outputToken: route.outputToken.toNative(),
      tradeType: route.tradeType,
      amount: amountOut.toString(),
      depositor: swapper.toNative(),
      recipient: recipient.toNative(),
    };

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
        });
        return;
      }

      return response.data;
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
  }

  private _isRouteSupported(route: SwapRoute): boolean {
    return Array.from(this.routesSupported).some(
      (r) =>
        r.inputToken.eq(route.inputToken) &&
        r.outputToken.eq(route.outputToken) &&
        r.originChainId === route.originChainId &&
        r.destinationChainId === route.destinationChainId
    );
  }
}
