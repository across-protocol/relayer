import { getAcrossHost } from "./";
import { BigNumber, EvmAddress, winston, CHAIN_IDs } from "../utils";
import { SWAP_ROUTES, SwapRoute } from "../common";
import { BaseAcrossApiClient } from "./AcrossApiBaseClient";

export interface SwapApiResponse {
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

export interface SignedWithdrawRequest {
  chainId: number;
  depositAddress: string;
  token: string;
  amount: string;
  user: string;
  withdrawImplementation: string;
  proof: string[];
  salt: string;
  merkleRoot: string;
}

export interface SignedWithdrawResponse {
  signedWithdrawTx: {
    chainId: number;
    to: string;
    data: string;
    value: string;
  };
  bundledDeploy: boolean;
  signer: string;
  deadline: number;
}

/**
 * Request body for the v3 deposit-address execute endpoint. The API re-derives the deposit
 * address and all counterfactual materials from the identity (`destination`, `userAddress`);
 * the bot only supplies funding context and its payout address.
 */
export interface DepositAddressExecuteRequest {
  destination: {
    token: {
      chainId: number;
      address: string;
    };
    recipient: string;
  };
  originChainId: number;
  /** The withdraw "user" identity committed at deposit-address creation (the refund address). */
  userAddress: string;
  /** Input amount as a decimal (or 0x-hex) bigint string. */
  amount: string;
  executionFeeRecipient: string;
  /** Bot-priced payout, deducted from the bridged amount. Omitted => 0. */
  executionFee?: string;
}

export interface DepositAddressExecuteResponse {
  /** The API's re-derived deposit address; must match the funded address from the indexer. */
  depositAddress: string;
  executeTx: {
    ecosystem: "evm";
    chainId: number;
    to: string;
    data: string;
    value: string;
  };
  signer: string;
  /** Unix-seconds deadline on the embedded counterfactual signature; calldata is perishable. */
  signatureDeadline: number;
  /** True when the address derivation used placeholder creation code; never submit if set. */
  isPlaceholder: boolean;
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

  constructor(logger: winston.Logger, timeoutMs = 3000, apiKey?: string) {
    super(logger, `https://${getAcrossHost(CHAIN_IDs.MAINNET)}/api`, "AcrossSwapApiClient", timeoutMs, apiKey);
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
        swapper,
        recipient,
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

  async signedWithdraw(req: SignedWithdrawRequest): Promise<SignedWithdrawResponse | undefined> {
    return this._post<SignedWithdrawResponse>("/swap/counterfactual/sign-withdraw", req);
  }

  async executeDepositAddress(req: DepositAddressExecuteRequest): Promise<DepositAddressExecuteResponse | undefined> {
    return this._post<DepositAddressExecuteResponse>("deposit-addresses/execute", req);
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
