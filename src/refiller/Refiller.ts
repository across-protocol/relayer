import winston from "winston";
import axios from "axios";
import { RefillerConfig, RefillBalanceData } from "./RefillerConfig";
import {
  Address,
  assert,
  BigNumber,
  blockExplorerLink,
  chainIsEvm,
  chainIsSvm,
  Contract,
  delay,
  ERC20,
  EvmAddress,
  formatUnits,
  getNativeTokenAddressForChain,
  getNativeTokenSymbol,
  getNetworkName,
  getRedisCache,
  getSolanaTokenBalance,
  getSvmProvider,
  getTokenInfo,
  mapAsync,
  parseUnits,
  runTransaction,
  sendRawTransaction,
  Signer,
  toAddressType,
  toBN,
  TOKEN_SYMBOLS_MAP,
  TransactionReceipt,
  WETH9,
  isDefined,
  chainIsL1,
  Provider,
  bnZero,
  getL1TokenAddress,
  CHAIN_IDs,
} from "../utils";
import { SWAP_ROUTES, SwapRoute, CUSTOM_BRIDGE, CANONICAL_BRIDGE } from "../common";
import ERC20_ABI from "../common/abi/MinimalERC20.json";
import { arch } from "@across-protocol/sdk";
import { AcrossSwapApiClient, BalanceAllocator, MultiCallerClient } from "../clients";
import { RedisCache } from "../caching/RedisCache";

export interface RefillerClients {
  balanceAllocator: BalanceAllocator;
  // We can further constrain the HubPoolClient type since we don't call any functions on it.
  hubPoolClient: { hubPool: Contract; chainId: number };
  multiCallerClient: MultiCallerClient;
}

/**
 * @notice This class is in charge of refilling native token balances for accounts running other bots, like the relayer and
 * dataworker. It is run with an account whose funds are used to refill balances for other accounts by either swapping
 * and transferring on the same chain or sending a cross chain swap.
 */
export class Refiller {
  private balanceCache: { [chainId: number]: { [token: string]: { [account: string]: BigNumber } } } = {};
  private decimals: { [chainId: number]: { [token: string]: number } } = {};
  private acrossSwapApiClient: AcrossSwapApiClient;
  private redisCache: RedisCache;
  private baseSigner: Signer;
  private baseSignerAddress: EvmAddress;
  private initialized = false;

  public constructor(
    readonly logger: winston.Logger,
    readonly config: RefillerConfig,
    readonly clients: RefillerClients
  ) {
    this.acrossSwapApiClient = new AcrossSwapApiClient(this.logger);
    this.baseSigner = this.clients.hubPoolClient.hubPool.signer;
  }

  /**
   * @notice One time initialization of the Refiller for any async operations.
   */
  async initialize(): Promise<void> {
    this.baseSignerAddress = EvmAddress.from(await this.baseSigner.getAddress());
    this.redisCache = (await getRedisCache(this.logger)) as RedisCache;
    this.initialized = true;
  }

  async refillBalances(): Promise<void> {
    assert(this.initialized, "not initialized, call initialize() first");
    const { refillEnabledBalances } = this.config;

    // Check for current balances.
    const currentBalances = await this._getBalances(refillEnabledBalances);
    const decimalValues = await this._getDecimals(refillEnabledBalances);
    this.logger.debug({
      at: "Refiller#refillBalances",
      message: "Checking token balances",
      currentBalances: refillEnabledBalances.map(({ chainId, token, account, target }, i) => {
        return {
          chainId,
          token: token.toNative(),
          account: account.toNative(),
          currentBalance: currentBalances[i].toString(),
          target: parseUnits(target.toString(), decimalValues[i]),
        };
      }),
    });
    await mapAsync(refillEnabledBalances, async (refillBalanceData, i) => {
      const { token, chainId } = refillBalanceData;
      const l2Provider = this.clients.balanceAllocator.providers[chainId];
      assert(l2Provider, `No L2 provider found for chain ${chainId}, have you overridden the spoke pool chains?`);
      let refillHandler;
      switch (token.toNative()) {
        case getNativeTokenAddressForChain(chainId).toNative():
          refillHandler = this.refillNativeTokenBalances;
          break;
        case TOKEN_SYMBOLS_MAP.USDH.addresses[CHAIN_IDs.HYPEREVM]:
          refillHandler = this.refillUsdh;
          break;
        default:
          refillHandler = this.refillTokenBalances;
      }
      return refillHandler.bind(this)(currentBalances[i], decimalValues[i], refillBalanceData, l2Provider);
    });
  }

  private async refillNativeTokenBalances(
    currentBalance: BigNumber,
    decimals: number,
    refillBalances: RefillBalanceData,
    l2Provider: Provider
  ): Promise<void> {
    const { chainId, isHubPool, token, account, target, trigger } = refillBalances;
    // Compare current balances with triggers and send tokens if signer has enough balance.

    const balanceTrigger = parseUnits(trigger.toString(), decimals);
    const isBelowTrigger = currentBalance.lte(balanceTrigger);
    if (!isBelowTrigger) {
      this.logger.debug({
        at: "Refiller#refillBalances",
        message: "Balance is above trigger",
        account,
        balanceTrigger,
        currentBalance: currentBalance.toString(),
        token,
        chainId,
      });
      return;
    }
    // Fill balance back to target, not trigger.
    const balanceTarget = parseUnits(target.toString(), decimals);
    // Deficit amount is in units of the output token.
    const deficit = balanceTarget.sub(currentBalance);
    const selfRefill = account.eq(this.baseSignerAddress);
    // If the account and the signer are the same, we can't transfer to ourselves so we need to try to go through
    // one of the `canRefill` paths below, which tries to source the `token` from other means, like unwrapping
    // WETH or sending a cross chain swap.
    let canRefill = selfRefill
      ? false
      : await this.clients.balanceAllocator.requestBalanceAllocation(chainId, [token], this.baseSignerAddress, deficit);
    if (!canRefill && chainIsEvm(chainId)) {
      const nativeTokenSymbol = getNativeTokenSymbol(chainId);
      // If token is the native token and the native token is ETH, try unwrapping some WETH into ETH first before
      // transferring ETH to the account.
      if (nativeTokenSymbol === "ETH") {
        this.logger.debug({
          at: "Refiller#refillNativeTokenBalances",
          message: `Balance of ETH below trigger on chain ${chainId} and account has insufficient ETH to transfer on chain, now trying to unwrap WETH to refill ETH`,
          chainId,
          currentBalance: currentBalance.toString(),
          trigger: balanceTrigger.toString(),
          balanceTarget: balanceTarget.toString(),
          deficit,
          account: this.baseSignerAddress,
        });
        const txn = await this._unwrapWethToRefill(chainId, deficit);
        if (txn) {
          this.logger.info({
            at: "Refiller#refillNativeTokenBalances",
            message: `Unwrapped WETH from ${this.baseSignerAddress} to refill ETH in ${account} 🎁!`,
            chainId,
            requiredUnwrapAmount: deficit.toString(),
            ethBalance: currentBalance.toString(),
            trigger: balanceTrigger.toString(),
            balanceTarget: balanceTarget.toString(),
            transactionHash: blockExplorerLink(txn.transactionHash, chainId),
          });
          // Don't return early and flip canRefill to true because we now have enough ETH to transfer to the account
          canRefill = true;
        } else {
          return;
        }
      } else if (isDefined(SWAP_ROUTES[chainId])) {
        // To refill other native tokens, we will first submit an async cross chain swap to receive the native token, and then on the next
        // run, the refill should be successful. Actual swap routes are currently determined by a hardcoded map from destination chain ID to
        // swap strategy.
        const swapRoute: SwapRoute = SWAP_ROUTES[chainId];
        this.logger.debug({
          at: "Refiller#refillNativeTokenBalances",
          message: `Balance of ${nativeTokenSymbol} below trigger on chain ${chainId} and account has insufficient ${nativeTokenSymbol} to transfer on chain, now trying to swap ${
            swapRoute.inputToken
          } from ${getNetworkName(swapRoute.originChainId)} to ${nativeTokenSymbol}`,
          swapRoute,
          currentBalance: currentBalance.toString(),
          trigger: balanceTrigger.toString(),
          balanceTarget: balanceTarget.toString(),
          deficit,
          account: this.baseSignerAddress,
        });
        const txn = await this._swapToRefill(swapRoute, deficit, EvmAddress.from(account.toEvmAddress()));
        if (txn) {
          this.logger.info({
            at: "Monitor#refillBalances",
            message: `Swapped ${swapRoute.inputToken} on ${getNetworkName(
              swapRoute.originChainId
            )} to ${nativeTokenSymbol} on ${getNetworkName(chainId)} for ${account} 🎁!`,
            transactionHash: blockExplorerLink(txn.transactionHash, swapRoute.originChainId),
            currentBalance: currentBalance.toString(),
            trigger: balanceTrigger.toString(),
            balanceTarget: balanceTarget.toString(),
            amount: deficit.toString(),
          });
        }
        // Return early now because the cross chain swap, successful or not, is async and we won't be able to
        // refill balances via a transfer() until the next bot iteration.
        return;
      }
    }

    // Now try to transfer native tokens from the base account to the target account on the same chain.
    if (canRefill && chainIsEvm(chainId)) {
      this.logger.debug({
        at: "Monitor#refillBalances",
        message: "Balance below trigger and can refill to target",
        from: this.baseSignerAddress,
        to: account.toEvmAddress(),
        balanceTrigger,
        balanceTarget,
        deficit,
        token: token.toEvmAddress(),
        chainId,
        isHubPool,
      });
      // There are three cases:
      // 1. The account is the HubPool. In which case we need to call a special function to load ETH into it.
      // 2. The account is not a HubPool and we want to load ETH.
      if (isHubPool) {
        // Note: We ignore the `token` if the account is HubPool because we can't call the method with other tokens.
        this.clients.multiCallerClient.enqueueTransaction({
          contract: this.clients.hubPoolClient.hubPool,
          chainId: this.clients.hubPoolClient.chainId,
          method: "loadEthForL2Calls",
          args: [],
          message: "Reloaded ETH in HubPool 🫡!",
          mrkdwn: `Loaded ${formatUnits(deficit, decimals)} ETH from ${this.baseSignerAddress}.`,
          value: deficit,
        });
      } else {
        const nativeSymbolForChain = getNativeTokenSymbol(chainId);
        // To send a raw transaction, we need to create a fake Contract instance at the recipient address and
        // set the method param to be an empty string.
        const sendRawTransactionContract = new Contract(
          account.toEvmAddress(),
          [],
          this.baseSigner.connect(l2Provider)
        );
        const txn = await (await sendRawTransaction(this.logger, sendRawTransactionContract, deficit)).wait();
        this.logger.info({
          at: "Refiller#refillBalances",
          message: `Reloaded ${formatUnits(deficit, decimals)} ${nativeSymbolForChain} for ${account} from ${
            this.baseSignerAddress
          } 🫡!`,
          transactionHash: blockExplorerLink(txn.transactionHash, chainId),
        });
      }
    } else {
      this.logger.warn({
        at: "Refiller#refillBalances",
        message: "Cannot refill balance to target",
        from: this.baseSignerAddress,
        to: account,
        currentBalance: currentBalance.toString(),
        balanceTrigger,
        balanceTarget,
        deficit,
        token,
        chainId,
      });
    }
  }

  private async refillTokenBalances(
    currentBalance: BigNumber,
    decimals: number,
    refillBalanceData: RefillBalanceData,
    l2Provider: Provider
  ): Promise<void> {
    const { chainId, token, account, target, trigger, refillPeriod = 10 * 60 } = refillBalanceData;
    assert(!chainIsL1(chainId), "Cannot refill mainnet non-native token balance.");
    const redisKey = `refill:${account.toNative()}->${chainId}-${token.toNative()}`;
    const isRefillProcessed = await this._isRefillProcessed(redisKey);
    if (isRefillProcessed) {
      return;
    }

    // Determine the amounts to bridge.
    const balanceTrigger = parseUnits(trigger.toString(), decimals);
    const isBelowTrigger = currentBalance.lte(balanceTrigger);
    if (!isBelowTrigger) {
      this.logger.debug({
        at: "Refiller#refillBalances",
        message: "Balance is above trigger",
        account,
        balanceTrigger,
        currentBalance: currentBalance.toString(),
        token,
        chainId,
      });
      return;
    }
    // Fill balance back to target, not trigger.
    const balanceTarget = parseUnits(target.toString(), decimals);
    // Deficit amount is in the output token, but in this case, input token == output token.
    const amount = balanceTarget.sub(currentBalance);

    // Construct a token bridge for the target token and build a transaction to send the l1 token to l2.
    const l1Token = getL1TokenAddress(token, chainId);
    const l2TokenInfo = getTokenInfo(token, chainId);
    const tokenBridgeConstructor = CUSTOM_BRIDGE[chainId]?.[l1Token.toNative()] ?? CANONICAL_BRIDGE[chainId];
    const tokenBridge = new tokenBridgeConstructor(
      chainId,
      this.clients.hubPoolClient.chainId,
      this.baseSigner,
      l2Provider,
      l1Token,
      this.logger
    );
    const {
      contract,
      method,
      args,
      value = bnZero,
    } = await tokenBridge.constructL1ToL2Txn(account, l1Token, token, amount);

    // Execute the l1 to l2 rebalance.
    let txn;
    try {
      txn = await (await runTransaction(this.logger, contract, method, args, value)).wait();
    } catch (error) {
      // Log the error and do not retry.
      this.logger.warn({
        at: "Refiller#refillBalances",
        message: `Failed to refill ${formatUnits(amount, decimals)} ${l2TokenInfo.symbol} for ${account} from ${
          this.baseSignerAddress
        }`,
        error,
      });
      return;
    }
    this.logger.info({
      at: "Refiller#refillBalances",
      message: `Reloaded ${formatUnits(amount, decimals)} ${l2TokenInfo.symbol} for ${account} from ${
        this.baseSignerAddress
      } 🫡!`,
      transactionHash: blockExplorerLink(txn.transactionHash, chainId),
    });
    await this.redisCache.set(redisKey, "true", refillPeriod);
  }

  private async _unwrapWethToRefill(chainId: number, amount: BigNumber): Promise<TransactionReceipt | undefined> {
    const weth = new Contract(
      TOKEN_SYMBOLS_MAP.WETH.addresses[chainId],
      WETH9.abi,
      this.baseSigner.connect(this.clients.balanceAllocator.providers[chainId])
    );
    const hasSufficientWethBalance = await this.clients.balanceAllocator.requestBalanceAllocation(
      chainId,
      [toAddressType(weth.address, chainId)],
      this.baseSignerAddress,
      amount
    );
    if (hasSufficientWethBalance) {
      return await (await runTransaction(this.logger, weth, "withdraw", [amount])).wait();
    } else {
      this.logger.warn({
        at: "Refiller#refillNativeTokenBalances",
        message: `Trying to unwrap WETH balance from ${this.baseSignerAddress} to use for refilling ETH but not enough WETH to unwrap`,
        chainId,
        requiredUnwrapAmount: amount.toString(),
        wethAddress: weth.address,
        account: this.baseSignerAddress,
      });
    }
  }

  private async refillUsdh(currentBalance: BigNumber, decimals: number): Promise<void> {
    // If either the apiUrl or apiKey is undefined, then return, since we can't do anything.
    if (!isDefined(this.config.nativeMarketsApiConfig)) {
      this.logger.warn({
        at: "Refiller#refillUsdh",
        message: "Native markets api key and base URL are missing from .env. Unable to rebalance USDH.",
      });
      return;
    }
    const { apiUrl: nativeMarketsApiUrl, apiKey: nativeMarketsApiKey } = this.config.nativeMarketsApiConfig;
    const headers = {
      "Api-Version": "2025-11-01",
      "Content-Type": "application/json",
      Authorization: `Bearer ${nativeMarketsApiKey}`,
    };
    const day = 24 * 60 * 60;

    // First, get the address ID of the base signer, which is used to determine the deposit address for Arb -> HyperEVM transfers.
    let addressId;
    // If we have the address ID for the base signer and token combo in cache, then do not request it from native markets.
    const addressIdCacheKey = `nativeMarketsAddressId:${this.baseSignerAddress.toNative()}`;
    const addressIdCache = await this.redisCache.get(addressIdCacheKey);
    if (isDefined(addressIdCache)) {
      addressId = addressIdCache;
    } else {
      const { data: registeredAddresses } = await axios.get(`${nativeMarketsApiUrl}/addresses`, { headers });
      addressId = registeredAddresses.items.find(
        ({ chain, token, address_hex }) =>
          chain === "hyper_evm" && token === "usdh" && address_hex === this.baseSignerAddress.toNative()
      )?.id;
      // In the event the address is not currently available, create a new one by posting to the native markets API.
      if (!isDefined(addressId)) {
        const newAddressIdData = {
          address: this.baseSignerAddress.toNative(),
          chain: "hyper_evm",
          name: "across-refiller-test",
          token: "usdh",
        };

        this.logger.info({
          at: "Refiller#refillNativeTokenBalances",
          message: `Address ${this.baseSignerAddress.toNative()} is not registered in the native markets API. Creating new address ID.`,
          address: this.baseSignerAddress.toNative(),
        });
        const { data: _addressId } = await axios.post(`${nativeMarketsApiUrl}/addresses`, newAddressIdData, {
          headers,
        });
        addressId = _addressId.id;
      }
      await this.redisCache.set(addressIdCacheKey, addressId, 7 * day);
    }

    // Next, get the transfer route deposit address on Arbitrum.
    const { data: transferRoutes } = await axios.get(`${nativeMarketsApiUrl}/transfer_routes`, { headers });
    let availableTransferRoute = transferRoutes.items
      .filter((route) => isDefined(route.source_address))
      .find(
        ({ source_address, destination_address }) =>
          source_address.chain === "arbitrum" &&
          source_address.token === "usdc" &&
          destination_address.address_hex === this.baseSignerAddress.toNative()
      );
    // Once again, if the transfer route is not defined, then create a new one by querying the native markets API.
    if (!isDefined(availableTransferRoute)) {
      const newTransferRouteData = {
        destination_address_id: addressId,
        name: "Arbitrum USDC -> HyperEVM USDH",
        source_currency: "usdc",
        source_payment_rail: "arbitrum",
      };

      this.logger.info({
        at: "Refiller#refillNativeTokenBalances",
        message: `Address ID ${addressId} does not have an Arbitrum USDC -> HyperEVM USDH transfer route configured. Creating a new route.`,
        address: this.baseSignerAddress.toNative(),
        addressId,
      });
      const { data: _availableTransferRoute } = await axios.post(
        `${nativeMarketsApiUrl}/transfer_routes`,
        newTransferRouteData,
        {
          headers,
        }
      );
      availableTransferRoute = _availableTransferRoute;
    }

    // Create the transfer transaction.
    const srcProvider = this.clients.balanceAllocator.providers[CHAIN_IDs.ARBITRUM];
    const usdc = new Contract(
      TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.ARBITRUM],
      ERC20_ABI,
      this.baseSigner.connect(srcProvider)
    );
    // By default, sweep the entire USDC balance of the base signer to HyperEVM USDH.
    const amountToTransfer = await usdc.balanceOf(this.baseSignerAddress.toNative());

    if (amountToTransfer.gt(this.config.minUsdhRebalanceAmount)) {
      this.clients.multiCallerClient.enqueueTransaction({
        contract: usdc,
        chainId: CHAIN_IDs.ARBITRUM,
        method: "transfer",
        args: [availableTransferRoute.source_address.address_hex, amountToTransfer],
        message: "Rebalanced Arbitrum USDC to HyperEVM USDH",
        nonMulticall: true,
        mrkdwn: `Sent ${formatUnits(amountToTransfer, decimals)} USDC from Arbitrum to HyperEVM.`,
      });
    }
  }

  private async _swapToRefill(
    swapRoute: SwapRoute,
    amount: BigNumber,
    recipient: EvmAddress
  ): Promise<TransactionReceipt | undefined> {
    const redisKey = `acrossSwap:${swapRoute.originChainId}-${swapRoute.inputToken.toNative()}->${
      swapRoute.destinationChainId
    }-${swapRoute.outputToken.toNative()}`;
    const isRefillProcessed = await this._isRefillProcessed(redisKey);
    if (isRefillProcessed) {
      return;
    }
    assert(
      this.clients.balanceAllocator.providers[swapRoute.originChainId],
      `No L2 provider found for chain ${swapRoute.originChainId}, have you overridden the spoke pool chains?`
    );
    const originSigner = this.baseSigner.connect(this.clients.balanceAllocator.providers[swapRoute.originChainId]);
    const approval = await this.acrossSwapApiClient.getApproval(swapRoute, amount, this.baseSignerAddress, recipient);
    if (approval) {
      const txnReceipt = await sendRawTransaction(
        this.logger,
        new Contract(approval.target.toNative(), [], originSigner),
        approval.value,
        approval.calldata
      );
      this.logger.info({
        at: "Monitor#refillBalances",
        message: "Submitted approval transaction for swap route.",
        transaction: blockExplorerLink(txnReceipt.hash, swapRoute.originChainId),
        swapRoute,
        swapper: this.baseSignerAddress,
      });
      await delay(1);
      await txnReceipt.wait();
    }

    const swapData = await this.acrossSwapApiClient.swapWithRoute(swapRoute, amount, this.baseSignerAddress, recipient);
    if (!swapData) {
      // swapData will be undefined if the transaction simulation fails on the Across Swap API side, which
      // can happen if the swapper doesn't have enough swap input token balance in addition to other
      // miscellaneous reasons.
      this.logger.warn({
        at: "Monitor#refillBalances",
        message: `Failed to execute swap route on ${getNetworkName(swapRoute.originChainId)}`,
        swapRoute,
        amount,
        swapper: this.baseSignerAddress,
        recipient: recipient.toEvmAddress(),
      });
      return;
    }
    const txn = await (
      await sendRawTransaction(
        this.logger,
        new Contract(swapData.target.toNative(), [], originSigner),
        swapData.value,
        swapData.calldata
      )
    ).wait();
    // Cache the swap for 10 minutes
    // @todo Consider caching for some time relative to the estimated fill time returned by API, but
    // 10 minutes is a reasonable conservative value to avoid duplicate swaps.
    const ttl = 10 * 60;
    await this.redisCache.set(redisKey, "true", ttl);
    this.logger.debug({
      at: "Monitor#refillBalances",
      message: `Cached swap for ${redisKey}`,
      ttl,
    });
    return txn;
  }

  private async _getBalances(balanceRequests: BalanceRequest[]): Promise<BigNumber[]> {
    return await Promise.all(
      balanceRequests.map(async ({ chainId, token, account }) => {
        if (this.balanceCache[chainId]?.[token.toBytes32()]?.[account.toBytes32()]) {
          return this.balanceCache[chainId][token.toBytes32()][account.toBytes32()];
        }
        if (chainIsEvm(chainId)) {
          const gasTokenAddressForChain = getNativeTokenAddressForChain(chainId);
          const provider = this.clients.balanceAllocator.providers[chainId];
          const balance = token.eq(gasTokenAddressForChain)
            ? await provider.getBalance(account.toEvmAddress())
            : await new Contract(token.toEvmAddress(), ERC20.abi, provider).balanceOf(account.toEvmAddress());
          this.balanceCache[chainId] ??= {};
          this.balanceCache[chainId][token.toBytes32()] ??= {};
          this.balanceCache[chainId][token.toBytes32()][account.toBytes32()] = balance;
          return balance;
        }
        // Assert balance request has solana types.
        assert(chainIsSvm(chainId));
        assert(token.isSVM());
        assert(account.isSVM());
        const provider = getSvmProvider(await getRedisCache());
        if (!token.eq(getNativeTokenAddressForChain(chainId))) {
          return getSolanaTokenBalance(provider, token, account);
        } else {
          const balanceInLamports = await provider.getBalance(arch.svm.toAddress(account)).send();
          return toBN(Number(balanceInLamports.value));
        }
      })
    );
  }

  private async _getDecimals(decimalrequests: { chainId: number; token: Address }[]): Promise<number[]> {
    return await Promise.all(
      decimalrequests.map(async ({ chainId, token }) => {
        const gasTokenAddressForChain = getNativeTokenAddressForChain(chainId);
        if (token.eq(gasTokenAddressForChain)) {
          return chainIsEvm(chainId) ? 18 : 9;
        } // Assume all EVM chains have 18 decimal native tokens.
        if (this.decimals[chainId]?.[token.toBytes32()]) {
          return this.decimals[chainId][token.toBytes32()];
        }
        let decimals: number;
        if (chainIsEvm(chainId)) {
          const provider = this.baseSigner.connect(this.clients.balanceAllocator.providers[chainId]);
          decimals = await new Contract(token.toEvmAddress(), ERC20.abi, provider).decimals();
        } else {
          decimals = getTokenInfo(token, chainId).decimals;
        }
        if (!this.decimals[chainId]) {
          this.decimals[chainId] = {};
        }
        if (!this.decimals[chainId][token.toBytes32()]) {
          this.decimals[chainId][token.toBytes32()] = decimals;
        }
        return decimals;
      })
    );
  }

  private async _isRefillProcessed(redisKey: string): Promise<boolean> {
    const pendingSwap = await this.redisCache.get(redisKey);
    if (pendingSwap) {
      const ttl = await this.redisCache.ttl(redisKey);
      this.logger.debug({
        at: "Refiller#refillNativeTokenBalances",
        message: `Found pending swap in cache with key ${redisKey}, avoiding new swap`,
        ttl,
      });
      return true;
    }
    return false;
  }
}

type BalanceRequest = { chainId: number; token: Address; account: Address };
