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
 * Request body for the v3 (upgradeable-counterfactual) deposit-address sign-withdraw endpoint.
 * The server **verifies** (never re-derives) the deposit address from these persisted CDA
 * materials, so every contract address is mandatory and the withdraw merkle `proof` is supplied
 * by the caller (the leaf itself is rebuilt server-side).
 */
export interface DepositAddressSignWithdrawRequest {
  chainId: number;
  depositAddress: string;
  initialRoot: string;
  salt: string;
  token: string;
  /** uint256 refund amount as a decimal (or 0x-hex) string. */
  amount: string;
  /** Refund recipient committed on-chain at deposit-address creation (not redirectable). */
  user: string;
  /** bytes32[] merkle proof for the withdraw leaf. */
  proof: string[];
  counterfactualDepositFactory: string;
  counterfactualBeacon: string;
  adminWithdrawManager: string;
  withdrawImplementation: string;
  /** When true, the estimated execution cost is converted to refund-token units and subtracted. */
  deductGasFromRefund?: boolean;
}

export interface DepositAddressSignWithdrawResponse {
  signedWithdrawTx: {
    ecosystem: "evm";
    chainId: number;
    to: string;
    data: string;
    value: string;
  };
  bundledDeploy: boolean;
  signer: string;
  deadline: number;
  /** Raw smallest-unit strings. With deduction off: appliedGasFee "0", netAmount === requestedAmount. */
  requestedAmount: string;
  appliedGasFee: string;
  netAmount: string;
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
  // The origin token that funded the deposit address.
  inputToken?: {
    chainId: number;
    address: string;
  };
  /**
   * The withdraw "user" identity committed at deposit-address creation (the refund address).
   * Origin-chain-native encoding: 0x-hex on EVM, base58 on Tron.
   */
  userAddress: string;
  /** Input amount as a decimal (or 0x-hex) bigint string. */
  amount: string;
  /** Origin-chain-native encoding, like `userAddress`. */
  executionFeeRecipient: string;
  /** Bot-priced payout, deducted from the bridged amount. Omitted => 0. */
  executionFee?: string;
  /**
   * Integrator attribution (2-byte hex, `^0x[0-9a-fA-F]{4}$`). Sourced from the indexer message's
   * `integrator` projection, NOT the bot's auth key (the bot sweeps addresses owned by many
   * integrators); drives the CREATE2 salt + on-chain integrator tag. Required by the endpoint.
   */
  integratorId: string;
  /**
   * Optional reference to the inbound ERC-20 transfer that funded the sweep. When present, the API
   * wraps `executeTx` in a Multicall3 bundle that also emits a version-2 provenance blob via
   * `AcrossEventEmitter`, so the indexer can link the deposit-executed event to this transfer in the
   * same receipt. `transactionHash` is a 32-byte hex hash (`^(0x)?[0-9a-fA-F]{64}$`); the numeric
   * fields must be non-negative integers. Only sent when the bot is configured against an API that
   * accepts the field (see `enableExecuteErc20Transfer`) — older APIs reject it as an unknown param.
   */
  erc20Transfer?: {
    chainId: number;
    blockNumber: number;
    transactionHash: string;
    logIndex: number;
  };
}

export interface DepositAddressExecuteResponse {
  /** The API's re-derived deposit address; must match the funded address from the indexer. */
  depositAddress: string;
  executeTx: {
    /** "tvm" for Tron-origin executes; `to` is 0x-hex on both ecosystems. */
    ecosystem: "evm" | "tvm";
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

  /** v1 counterfactual deposit-execute quote (GET). */
  async getCounterfactualDepositQuote(params: Record<string, unknown>): Promise<SwapApiResponse | undefined> {
    return this._get<SwapApiResponse>("swap/counterfactual", params);
  }

  async signedWithdraw(req: SignedWithdrawRequest): Promise<SignedWithdrawResponse | undefined> {
    return this._post<SignedWithdrawResponse>("/swap/counterfactual/sign-withdraw", req);
  }

  /**
   * v3 (upgradeable-counterfactual) sign-withdraw (POST). Rethrows on failure (via `_postOrThrow`)
   * so the caller can classify the HTTP status — a 422 (`GAS_EXCEEDS_REFUND` /
   * `UNPRICEABLE_REFUND_TOKEN`) is terminal, other failures are retryable.
   */
  async signWithdrawDepositAddressV3(
    req: DepositAddressSignWithdrawRequest
  ): Promise<DepositAddressSignWithdrawResponse> {
    return this._postOrThrow<DepositAddressSignWithdrawResponse>("deposit-addresses/sign-withdraw", req);
  }

  /** v3 upgradeable-counterfactual deposit-execute quote (POST). */
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
