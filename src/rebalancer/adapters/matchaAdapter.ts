import { MultiCallerClient } from "../../clients";
import {
  assert,
  BigNumber,
  bnZero,
  CHAIN_IDs,
  Contract,
  ERC20,
  ethers,
  fromWei,
  getMatchaQuote,
  getNetworkName,
  getProvider,
  MAX_SAFE_ALLOWANCE,
  Signer,
  toBN,
  toBNWei,
  winston,
  ZERO_X_ALLOWANCE_HOLDER,
} from "../../utils";
import { RebalanceRoute } from "../utils/interfaces";
import { STATUS } from "./baseAdapter";
import { SwapAdapterBase } from "./swapAdapterBase";
import { RebalancerConfig } from "../RebalancerConfig";
import { CctpAdapter } from "./cctpAdapter";
import { OftAdapter } from "./oftAdapter";

// Chains where Matcha/0x swaps can be executed directly on-chain.
const MATCHA_NATIVE_CHAINS = new Set([CHAIN_IDs.MAINNET, CHAIN_IDs.BSC, CHAIN_IDs.ARBITRUM, CHAIN_IDs.BASE]);

// Default slippage tolerance in basis points to set when submitting matcha txn. Rebalances sent through
// this adapter must still obey any max fee allowed variables set by upstream client.
const DEFAULT_SLIPPAGE_BPS = 10; // 10 is lowest allowed setting on Match UI before you get a "low slippage" warning.

// https://www.quicknode.com/docs/ethereum/eth_getTransactionReceipt status field is either 1 or 0:
const ETH_GET_TRANSACTION_RESPONSE_REVERTED_TXN = 0;

export class MatchaSwapAdapter extends SwapAdapterBase {
  REDIS_PREFIX = "matcha-swap:";

  private slippageBps: number;

  constructor(
    readonly logger: winston.Logger,
    readonly config: RebalancerConfig,
    readonly baseSigner: Signer,
    readonly cctpAdapter: CctpAdapter,
    readonly oftAdapter: OftAdapter
  ) {
    super(logger, config, baseSigner, cctpAdapter, oftAdapter);
    this.slippageBps = Number(process.env.MATCHA_SLIPPAGE_BPS ?? DEFAULT_SLIPPAGE_BPS);
  }

  // ////////////////////////////////////////////////////////////
  // ABSTRACT METHOD IMPLEMENTATION
  // ////////////////////////////////////////////////////////////

  protected _getSwapChain(chainId: number, _token: string): number {
    if (MATCHA_NATIVE_CHAINS.has(chainId)) {
      return chainId;
    }
    // Default to Arbitrum: supports both CCTP (USDC) and OFT (USDT) bridges, low gas fees.
    return CHAIN_IDs.ARBITRUM;
  }

  // ////////////////////////////////////////////////////////////
  // PUBLIC METHODS
  // ////////////////////////////////////////////////////////////

  async initialize(_availableRoutes: RebalanceRoute[]): Promise<void> {
    if (this.initialized) {
      return;
    }
    await super.initialize(_availableRoutes.filter((route) => route.adapter === "matcha"));

    // Validate intermediate CCTP/OFT bridge routes exist for non-native chains.
    await this._validateIntermediateRoutes(this.availableRoutes, "Matcha");
  }

  async setApprovals(): Promise<void> {
    await super.setApprovals();
    this.multicallerClient = new MultiCallerClient(this.logger, this.config.multiCallChunkSize, this.baseSigner);

    // For each natively supported chain used by routes, approve the AllowanceHolder contract for each token.
    const chainsAndTokens = new Map<number, Set<string>>();
    for (const route of this.availableRoutes) {
      const swapChain = this._getSwapChain(route.sourceChain, route.sourceToken);
      if (!chainsAndTokens.has(swapChain)) {
        chainsAndTokens.set(swapChain, new Set());
      }
      chainsAndTokens.get(swapChain).add(route.sourceToken);
    }

    for (const [chainId, tokens] of chainsAndTokens) {
      const provider = await getProvider(chainId);
      const connectedSigner = this.baseSigner.connect(provider);
      for (const token of tokens) {
        const tokenInfo = this._getTokenInfo(token, chainId);
        const erc20 = new Contract(tokenInfo.address.toNative(), ERC20.abi, connectedSigner);
        // @todo: Consider grabbing allowance target from 0x API at cost of additional API call.
        const allowance = await erc20.allowance(this.baseSignerAddress.toNative(), ZERO_X_ALLOWANCE_HOLDER);
        if (allowance.lt(toBN(MAX_SAFE_ALLOWANCE).div(2))) {
          this.multicallerClient.enqueueTransaction({
            contract: erc20,
            chainId,
            method: "approve",
            nonMulticall: true,
            unpermissioned: false,
            args: [ZERO_X_ALLOWANCE_HOLDER, MAX_SAFE_ALLOWANCE],
            message: `Approved ${token} for 0x AllowanceHolder on ${getNetworkName(chainId)}`,
            mrkdwn: `Approved ${token} for 0x AllowanceHolder on ${getNetworkName(chainId)}`,
          });
        }
      }
    }
    const simMode = !this.config.sendingTransactionsEnabled;
    await this.multicallerClient.executeTxnQueues(simMode);
  }

  async initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<BigNumber> {
    this._assertInitialized();
    this._assertRouteIsSupported(rebalanceRoute);

    const { sourceToken, sourceChain, destinationToken, destinationChain } = rebalanceRoute;
    const sourceTokenInfo = this._getTokenInfo(sourceToken, sourceChain);

    // Check minimum order size.
    const minimumOrderSize = toBNWei(process.env.MATCHA_MINIMUM_SWAP_AMOUNT ?? 10, sourceTokenInfo.decimals);
    if (amountToTransfer.lt(minimumOrderSize)) {
      this.logger.debug({
        at: "MatchaSwapAdapter.initializeRebalance",
        message: `Amount to transfer ${amountToTransfer.toString()} is less than minimum order size ${minimumOrderSize.toString()}`,
      });
      return bnZero;
    }

    const cloid = await this._redisGetNextCloid();
    const swapChain = this._getSwapChain(sourceChain, sourceToken);

    if (sourceChain !== swapChain) {
      // Bridge source token to swap chain first.
      this.logger.info({
        at: "MatchaSwapAdapter.initializeRebalance",
        message: `🍻 Creating new order ${cloid} by first bridging ${sourceToken} to ${getNetworkName(swapChain)} from ${getNetworkName(sourceChain)}`,
        destinationToken,
        destinationChain: getNetworkName(destinationChain),
        amountToTransfer: amountToTransfer.toString(),
      });
      const amountReceivedFromBridge = await this._bridgeToChain(sourceToken, sourceChain, swapChain, amountToTransfer);
      await this._redisCreateOrder(cloid, STATUS.PENDING_BRIDGE_PRE_DEPOSIT, rebalanceRoute, amountReceivedFromBridge);
      return amountReceivedFromBridge;
    } else {
      // Source chain is the swap chain; execute swap immediately.
      this.logger.info({
        at: "MatchaSwapAdapter.initializeRebalance",
        message: `🍻 Creating new order ${cloid} by swapping ${sourceToken} to ${destinationToken} on ${getNetworkName(swapChain)}`,
        destinationChain: getNetworkName(destinationChain),
        amountToTransfer: amountToTransfer.toString(),
      });
      const swapTxHash = await this._submitSwapWithValidation(
        swapChain,
        sourceToken,
        destinationToken,
        amountToTransfer
      );
      await this._redisSaveSwapTxHash(cloid, swapTxHash);
      await this._redisCreateOrder(cloid, STATUS.PENDING_SWAP, rebalanceRoute, amountToTransfer);
      return amountToTransfer;
    }
  }

  async updateRebalanceStatuses(): Promise<void> {
    this._assertInitialized();

    // PENDING_BRIDGE_PRE_DEPOSIT -> PENDING_SWAP: Bridge has landed on swap chain, execute swap.
    const pendingBridges = await this._redisGetPendingBridgesPreDeposit();
    if (pendingBridges.length > 0) {
      this.logger.debug({
        at: "MatchaSwapAdapter.updateRebalanceStatuses",
        message: "Orders pending bridge to swap chain",
        pendingBridges,
      });
    }
    for (const cloid of pendingBridges) {
      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { sourceToken, destinationToken, amountToTransfer, sourceChain } = orderDetails;
      const swapChain = this._getSwapChain(sourceChain, sourceToken);
      const tokenInfo = this._getTokenInfo(sourceToken, swapChain);
      const balance = await this._getERC20Balance(swapChain, tokenInfo.address.toNative());

      const amountConverter = this._getAmountConverter(
        sourceChain,
        this._getTokenInfo(sourceToken, sourceChain).address,
        swapChain,
        tokenInfo.address
      );
      const requiredAmount = amountConverter(amountToTransfer);

      if (balance.lt(requiredAmount)) {
        this.logger.debug({
          at: "MatchaSwapAdapter.updateRebalanceStatuses",
          message: `Not enough ${sourceToken} balance on ${getNetworkName(swapChain)} to execute swap for order ${cloid}`,
          balance: balance.toString(),
          requiredAmount: requiredAmount.toString(),
        });
        continue;
      }

      this.logger.debug({
        at: "MatchaSwapAdapter.updateRebalanceStatuses",
        message: `Sufficient ${sourceToken} balance on ${getNetworkName(swapChain)}, executing swap for order ${cloid}`,
        balance: balance.toString(),
      });
      const swapTxHash = await this._submitSwapWithValidation(swapChain, sourceToken, destinationToken, requiredAmount);
      await this._redisSaveSwapTxHash(cloid, swapTxHash);
      await this._redisUpdateOrderStatus(cloid, STATUS.PENDING_BRIDGE_PRE_DEPOSIT, STATUS.PENDING_SWAP);
    }

    // PENDING_SWAP -> COMPLETE (with optional synchronous bridge):
    // Check swap tx receipt, then bridge to final destination if needed.
    const pendingSwaps = await this._redisGetPendingSwaps();
    if (pendingSwaps.length > 0) {
      this.logger.debug({
        at: "MatchaSwapAdapter.updateRebalanceStatuses",
        message: "Orders pending swap confirmation",
        pendingSwaps,
      });
    }
    for (const cloid of pendingSwaps) {
      const swapTxHash = await this._redisGetSwapTxHash(cloid);
      if (!swapTxHash) {
        this.logger.warn({
          at: "MatchaSwapAdapter.updateRebalanceStatuses",
          message: `No swap tx hash found for order ${cloid} in PENDING_SWAP state, skipping`,
        });
        continue;
      }

      const orderDetails = await this._redisGetOrderDetails(cloid);
      const { destinationToken, destinationChain, sourceChain, sourceToken, amountToTransfer } = orderDetails;
      const swapChain = this._getSwapChain(sourceChain, sourceToken);
      const provider = await getProvider(swapChain);
      const receipt = await provider.getTransactionReceipt(swapTxHash);

      if (!receipt) {
        this.logger.debug({
          at: "MatchaSwapAdapter.updateRebalanceStatuses",
          message: `Swap tx ${swapTxHash} for order ${cloid} has not been mined yet, waiting`,
        });
        continue;
      }

      if (receipt.status === ETH_GET_TRANSACTION_RESPONSE_REVERTED_TXN) {
        // Re-submit the swap: the reverted tx didn't consume sell tokens so funds are still available.
        // Order stays in PENDING_SWAP so the next cycle will check the new tx.
        const sourceTokenInfoOnSource = this._getTokenInfo(sourceToken, sourceChain);
        const sourceTokenInfoOnSwap = this._getTokenInfo(sourceToken, swapChain);
        const swapAmount = this._getAmountConverter(
          sourceChain,
          sourceTokenInfoOnSource.address,
          swapChain,
          sourceTokenInfoOnSwap.address
        )(amountToTransfer);
        this.logger.warn({
          at: "MatchaSwapAdapter.updateRebalanceStatuses",
          message: `Swap tx ${swapTxHash} for order ${cloid} reverted on-chain. Re-submitting swap for ${swapAmount.toString()} ${sourceToken} on ${getNetworkName(swapChain)}.`,
        });
        const newSwapTxHash = await this._submitSwapWithValidation(
          swapChain,
          sourceToken,
          destinationToken,
          swapAmount
        );
        await this._redisSaveSwapTxHash(cloid, newSwapTxHash);
        continue;
      }

      // Swap succeeded.
      if (destinationChain === swapChain) {
        this.logger.info({
          at: "MatchaSwapAdapter.updateRebalanceStatuses",
          message: `✨ Deleting order ${cloid} because swap completed on final destination chain ${getNetworkName(destinationChain)}`,
        });
        await this._redisDeleteOrder(cloid, STATUS.PENDING_SWAP);
      } else {
        // Need to bridge output tokens to the final destination chain.
        // Parse Transfer events from the swap receipt to scope the bridge amount to this order's
        // actual swap output, rather than the full wallet balance (which could include unrelated funds).
        const destTokenInfo = this._getTokenInfo(destinationToken, swapChain);
        const swapOutput = this._getSwapOutputFromReceipt(receipt, destTokenInfo.address.toNative());
        if (swapOutput.lte(bnZero)) {
          this.logger.debug({
            at: "MatchaSwapAdapter.updateRebalanceStatuses",
            message: `Swap completed for order ${cloid} but no ${destinationToken} Transfer to wallet found in receipt, waiting`,
          });
          continue;
        }
        this.logger.info({
          at: "MatchaSwapAdapter.updateRebalanceStatuses",
          message: `✨ Swap completed for order ${cloid}; bridging ${destinationToken} from ${getNetworkName(swapChain)} to final destination ${getNetworkName(destinationChain)}`,
          swapOutput: swapOutput.toString(),
        });
        await this._bridgeToChain(destinationToken, swapChain, destinationChain, swapOutput);
        await this._redisDeleteOrder(cloid, STATUS.PENDING_SWAP);
      }
    }
  }

  async sweepIntermediateBalances(): Promise<void> {
    // No-op: tokens are on real EVM chains and usable directly. Same pattern as Binance.
  }

  async getEstimatedCost(
    rebalanceRoute: RebalanceRoute,
    amountToTransfer: BigNumber,
    debugLog: boolean
  ): Promise<BigNumber> {
    this._assertRouteIsSupported(rebalanceRoute);
    const { sourceToken, destinationToken, sourceChain, destinationChain } = rebalanceRoute;
    const swapChain = this._getSwapChain(sourceChain, sourceToken);

    const sourceTokenInfo = this._getTokenInfo(sourceToken, swapChain);
    const destinationTokenInfo = this._getTokenInfo(destinationToken, swapChain);
    const quote = await getMatchaQuote(
      swapChain,
      sourceTokenInfo.address.toNative(),
      destinationTokenInfo.address.toNative(),
      amountToTransfer.toString(),
      this.baseSignerAddress.toNative(),
      this.slippageBps
    );

    // Swap cost = what we sell minus what we get back (adjusted for decimal differences).
    const buyAmountInSourceDecimals = this._getAmountConverter(
      swapChain,
      destinationTokenInfo.address,
      swapChain,
      sourceTokenInfo.address
    )(BigNumber.from(quote.buyAmount));
    const swapCost = amountToTransfer.sub(buyAmountInSourceDecimals);

    // Bridge fees for non-native chains.
    const { bridgeToFee, bridgeFromFee } = await this._estimateBridgeFees(rebalanceRoute, amountToTransfer);

    // Gas cost for the swap transaction on the swap chain (0x API provides estimated gas units).
    const swapGasCost = await this._estimateGasCostInSourceToken(
      swapChain,
      Number(quote.transaction.gas),
      sourceToken,
      sourceChain
    );

    const totalFee = swapCost.add(bridgeToFee).add(bridgeFromFee).add(swapGasCost);

    if (debugLog) {
      this.logger.debug({
        at: "MatchaSwapAdapter.getEstimatedCost",
        message: `Calculating total fees for rebalance route ${sourceToken} on ${getNetworkName(
          sourceChain
        )} to ${destinationToken} on ${getNetworkName(destinationChain)} with amount to transfer ${amountToTransfer.toString()}`,
        swapChain: getNetworkName(swapChain),
        buyAmount: quote.buyAmount,
        swapCost: swapCost.toString(),
        swapGasCost: swapGasCost.toString(),
        bridgeToFee: bridgeToFee.toString(),
        bridgeFromFee: bridgeFromFee.toString(),
        totalFee: totalFee.toString(),
      });
    }

    return totalFee;
  }

  async getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    this._assertInitialized();
    return this._getPendingRebalancesWithBridgeAccounting();
  }

  async getPendingOrders(): Promise<string[]> {
    return this._redisGetPendingOrders();
  }

  // ////////////////////////////////////////////////////////////
  // PRIVATE HELPER METHODS
  // ////////////////////////////////////////////////////////////

  /**
   * Validates and submits a swap transaction via the 0x API. Returns the tx hash.
   * Does NOT wait for the receipt - crash resilience is handled by the state machine.
   */
  private async _submitSwapWithValidation(
    swapChain: number,
    sourceToken: string,
    destinationToken: string,
    amount: BigNumber
  ): Promise<string> {
    const sourceTokenInfo = this._getTokenInfo(sourceToken, swapChain);
    const destinationTokenInfo = this._getTokenInfo(destinationToken, swapChain);

    // Get firm quote from 0x API.
    const quote = await getMatchaQuote(
      swapChain,
      sourceTokenInfo.address.toNative(),
      destinationTokenInfo.address.toNative(),
      amount.toString(),
      this.baseSignerAddress.toNative(),
      this.slippageBps
    );

    // Pre-swap validation.
    if (quote.issues?.balance) {
      throw new Error(
        `0x API reports insufficient balance for swap on ${getNetworkName(swapChain)}: ${JSON.stringify(quote.issues.balance)}`
      );
    }
    if (quote.issues?.allowance) {
      throw new Error(
        `0x API reports insufficient allowance for swap on ${getNetworkName(swapChain)}: ${JSON.stringify(quote.issues.allowance)}`
      );
    }

    const minBuyAmount = BigNumber.from(quote.minBuyAmount);
    assert(minBuyAmount.gt(bnZero), `0x quote returned zero minBuyAmount for swap on ${getNetworkName(swapChain)}`);

    // Verify sufficient source token balance.
    const balance = await this._getERC20Balance(swapChain, sourceTokenInfo.address.toNative());
    assert(
      balance.gte(amount),
      `Insufficient ${sourceToken} balance on ${getNetworkName(swapChain)}: have ${balance.toString()}, need ${amount.toString()}`
    );

    // Submit the swap transaction via _submitTransaction which handles simulation, gas estimation,
    // and retry logic. Use method="" for raw transaction mode since the 0x API returns pre-built
    // transaction data (to, data, value) rather than a contract method call.
    const provider = await getProvider(swapChain);
    const connectedSigner = this.baseSigner.connect(provider);
    const targetContract = new Contract(quote.transaction.to, [], connectedSigner);
    const amountReadable = fromWei(amount, sourceTokenInfo.decimals);
    const txHash = await this._submitTransaction({
      contract: targetContract,
      chainId: swapChain,
      method: "",
      args: [quote.transaction.data],
      value: quote.transaction.value ? BigNumber.from(quote.transaction.value) : undefined,
      nonMulticall: true,
      unpermissioned: false,
      message: `Swap ${amountReadable} ${sourceToken} -> ${destinationToken} on ${getNetworkName(swapChain)}`,
      mrkdwn: `Swap ${amountReadable} ${sourceToken} -> ${destinationToken} on ${getNetworkName(swapChain)}`,
    });
    this.logger.info({
      at: "MatchaSwapAdapter._submitSwapWithValidation",
      message: `🎰 Submitted swap tx ${txHash} for ${amountReadable} ${sourceToken} -> ${destinationToken} on ${getNetworkName(swapChain)}`,
      txHash,
      buyAmount: quote.buyAmount,
      minBuyAmount: quote.minBuyAmount,
    });
    return txHash;
  }

  /**
   * Parses ERC20 Transfer events from a swap receipt to determine the exact amount of
   * destination token received by the wallet. This avoids bridging the full wallet balance
   * which could include unrelated funds.
   */
  private _getSwapOutputFromReceipt(receipt: ethers.providers.TransactionReceipt, destTokenAddress: string): BigNumber {
    const erc20Interface = new ethers.utils.Interface(ERC20.abi);
    const transferTopic = erc20Interface.getEventTopic("Transfer");
    const walletAddress = this.baseSignerAddress.toNative().toLowerCase();

    let totalReceived = bnZero;
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === destTokenAddress.toLowerCase() &&
        log.topics[0] === transferTopic &&
        log.topics.length >= 3
      ) {
        const toAddress = ethers.utils.defaultAbiCoder.decode(["address"], log.topics[2])[0] as string;
        if (toAddress.toLowerCase() === walletAddress) {
          const amount = BigNumber.from(log.data);
          totalReceived = totalReceived.add(amount);
        }
      }
    }
    return totalReceived;
  }

  // Redis helpers for storing/retrieving the swap tx hash alongside order details.

  private _redisSwapTxHashKey(cloid: string): string {
    return `${this.REDIS_PREFIX}swap-tx-hash:${cloid}`;
  }

  private async _redisSaveSwapTxHash(cloid: string, txHash: string): Promise<void> {
    const key = this._redisSwapTxHashKey(cloid);
    await this.redisCache.set(
      key,
      txHash,
      process.env.REBALANCER_PENDING_ORDER_TTL ? Number(process.env.REBALANCER_PENDING_ORDER_TTL) : 60 * 60
    );
  }

  private async _redisGetSwapTxHash(cloid: string): Promise<string | undefined> {
    const key = this._redisSwapTxHashKey(cloid);
    return await this.redisCache.get<string>(key);
  }
}
