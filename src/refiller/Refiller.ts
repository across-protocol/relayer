import winston from "winston";
import { RefillerConfig } from "./RefillerConfig";
import {
  Address,
  assert,
  BigNumber,
  blockExplorerLink,
  CHAIN_IDs,
  chainIsEvm,
  chainIsSvm,
  Contract,
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
  ZERO_ADDRESS,
} from "../utils";
import { arch } from "@across-protocol/sdk";
import { AcrossSwapApiClient, BalanceAllocator, HubPoolClient, MultiCallerClient } from "../clients";
import { RedisCache } from "../caching/RedisCache";

export interface RefillerClients {
  balanceAllocator: BalanceAllocator;
  hubPoolClient: HubPoolClient;
  multiCallerClient: MultiCallerClient;
}

type SwapRoute = {
  inputToken: EvmAddress;
  outputToken: EvmAddress;
  originChainId: number;
  destinationChainId: number;
};
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

  async refillNativeTokenBalances(): Promise<void> {
    assert(this.initialized, "not initialized, call initialize() first");
    const { refillEnabledBalances } = this.config;

    // Check for current balances.
    const currentBalances = await this._getBalances(refillEnabledBalances);
    const decimalValues = await this._getDecimals(refillEnabledBalances);
    this.logger.debug({
      at: "Refiller#refillNativeTokenBalances",
      message: "Checking native token balances",
      currentBalances: refillEnabledBalances.map(({ chainId, token, account, target }, i) => {
        return {
          chainId,
          token: token.toEvmAddress(),
          account: account.toEvmAddress(),
          currentBalance: currentBalances[i].toString(),
          target: parseUnits(target.toString(), decimalValues[i]),
        };
      }),
    });

    // Compare current balances with triggers and send tokens if signer has enough balance.
    await mapAsync(refillEnabledBalances, async ({ chainId, isHubPool, token, account, target, trigger }, i) => {
      assert(token.eq(getNativeTokenAddressForChain(chainId)), "Token must be the native token");
      const l2Provider = this.clients.balanceAllocator.providers[chainId];
      assert(l2Provider, `No L2 provider found for chain ${chainId}, have you overridden the spoke pool chains?`);

      const currentBalance = currentBalances[i];
      const decimals = decimalValues[i];
      const balanceTrigger = parseUnits(trigger.toString(), decimals);
      const isBelowTrigger = currentBalance.lte(balanceTrigger);
      if (isBelowTrigger) {
        // Fill balance back to target, not trigger.
        const balanceTarget = parseUnits(target.toString(), decimals);
        const deficit = balanceTarget.sub(currentBalance);
        const selfRefill = account.eq(this.baseSignerAddress);
        // If the account and the signer are the same, we can't transfer to ourselves so we need to try to go through
        // one of the `canRefill` paths below, which tries to source the `token` from other means, like unwrapping
        // WETH or sending a cross chain swap.
        let canRefill = selfRefill
          ? false
          : await this.clients.balanceAllocator.requestBalanceAllocation(
              chainId,
              [token],
              this.baseSignerAddress,
              deficit
            );
        if (!canRefill && chainIsEvm(chainId)) {
          // If token is the native token and the native token is ETH, try unwrapping some WETH into ETH first before
          // transferring ETH to the account.
          if (getNativeTokenSymbol(chainId) === "ETH") {
            this.logger.debug({
              at: "Refiller#refillNativeTokenBalances",
              message: `Balance of ETH below trigger on chain ${chainId} and account has insufficient ETH to transfer on chain, now trying to unwrap WETH to refill ETH`,
              chainId,
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
                transactionHash: blockExplorerLink(txn.transactionHash, chainId),
              });
              // Don't return early and flip canRefill to true because we now have enough ETH to transfer to the account
              canRefill = true;
            } else {
              return;
            }
          } else if (getNativeTokenSymbol(chainId) === "MATIC") {
            // To refill MATIC, we will first submit an async cross chain swap to receive MATIC, and then on the next
            // run, the refill should be successful. By default we will swap ETH on Arbitrum to MATIC on Polygon because
            // bridging from Arbitrum is fast, and we tend to accumulate ETH on Arbitrum because its refunded for
            // each L1->Arbitrum message we initiate.
            const swapRoute: SwapRoute = {
              // @dev When calling the Swap API, the ZERO_ADDRESS is associated with the native gas token, even if
              // the native token address is not actually ZERO_ADDRESS.
              inputToken: EvmAddress.from(ZERO_ADDRESS),
              outputToken: EvmAddress.from(ZERO_ADDRESS),
              originChainId: CHAIN_IDs.ARBITRUM,
              destinationChainId: chainId,
            };
            this.logger.debug({
              at: "Refiller#refillNativeTokenBalances",
              message: `Balance of MATIC below trigger on chain ${chainId} and account has insufficient MATIC to transfer on chain, now trying to swap ETH from ${getNetworkName(
                swapRoute.originChainId
              )} to MATIC`,
              swapRoute,
              deficit,
              account: this.baseSignerAddress,
            });
            const txn = await this._swapEthToMaticToRefill(swapRoute, deficit, EvmAddress.from(account.toEvmAddress()));
            if (txn) {
              this.logger.info({
                at: "Monitor#refillBalances",
                message: `Swapped ETH on ${getNetworkName(
                  swapRoute.originChainId
                )} to MATIC on Polygon for ${account} 🎁!`,
                transactionHash: blockExplorerLink(txn.transactionHash, swapRoute.originChainId),
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
      } else {
        this.logger.debug({
          at: "Refiller#refillBalances",
          message: "Balance is above trigger",
          account,
          balanceTrigger,
          currentBalance: currentBalance.toString(),
          token,
          chainId,
        });
      }
    });
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
      return;
    }
  }

  private async _swapEthToMaticToRefill(
    swapRoute: SwapRoute,
    amount: BigNumber,
    recipient: EvmAddress
  ): Promise<TransactionReceipt | undefined> {
    const redisKey = `acrossSwap:${swapRoute.originChainId}-${swapRoute.inputToken.toNative()}->${
      swapRoute.destinationChainId
    }-${swapRoute.outputToken.toNative()}`;
    const pendingSwap = await this.redisCache.get(redisKey);
    if (pendingSwap) {
      const ttl = await this.redisCache.ttl(redisKey);
      this.logger.debug({
        at: "Refiller#refillNativeTokenBalances",
        message: `Found pending swap in cache with key ${redisKey}, avoiding new swap`,
        ttl,
      });
      return;
    }
    assert(
      this.clients.balanceAllocator.providers[swapRoute.originChainId],
      `No L2 provider found for chain ${swapRoute.originChainId}, have you overridden the spoke pool chains?`
    );
    const originSigner = this.baseSigner.connect(this.clients.balanceAllocator.providers[swapRoute.originChainId]);
    const swapData = await this.acrossSwapApiClient.swapExactOutput(
      swapRoute,
      amount,
      this.baseSignerAddress,
      recipient
    );
    if (swapData) {
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
    } else {
      // swapData will be undefined if the transaction simulation fails on the Across Swap API side, which
      // can happen if the swapper doesn't have enough swap input token balance in addition to other
      // miscellaneous reasons.
      this.logger.warn({
        at: "Monitor#refillBalances",
        message: `Failed to swap ETH on ${getNetworkName(swapRoute.originChainId)} to MATIC on Polygon`,
        swapRoute,
        amount,
        swapper: this.baseSignerAddress,
        recipient: recipient.toEvmAddress(),
      });
    }
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
}

type BalanceRequest = { chainId: number; token: Address; account: Address };
