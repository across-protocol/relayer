import { getAcrossHost } from "../../clients/AcrossAPIClient";
import {
  ERC20,
  BigNumber,
  Contract,
  EvmAddress,
  PriceClient,
  Provider,
  acrossApi,
  assert,
  bnZero,
  coingecko,
  defiLlama,
  ethers,
  formatUnits,
  getGasPrice as getOracleGasPrice,
  getNativeTokenInfoForChain,
  getProvider,
  getTokenInfo,
  getTokenInfoFromSymbol,
  isDefined,
  mapAsync,
  toBNWei,
  truncate,
  winston,
} from "../../utils";
import {
  DEFAULT_HUB_POOL_CHAIN_ID,
  GAS_COST_AVERAGE_LOOKBACK_SECONDS,
  GAS_COST_AVERAGE_SAMPLE_WINDOWS,
  GAS_COST_AVERAGE_WINDOW_BLOCKS,
  GAS_COST_BLOCK_TIME_SAMPLE_BLOCKS,
  GAS_COST_PRIORITY_FEE_PERCENTILE,
  GAS_UNITS_BY_FAMILY,
  MIN_GAS_COST_BLOCK_TIME_SECONDS,
  STABLECOIN_PRICE_USD,
  TOKEN_METADATA_OVERRIDES,
} from "../constants";
import type { EdgeFamily, JussiGasPriceDiagnostic, LogicalAsset, ResolvedGasPrice } from "../types";

export class RuntimePricingContext {
  private readonly priceClient: PriceClient;
  private readonly gasPriceCache = new Map<number, Promise<ResolvedGasPrice>>();
  private readonly nativePriceCache = new Map<number, Promise<number>>();
  private readonly logicalAssetPriceCache = new Map<LogicalAsset, Promise<number>>();
  private readonly tokenPriceCache = new Map<string, Promise<number>>();
  private readonly tokenDecimalsCache = new Map<string, Promise<number>>();

  constructor(
    readonly logger: winston.Logger,
    readonly hubPoolChainId = DEFAULT_HUB_POOL_CHAIN_ID
  ) {
    this.priceClient = new PriceClient(logger, [
      new acrossApi.PriceFeed({ host: getAcrossHost(hubPoolChainId) }),
      new coingecko.PriceFeed({ apiKey: process.env.COINGECKO_PRO_API_KEY }),
      new defiLlama.PriceFeed(),
    ]);
  }

  async deriveGasCostUsd(family: EdgeFamily, chainId: number): Promise<number> {
    const gasUnits = GAS_UNITS_BY_FAMILY[family];
    const { gasPriceWei } = await this.getResolvedGasPrice(chainId);
    const nativePriceUsd = await this.getNativeTokenPriceUsd(chainId);
    const nativeTokenInfo = getNativeTokenInfoForChain(chainId, this.hubPoolChainId);
    const gasCostNative = gasPriceWei.mul(gasUnits);
    return parseFloat(formatUnits(gasCostNative, nativeTokenInfo.decimals)) * nativePriceUsd;
  }

  async describeGasPrices(chainIds: number[]): Promise<JussiGasPriceDiagnostic[]> {
    const uniqueChainIds = Array.from(new Set(chainIds)).sort((a, b) => a - b);
    return mapAsync(uniqueChainIds, async (chainId) => {
      const resolvedGasPrice = await this.getResolvedGasPrice(chainId);
      return {
        chainId,
        gasPriceGwei: formatUnits(resolvedGasPrice.gasPriceWei, "gwei"),
        source: resolvedGasPrice.source,
      };
    });
  }

  async nativeValueToUsd(value: BigNumber, chainId: number): Promise<number> {
    if (!value.gt(bnZero)) {
      return 0;
    }
    const nativeTokenInfo = getNativeTokenInfoForChain(chainId, this.hubPoolChainId);
    const nativePriceUsd = await this.getNativeTokenPriceUsd(chainId);
    return parseFloat(formatUnits(value, nativeTokenInfo.decimals)) * nativePriceUsd;
  }

  async tokenValueToUsd(value: BigNumber, chainId: number, tokenAddress: string): Promise<number> {
    if (!value.gt(bnZero)) {
      return 0;
    }

    const [decimals, tokenPriceUsd] = await Promise.all([
      this.getTokenDecimals(chainId, tokenAddress),
      this.getTokenPriceUsd(chainId, tokenAddress),
    ]);
    return parseFloat(formatUnits(value, decimals)) * tokenPriceUsd;
  }

  async usdToNativeValue(usdValue: number, chainId: number): Promise<BigNumber> {
    if (!(usdValue > 0)) {
      return bnZero;
    }
    const nativeTokenInfo = getNativeTokenInfoForChain(chainId, this.hubPoolChainId);
    const nativePriceUsd = await this.getNativeTokenPriceUsd(chainId);
    assert(nativePriceUsd > 0, `Resolved non-positive native token price for ${chainId}`);
    const nativeAmount = usdValue / nativePriceUsd;
    return toBNWei(truncate(nativeAmount, nativeTokenInfo.decimals).toString(), nativeTokenInfo.decimals);
  }

  async getLogicalAssetPriceUsd(logicalAsset: LogicalAsset): Promise<number> {
    if (logicalAsset === "USDC" || logicalAsset === "USDT") {
      return STABLECOIN_PRICE_USD[logicalAsset];
    }
    return this.loadCachedValue(this.logicalAssetPriceCache, logicalAsset, async () => {
      const tokenInfo = getTokenInfoFromSymbol(logicalAsset, this.hubPoolChainId);
      const { price } = await this.priceClient.getPriceByAddress(tokenInfo.address.toNative());
      const priceUsd = Number(price);
      assert(
        Number.isFinite(priceUsd) && priceUsd > 0,
        `Resolved non-positive or non-finite USD price for logical asset ${logicalAsset}: ${priceUsd}`
      );
      return priceUsd;
    });
  }

  private getResolvedGasPrice(chainId: number): Promise<ResolvedGasPrice> {
    return this.loadCachedValue(this.gasPriceCache, chainId, async () => {
      const provider = await getProvider(chainId);
      try {
        const averageGasPrice = await this.deriveAverageGasPrice(provider);
        assert(
          isDefined(averageGasPrice) && averageGasPrice.gt(bnZero),
          `Resolved non-positive gas price for ${chainId}`
        );
        return { gasPriceWei: averageGasPrice, source: "24h_avg" };
      } catch (error) {
        this.logger.warn({
          at: "buildGraph.RuntimePricingContext.getGasPrice",
          message: "Failed to query 24h average gas price, falling back to current gasPriceOracle estimate",
          chainId,
          error: error instanceof Error ? error.message : String(error),
        });
        const feeData = await getOracleGasPrice(provider, 1, 1);
        const resolved = feeData.maxFeePerGas ?? feeData.maxPriorityFeePerGas;
        assert(
          isDefined(resolved) && resolved.gt(bnZero),
          `Gas price oracle returned no usable gas price for ${chainId}`
        );
        return { gasPriceWei: resolved, source: "fallback_current_oracle" };
      }
    });
  }

  private async deriveAverageGasPrice(provider: Provider): Promise<BigNumber> {
    const latestBlock = await provider.getBlock("latest");
    assert(
      isDefined(latestBlock) && isDefined(latestBlock.number) && isDefined(latestBlock.timestamp),
      "Provider returned no latest block when deriving average gas price"
    );
    const oldestBlockNumber = await this.estimateLookbackStartBlockNumber(
      provider,
      latestBlock.number,
      latestBlock.timestamp
    );
    const sampleCount = Math.min(GAS_COST_AVERAGE_SAMPLE_WINDOWS, latestBlock.number - oldestBlockNumber + 1);
    const sampleBlocks = Array.from({ length: sampleCount }, (_, index) =>
      sampleCount === 1
        ? latestBlock.number
        : Math.round(oldestBlockNumber + ((latestBlock.number - oldestBlockNumber) * index) / (sampleCount - 1))
    );
    const samplePrices = await mapAsync(sampleBlocks, async (blockNumber) =>
      this.deriveWindowAverageGasPrice(provider, blockNumber)
    );
    const populatedSamplePrices = samplePrices.filter((price) => price.gt(bnZero));
    assert(populatedSamplePrices.length > 0, "No positive gas price samples returned from fee history");
    return populatedSamplePrices.reduce((sum, price) => sum.add(price), bnZero).div(populatedSamplePrices.length);
  }

  private async estimateLookbackStartBlockNumber(
    provider: Provider,
    latestBlockNumber: number,
    latestBlockTimestamp: number
  ): Promise<number> {
    if (latestBlockNumber <= 0) {
      return 0;
    }

    const sampledBlockDistance = Math.max(1, Math.min(GAS_COST_BLOCK_TIME_SAMPLE_BLOCKS, latestBlockNumber));
    const sampledBlockNumber = latestBlockNumber - sampledBlockDistance;
    const sampledBlock = await provider.getBlock(sampledBlockNumber);
    assert(
      isDefined(sampledBlock) && isDefined(sampledBlock.timestamp),
      `Provider returned no block data for block ${sampledBlockNumber}`
    );
    const elapsedSeconds = Math.max(1, latestBlockTimestamp - sampledBlock.timestamp);
    const estimatedSecondsPerBlock = Math.max(MIN_GAS_COST_BLOCK_TIME_SECONDS, elapsedSeconds / sampledBlockDistance);
    const estimatedLookbackBlocks = Math.ceil(GAS_COST_AVERAGE_LOOKBACK_SECONDS / estimatedSecondsPerBlock);
    return Math.max(0, latestBlockNumber - estimatedLookbackBlocks);
  }

  private async deriveWindowAverageGasPrice(provider: Provider, blockNumber: number): Promise<BigNumber> {
    const blockCount = Math.max(1, Math.min(GAS_COST_AVERAGE_WINDOW_BLOCKS, blockNumber + 1));
    const rpcProvider = provider as Provider & {
      send(
        method: string,
        params: unknown[]
      ): Promise<{
        baseFeePerGas?: string[];
        reward?: string[][];
      }>;
    };
    const feeHistory = await rpcProvider.send("eth_feeHistory", [
      ethers.utils.hexValue(blockCount),
      ethers.utils.hexValue(blockNumber),
      [GAS_COST_PRIORITY_FEE_PERCENTILE],
    ]);
    const sampleCount = Math.min(blockCount, Math.max((feeHistory.baseFeePerGas?.length ?? 0) - 1, 0));
    let totalGasPrice = bnZero;
    let countedSamples = 0;

    for (let index = 0; index < sampleCount; index += 1) {
      const baseFeePerGas = BigNumber.from(feeHistory.baseFeePerGas?.[index] ?? "0");
      const priorityFeePerGas = BigNumber.from(feeHistory.reward?.[index]?.[0] ?? "0");
      const gasPrice = baseFeePerGas.add(priorityFeePerGas);
      if (!gasPrice.gt(bnZero)) {
        continue;
      }
      totalGasPrice = totalGasPrice.add(gasPrice);
      countedSamples += 1;
    }

    if (countedSamples > 0) {
      return totalGasPrice.div(countedSamples);
    }

    const fallbackGasPrice = await provider.getGasPrice();
    assert(fallbackGasPrice.gt(bnZero), `Provider returned no usable legacy gas price for block ${blockNumber}`);
    return fallbackGasPrice;
  }

  private getNativeTokenPriceUsd(chainId: number): Promise<number> {
    return this.loadCachedValue(this.nativePriceCache, chainId, async () => {
      try {
        const nativeTokenInfo = getNativeTokenInfoForChain(chainId, this.hubPoolChainId);
        const price = await this.priceClient.getPriceByAddress(nativeTokenInfo.address);
        return Number(price.price);
      } catch (error) {
        this.logger.warn({
          at: "buildGraph.RuntimePricingContext.getNativeTokenPriceUsd",
          message: "Failed to query native token USD price, using $1 fallback",
          chainId,
          error: error instanceof Error ? error.message : String(error),
        });
        return 1;
      }
    });
  }

  private getTokenDecimals(chainId: number, tokenAddress: string): Promise<number> {
    const cacheKey = `${chainId}:${tokenAddress.toLowerCase()}`;
    return this.loadCachedValue(this.tokenDecimalsCache, cacheKey, async () => {
      const metadataOverride = TOKEN_METADATA_OVERRIDES[cacheKey];
      if (isDefined(metadataOverride)) {
        return metadataOverride.decimals;
      }
      try {
        return getTokenInfo(EvmAddress.from(tokenAddress), chainId).decimals;
      } catch {
        const provider = await getProvider(chainId);
        const token = new Contract(tokenAddress, ERC20.abi, provider);
        return Number(await token.decimals());
      }
    });
  }

  private getTokenPriceUsd(chainId: number, tokenAddress: string): Promise<number> {
    const cacheKey = `${chainId}:${tokenAddress.toLowerCase()}`;
    return this.loadCachedValue(this.tokenPriceCache, cacheKey, async () => {
      const metadataOverride = TOKEN_METADATA_OVERRIDES[cacheKey];
      if (isDefined(metadataOverride)) {
        return metadataOverride.priceUsd;
      }
      try {
        const price = await this.priceClient.getPriceByAddress(tokenAddress);
        return Number(price.price);
      } catch (error) {
        this.logger.warn({
          at: "buildGraph.RuntimePricingContext.getTokenPriceUsd",
          message: "Failed to query token USD price, using $1 fallback",
          chainId,
          tokenAddress,
          error: error instanceof Error ? error.message : String(error),
        });
        return 1;
      }
    });
  }

  private loadCachedValue<K, T>(cache: Map<K, Promise<T>>, key: K, loader: () => Promise<T>): Promise<T> {
    const cached = cache.get(key);
    if (isDefined(cached)) {
      return cached;
    }
    const pending = loader().catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
    return pending;
  }
}
