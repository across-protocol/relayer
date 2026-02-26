import { getAcrossHost } from "./";
import { BigNumber, EvmAddress, winston, CHAIN_IDs } from "../utils";
import { SWAP_ROUTES, SwapRoute } from "../common";
import { BaseAcrossApiClient } from "./AcrossApiBaseClient";

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
  approval?: {
    target: EvmAddress;
    calldata: string;
  };
  swap: {
    target: EvmAddress;
    calldata: string;
    value: BigNumber;
  };
}

/**
 * @notice This class interfaces with the Across Swap API to execute swaps between chains.
 */
export class AcrossSwapApiClient extends BaseAcrossApiClient {
  private routesSupported: Set<SwapRoute> = new Set(Object.values(SWAP_ROUTES));

  constructor(logger: winston.Logger, timeoutMs = 3000) {
    // Swap API is mainnet-only.
    super(logger, `https://${getAcrossHost(CHAIN_IDs.MAINNET)}/api`, "AcrossSwapApiClient", timeoutMs);
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

    const [approval] = swapResponse.approvalTxns ?? [];
    if (!swapResponse.swapTx.simulationSuccess && !approval) {
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

    const swapData: SwapData = {
      swap: {
        target: EvmAddress.from(swapResponse.swapTx.to),
        calldata: swapResponse.swapTx.data,
        value: BigNumber.from(swapResponse.swapTx.value ?? 0),
      },
    };

    if (approval) {
      swapData.approval = {
        target: EvmAddress.from(approval.to),
        calldata: approval.data,
      };
    }

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
    return this._get<SwapApiResponse>("/swap/approval", params);
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
