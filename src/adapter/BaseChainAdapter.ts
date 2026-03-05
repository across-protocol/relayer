import { MultiCallerClient, SpokePoolClient, SpokePoolManager } from "../clients";
import {
  AnyObject,
  BigNumber,
  Contract,
  CHAIN_IDs,
  DefaultLogLevels,
  ERC20,
  EventSearchConfig,
  MakeOptional,
  PUBLIC_NETWORKS,
  Signer,
  TransactionResponse,
  assert,
  assign,
  createFormatFunction,
  formatUnitsForToken,
  getNetworkName,
  isDefined,
  matchTokenSymbol,
  toBN,
  winston,
  forEachAsync,
  filterAsync,
  mapAsync,
  getL1TokenAddress,
  getBlockForTimestamp,
  getTimestampForBlock,
  getCurrentTime,
  bnZero,
  Address,
  getNativeTokenSymbol,
  getWrappedNativeTokenAddress,
  stringifyThrownValue,
  ZERO_BYTES,
  isEVMSpokePoolClient,
  isSVMSpokePoolClient,
  EvmAddress,
  chainIsEvm,
  sendAndConfirmSolanaTransaction,
  getSvmProvider,
  submitTransaction,
} from "../utils";
import { AugmentedTransaction, TransactionClient } from "../clients/TransactionClient";
import {
  approveTokens,
  getTokenAllowanceFromCache,
  aboveAllowanceThreshold,
  setTokenAllowanceInCache,
  getL2TokenAllowanceFromCache,
  setL2TokenAllowanceInCache,
  TransferTokenParams,
} from "./utils";
import { BaseBridgeAdapter, BridgeEvent, BridgeTransactionDetails } from "./bridges/BaseBridgeAdapter";
import { FINALIZER_TOKENBRIDGE_LOOKBACK } from "../common/Constants";
import { OutstandingTransfers } from "../interfaces";
import WETH_ABI from "../common/abi/Weth.json";
import { BaseL2BridgeAdapter } from "./l2Bridges/BaseL2BridgeAdapter";
import { ExpandedERC20 } from "@across-protocol/sdk/typechain";

export type SupportedL1Token = EvmAddress;
export type SupportedTokenSymbol = string;

export class BaseChainAdapter {
  protected baseL1SearchConfig: MakeOptional<EventSearchConfig, "to">;
  protected baseL2SearchConfig: MakeOptional<EventSearchConfig, "to">;
  protected readonly spokePoolManager: SpokePoolManager;
  private transactionClient: TransactionClient;

  constructor(
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    protected readonly chainId: number,
    protected readonly hubChainId: number,
    protected readonly monitoredAddresses: Address[],
    protected readonly logger: winston.Logger,
    public readonly supportedTokens: SupportedTokenSymbol[],
    protected readonly bridges: { [l1Token: string]: BaseBridgeAdapter },
    protected readonly l2Bridges: { [l1Token: string]: BaseL2BridgeAdapter },
    protected readonly gasMultiplier: number
  ) {
    this.spokePoolManager = new SpokePoolManager(logger, spokePoolClients);
    this.baseL1SearchConfig = { ...this.getSearchConfig(this.hubChainId) };
    this.baseL2SearchConfig = { ...this.getSearchConfig(this.chainId) };
    this.transactionClient = new TransactionClient(logger);
  }

  public get adapterName(): string {
    return `${getNetworkName(this.chainId)}Adapter`;
  }

  protected log(message: string, data?: AnyObject, level: DefaultLogLevels = "debug", fnName?: string): void {
    const name = isDefined(fnName) ? `${this.adapterName}.${fnName}` : this.adapterName;
    this.logger[level]({ at: name, message, ...data });
  }

  protected getSearchConfig(chainId: number): MakeOptional<EventSearchConfig, "to"> {
    const spokePoolClient = this.spokePoolManager.getClient(chainId);
    if (!spokePoolClient) {
      throw new Error("spokePoolClient is undefined - cannot read eventSearchConfig");
    }

    return { ...spokePoolClient.eventSearchConfig };
  }

  protected getSigner(chainId: number): Signer {
    const spokePoolClient = this.spokePoolManager.getClient(chainId);
    assert(isDefined(spokePoolClient), `SpokePoolClient not found for chainId ${chainId}`);
    assert(isEVMSpokePoolClient(spokePoolClient));
    return spokePoolClient.spokePool.signer;
  }

  // Note: this must be called after the SpokePoolClients are updated.
  public getUpdatedSearchConfigs(): { l1SearchConfig: EventSearchConfig; l2SearchConfig: EventSearchConfig } {
    const l1SpokePoolClient = this.spokePoolManager.getClient(this.hubChainId);
    const l2SpokePoolClient = this.spokePoolManager.getClient(this.chainId);
    assert(isDefined(l1SpokePoolClient), `SpokePoolClient not found for chainId ${this.hubChainId}`);
    assert(isDefined(l2SpokePoolClient), `SpokePoolClient not found for chainId ${this.chainId}`);
    const l1LatestBlock = l1SpokePoolClient.latestHeightSearched;
    const l2LatestBlock = l2SpokePoolClient.latestHeightSearched;
    if (l1LatestBlock === 0 || l2LatestBlock === 0) {
      throw new Error("One or more SpokePoolClients have not been updated");
    }
    return {
      l1SearchConfig: {
        ...this.baseL1SearchConfig,
        to: this.baseL1SearchConfig?.to ?? l1LatestBlock,
      },
      l2SearchConfig: {
        ...this.baseL2SearchConfig,
        to: this.baseL2SearchConfig?.to ?? l2LatestBlock,
      },
    };
  }

  /**
   * Determine whether this adapter supports an l1 token address
   * @param l1Token an address
   * @returns True if l1Token is supported
   */
  isSupportedToken(l1Token: EvmAddress): l1Token is SupportedL1Token {
    const relevantSymbols = matchTokenSymbol(l1Token.toNative(), this.hubChainId);
    // if the symbol is not in the supported tokens list, it's not supported
    return relevantSymbols.some((symbol) => this.supportedTokens.includes(symbol));
  }

  isSupportedL2Bridge(l1Token: EvmAddress): boolean {
    return isDefined(this.l2Bridges[l1Token.toEvmAddress()]);
  }

  filterSupportedTokens(l1Tokens: EvmAddress[]): EvmAddress[] {
    return l1Tokens.filter((l1Token) => this.isSupportedToken(l1Token));
  }

  async checkTokenApprovals(l1Tokens: EvmAddress[]): Promise<void> {
    await Promise.all([this.checkL1TokenApprovals(l1Tokens), this.checkL2TokenApprovals(l1Tokens)]);
  }

  async checkL2TokenApprovals(l1Tokens: EvmAddress[]): Promise<void> {
    const tokensToApprove: { token: ExpandedERC20; bridges: Address[] }[] = [];
    const unavailableTokens: EvmAddress[] = [];

    await Promise.all(
      l1Tokens.map(async (l1Token) => {
        const l1TokenAddress = l1Token.toNative();
        const l2Bridge = this.l2Bridges[l1TokenAddress];

        if (!l2Bridge || !this.isSupportedToken(l1Token)) {
          unavailableTokens.push(l1Token);
          return;
        }

        const requiredApprovals = l2Bridge.requiredTokenApprovals();

        if (requiredApprovals.length === 0) {
          return;
        }

        await Promise.all(
          requiredApprovals.map(async ({ token: tokenAddress, bridge: bridgeAddress }) => {
            const erc20 = ERC20.connect(tokenAddress.toNative(), this.getSigner(this.chainId));
            const senderAddress = EvmAddress.from(await this.getSigner(this.chainId).getAddress());

            const cachedResult = await getL2TokenAllowanceFromCache(
              this.chainId,
              tokenAddress,
              senderAddress,
              bridgeAddress
            );
            const allowance =
              cachedResult ?? (await erc20.allowance(senderAddress.toNative(), bridgeAddress.toNative()));
            if (!isDefined(cachedResult) && aboveAllowanceThreshold(allowance)) {
              await setL2TokenAllowanceInCache(this.chainId, tokenAddress, senderAddress, bridgeAddress, allowance);
            }

            if (!aboveAllowanceThreshold(allowance)) {
              const existingTokenIdx = tokensToApprove.findIndex((item) => item.token.address === erc20.address);

              if (existingTokenIdx >= 0) {
                tokensToApprove[existingTokenIdx].bridges.push(bridgeAddress);
              } else {
                tokensToApprove.push({ token: erc20, bridges: [bridgeAddress] });
              }
            }
          })
        );
      })
    );

    if (unavailableTokens.length > 0) {
      this.log("Some tokens do not have a bridge contract for L2 -> L1 bridging", {
        unavailableTokens: unavailableTokens.map((token) => token.toNative()),
      });
    }

    if (tokensToApprove.length === 0) {
      this.log("No L2 token bridge approvals needed", { l1Tokens: l1Tokens.map((token) => token.toNative()) });
      return;
    }

    const mrkdwn = await approveTokens(tokensToApprove, this.chainId, this.hubChainId, this.logger);
    this.log("Approved L2 bridge tokens! 💰", { mrkdwn }, "info");
  }

  async checkL1TokenApprovals(l1Tokens: EvmAddress[]): Promise<void> {
    const unavailableTokens: EvmAddress[] = [];
    // Approve tokens to bridges. This includes the tokens we want to send over a bridge as well as the custom gas tokens
    // each bridge supports (if applicable).
    const [bridgeTokensToApprove, gasTokensToApprove] = await Promise.all([
      mapAsync(
        l1Tokens.map((token) => [token, this.bridges[token.toNative()]?.l1Gateways] as [EvmAddress, EvmAddress[]]),
        async ([l1Token, bridges]) => {
          const l1TokenAddress = l1Token.toNative();
          const erc20 = ERC20.connect(l1TokenAddress, this.getSigner(this.hubChainId));
          if (!isDefined(bridges) || !this.isSupportedToken(l1Token)) {
            unavailableTokens.push(l1Token);
            return { token: erc20, bridges: [] };
          }
          const bridgesToApprove = await filterAsync(bridges, async (bridge) => {
            const senderAddress = EvmAddress.from(await erc20.signer.getAddress());
            const cachedResult = await getTokenAllowanceFromCache(l1Token, senderAddress, bridge);
            const allowance = cachedResult ?? (await erc20.allowance(senderAddress.toNative(), bridge.toNative()));
            if (!isDefined(cachedResult) && aboveAllowanceThreshold(allowance)) {
              await setTokenAllowanceInCache(l1Token, senderAddress, bridge, allowance);
            }
            return !aboveAllowanceThreshold(allowance);
          });
          return { token: erc20, bridges: bridgesToApprove };
        }
      ),
      mapAsync(
        Object.values(this.bridges).filter((bridge) => isDefined(bridge.gasToken)),
        async (bridge) => {
          const gasToken = bridge.gasToken;
          const erc20 = ERC20.connect(gasToken.toNative(), this.getSigner(this.hubChainId));
          const bridgesToApprove = await filterAsync(bridge.l1Gateways, async (gateway) => {
            const senderAddress = EvmAddress.from(await erc20.signer.getAddress());
            const cachedResult = await getTokenAllowanceFromCache(gasToken, senderAddress, gateway);
            const allowance = cachedResult ?? (await erc20.allowance(senderAddress.toNative(), gateway.toNative()));
            if (!isDefined(cachedResult) && aboveAllowanceThreshold(allowance)) {
              await setTokenAllowanceInCache(gasToken, senderAddress, gateway, allowance);
            }
            return !aboveAllowanceThreshold(allowance);
          });
          return { token: erc20, bridges: bridgesToApprove };
        }
      ),
    ]);
    // Dedup the `gasTokensToApprove` array so that we don't approve the same bridge to send the same token multiple times.
    const tokenBridgePairs = gasTokensToApprove.map(({ token, bridges }) => `${token.address}_${bridges.join("_")}`);
    const tokensToApprove = gasTokensToApprove
      .filter(({ token, bridges }, idx) => {
        const tokenBridgePair = `${token.address}_${bridges.join("_")}`;
        return tokenBridgePairs.indexOf(tokenBridgePair) === idx;
      })
      .concat(bridgeTokensToApprove)
      .filter(({ bridges }) => bridges.length > 0);
    if (unavailableTokens.length > 0) {
      this.log("Some tokens do not have a bridge contract", {
        unavailableTokens: unavailableTokens.map((token) => token.toNative()),
      });
    }
    if (tokensToApprove.length === 0) {
      this.log("No token bridge approvals needed", { l1Tokens: l1Tokens.map((token) => token.toNative()) });
      return;
    }
    const mrkdwn = await approveTokens(tokensToApprove, this.chainId, this.hubChainId, this.logger);
    this.log("Approved whitelisted tokens! 💰", { mrkdwn }, "info");
  }

  async withdrawTokenFromL2(
    address: EvmAddress,
    l2Token: Address,
    amount: BigNumber,
    simMode: boolean,
    optionalParams?: TransferTokenParams
  ): Promise<string[]> {
    const l1Token = getL1TokenAddress(l2Token, this.chainId);
    if (!this.isSupportedL2Bridge(l1Token)) {
      return [];
    }
    let txnsToSend;
    try {
      txnsToSend = await this.l2Bridges[l1Token.toNative()].constructWithdrawToL1Txns(
        address,
        l2Token,
        l1Token,
        amount,
        optionalParams
      );
    } catch (e) {
      this.log(
        "Failed to constructWithdrawToL1Txns",
        {
          toAddress: address,
          l2Token: l2Token.toNative(),
          l1Token: l1Token.toNative(),
          amount: amount.toString(),
          srcChainId: this.chainId,
          dstChainId: this.hubChainId,
          error: stringifyThrownValue(e),
        },
        "error",
        "withdrawTokenFromL2"
      );
      return [];
    }
    if (chainIsEvm(this.chainId)) {
      const multicallerClient = new MultiCallerClient(this.logger);
      txnsToSend.forEach((txn) => multicallerClient.enqueueTransaction(txn));
      const txnReceipts = await multicallerClient.executeTxnQueues(simMode, [this.chainId]);
      return txnReceipts[this.chainId];
    }
    const txnSignatures = [];
    for (const solanaTransaction of txnsToSend) {
      txnSignatures.push(await sendAndConfirmSolanaTransaction(solanaTransaction, getSvmProvider()));
    }
    return txnSignatures;
  }

  async getL2PendingWithdrawalAmount(
    lookbackPeriodSeconds: number,
    fromAddress: Address,
    l2Token: Address
  ): Promise<BigNumber> {
    const l1Token = getL1TokenAddress(l2Token, this.chainId);
    if (!this.isSupportedL2Bridge(l1Token)) {
      return bnZero;
    }
    const [l1SearchFromBlock, l2SearchFromBlock] = await Promise.all([
      getBlockForTimestamp(this.logger, this.hubChainId, getCurrentTime() - lookbackPeriodSeconds),
      getBlockForTimestamp(this.logger, this.chainId, getCurrentTime() - lookbackPeriodSeconds),
    ]);
    const hubChainBlockRange = this.spokePoolManager.getClient(this.hubChainId).eventSearchConfig.maxLookBack;
    const l1EventSearchConfig = {
      from: l1SearchFromBlock,
      to: this.baseL1SearchConfig.to,
      maxLookBack: hubChainBlockRange,
    };

    const spokeChainBlockRange = this.spokePoolManager.getClient(this.chainId).eventSearchConfig.maxLookBack;
    const l2EventSearchConfig = {
      from: l2SearchFromBlock,
      to: this.baseL2SearchConfig.to,
      maxLookBack: spokeChainBlockRange,
    };

    return await this.l2Bridges[l1Token.toNative()].getL2PendingWithdrawalAmount(
      l2EventSearchConfig,
      l1EventSearchConfig,
      fromAddress,
      l2Token
    );
  }

  /**
   * @notice Submits on-chain transaction to send tokens to the target chain.
   * @param address Address to send tokens to.
   * @param l1Token L1 token to send.
   * @param l2Token L2 token to receive.
   * @param amount Amount of tokens to send.
   * @param simMode True if the transaction should only be simulated.
   * @param {optionalParams} TransferTokenParams Params to send to underlying bridge adapter's
   * constructL1ToL2Txn method. Not all adapters support this.
   * @returns Transaction response.
   */
  async sendTokenToTargetChain(
    address: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber,
    simMode: boolean,
    optionalParams?: TransferTokenParams
  ): Promise<TransactionResponse> {
    const bridge = this.bridges[l1Token.toNative()];
    assert(isDefined(bridge) && this.isSupportedToken(l1Token), `Token ${l1Token} is not supported`);
    let bridgeTransactionDetails: BridgeTransactionDetails;
    try {
      bridgeTransactionDetails = await bridge.constructL1ToL2Txn(address, l1Token, l2Token, amount, optionalParams);
    } catch (e) {
      this.log(
        "Failed to construct L1 to L2 transaction",
        {
          address: address.toNative(),
          l1Token: l1Token.toNative(),
          l2Token: l2Token.toNative(),
          amount: amount.toString(),
          srcChainId: this.hubChainId,
          dstChainId: this.chainId,
          error: stringifyThrownValue(e),
        },
        "error",
        "sendTokenToTargetChain"
      );
      return { hash: ZERO_BYTES } as TransactionResponse;
    }
    const { contract, method, args, value } = bridgeTransactionDetails;
    const tokenSymbol = matchTokenSymbol(l1Token.toNative(), this.hubChainId)[0];
    const [srcChain, dstChain] = [getNetworkName(this.hubChainId), getNetworkName(this.chainId)];
    const message = `💌⭐️ Bridging tokens from ${srcChain} to ${dstChain}.`;
    const _txnRequest: AugmentedTransaction = {
      contract,
      chainId: this.hubChainId,
      method,
      args,
      gasLimitMultiplier: this.gasMultiplier,
      value,
      message,
      mrkdwn: `Sent ${formatUnitsForToken(tokenSymbol, amount)} ${tokenSymbol} to chain ${dstChain}.`,
    };
    const { reason, succeed, transaction: txnRequest } = (await this.transactionClient.simulate([_txnRequest]))[0];
    const { contract: targetContract, ...txnRequestData } = txnRequest;
    if (!succeed) {
      const message = `Failed to simulate ${method} deposit from ${txnRequest.chainId} for mainnet token ${l1Token}`;
      this.logger.warn({ at: this.adapterName, message, reason, contract: targetContract.address, txnRequestData });
      throw new Error(`${message} (${reason})`);
    }
    this.log(
      message,
      {
        l1Token: l1Token.toNative(),
        l2Token: l2Token.toNative(),
        amount,
        contract: contract.address,
        txnRequestData,
      },
      "debug",
      "sendTokenToTargetChain"
    );
    if (simMode) {
      this.log("Simulation result", { succeed }, "debug", "sendTokenToTargetChain");
      return { hash: ZERO_BYTES } as TransactionResponse;
    }
    return await submitTransaction(txnRequest, this.transactionClient);
  }

  async wrapNativeTokenIfAboveThreshold(
    threshold: BigNumber,
    target: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse | null> {
    const nativeTokenSymbol = getNativeTokenSymbol(this.chainId);
    const nativeTokenAddress = getWrappedNativeTokenAddress(this.chainId);
    const nativeTokenBalance = await this.getSigner(this.chainId).getBalance();
    if (nativeTokenBalance.lte(threshold)) {
      this.log(`${nativeTokenSymbol} balance below threshold`, { threshold, nativeTokenBalance });
      return null;
    }
    const l2Signer = this.getSigner(this.chainId);
    const contract = new Contract(nativeTokenAddress.toEvmAddress(), WETH_ABI, l2Signer);

    // First verify that the target contract looks like WETH. This protects against
    // accidentally sending ETH to the wrong address, which would be a critical error.
    // Permit bypass if simMode is set in order to permit tests to pass.
    if (simMode === false) {
      const symbol = await contract.symbol();
      const { BSC, HYPEREVM, MAINNET, PLASMA, MONAD } = CHAIN_IDs;
      const nativeTokenChains = [BSC, HYPEREVM, MAINNET, PLASMA, MONAD];
      const prependW = nativeTokenChains.some((chainId) => PUBLIC_NETWORKS[chainId].nativeToken === nativeTokenSymbol);
      const expectedTokenSymbol = prependW ? `W${nativeTokenSymbol}` : nativeTokenSymbol;
      assert(
        symbol === expectedTokenSymbol,
        `Critical (may delete ${nativeTokenSymbol}): ${this.adapterName} token symbol mismatch (${contract.address})`
      );
    }

    const value = nativeTokenBalance.sub(target);
    this.log(
      `Wrapping ${nativeTokenSymbol} on chain ${getNetworkName(this.chainId)}`,
      { threshold, target, value, nativeTokenBalance },
      "debug",
      "wrapNativeTokenIfAboveThreshold"
    );
    const method = "deposit";
    const formatFunc = createFormatFunction(2, 4, false, 18);
    const mrkdwn =
      `${formatFunc(toBN(value).toString())} ${nativeTokenSymbol} on chain ${
        this.chainId
      } was wrapped due to being over the threshold of ` + `${formatFunc(toBN(threshold).toString())}.`;
    const message = `${formatFunc(toBN(value).toString())} ${nativeTokenSymbol} wrapped on target chain ${
      this.chainId
    }🎁`;
    const augmentedTxn = { contract, chainId: this.chainId, method, args: [], value, mrkdwn, message };
    if (simMode) {
      const { succeed, reason } = (await this.transactionClient.simulate([augmentedTxn]))[0];
      this.log(
        "Simulation result",
        { succeed, reason, contract: contract.address, value },
        "debug",
        "wrapNativeTokenIfAboveThreshold"
      );
      return { hash: ZERO_BYTES } as TransactionResponse;
    } else {
      (await this.transactionClient.submit(this.chainId, [augmentedTxn]))[0];
    }
  }

  /**
   * Resolve block-number-based timestamps for a set of bridge events across two chains.
   * Deduplicates block numbers to minimize RPC calls. Handles both EVM and SVM chains.
   */
  private async resolveEventTimestamps(
    l1Events: BridgeEvent[],
    l2Events: BridgeEvent[]
  ): Promise<Map<BridgeEvent, number>> {
    const l1Client = this.spokePoolManager.getClient(this.hubChainId);
    const l2Client = this.spokePoolManager.getClient(this.chainId);
    assert(isDefined(l1Client) && isEVMSpokePoolClient(l1Client));
    assert(isDefined(l2Client));
    const l1Provider = l1Client.spokePool.provider;

    // Collect unique block numbers per chain.
    const l1Blocks = [...new Set(l1Events.map((e) => e.blockNumber))];
    const l2Blocks = [...new Set(l2Events.map((e) => e.blockNumber))];

    // Resolve L1 timestamps (always EVM).
    const l1Timestamps = await Promise.all(l1Blocks.map((b) => getTimestampForBlock(l1Provider, b)));

    // Resolve L2 timestamps — handle EVM and SVM differently.
    let l2Timestamps: number[];
    if (isEVMSpokePoolClient(l2Client)) {
      l2Timestamps = await Promise.all(l2Blocks.map((b) => getTimestampForBlock(l2Client.spokePool.provider, b)));
    } else if (isSVMSpokePoolClient(l2Client)) {
      const rpc = l2Client.svmEventsClient.getRpc();
      l2Timestamps = await Promise.all(
        l2Blocks.map(async (slot) => {
          const blockTime = await rpc.getBlockTime(BigInt(slot) as Parameters<typeof rpc.getBlockTime>[0]).send();
          assert(blockTime !== null, `No block time for Solana slot ${slot}`);
          return Number(blockTime);
        })
      );
    } else {
      throw new Error(`Unsupported spoke pool client type for chain ${this.chainId}`);
    }

    const l1BlockToTs = new Map(l1Blocks.map((b, i) => [b, l1Timestamps[i]]));
    const l2BlockToTs = new Map(l2Blocks.map((b, i) => [b, l2Timestamps[i]]));

    const result = new Map<BridgeEvent, number>();
    for (const e of l1Events) {
      result.set(e, l1BlockToTs.get(e.blockNumber)!);
    }
    for (const e of l2Events) {
      result.set(e, l2BlockToTs.get(e.blockNumber)!);
    }
    return result;
  }

  /**
   * Compute timestamp-aligned search configs using a fixed wall-clock window (FINALIZER_TOKENBRIDGE_LOOKBACK).
   * This ensures L1 and L2 event queries cover the same wall-clock period regardless of block times.
   * Protected so test adapters can override to bypass timestamp-based block lookups.
   */
  protected async computeTimestampAlignedSearchConfigs(): Promise<{
    l1SearchConfig: EventSearchConfig;
    l2SearchConfig: EventSearchConfig;
    windowStartTimestamp: number;
  }> {
    const { l1SearchConfig: baseL1, l2SearchConfig: baseL2 } = this.getUpdatedSearchConfigs();
    const now = getCurrentTime();
    const windowStart = now - FINALIZER_TOKENBRIDGE_LOOKBACK;
    // Query one extra day to ensure we don't miss events near the boundary.
    const queryFrom = now - FINALIZER_TOKENBRIDGE_LOOKBACK - 86400;

    const hubChainBlockRange = this.spokePoolManager.getClient(this.hubChainId).eventSearchConfig.maxLookBack;
    const spokeChainBlockRange = this.spokePoolManager.getClient(this.chainId).eventSearchConfig.maxLookBack;

    const [l1FromBlock, l2FromBlock] = await Promise.all([
      getBlockForTimestamp(this.logger, this.hubChainId, queryFrom),
      getBlockForTimestamp(this.logger, this.chainId, queryFrom),
    ]);

    return {
      l1SearchConfig: { from: l1FromBlock, to: baseL1.to, maxLookBack: hubChainBlockRange },
      l2SearchConfig: { from: l2FromBlock, to: baseL2.to, maxLookBack: spokeChainBlockRange },
      windowStartTimestamp: windowStart,
    };
  }

  /**
   * Match initiation events against finalization events by amount + temporal ordering.
   * Returns unmatched initiations (= outstanding/in-flight transfers).
   *
   * For each finalization, finds the most recent unmatched same-amount initiation with
   * timestamp <= finalization timestamp. Finalizations before warnAfterTimestamp that go
   * unmatched are expected (their initiations preceded the window) and silently skipped.
   */
  private matchTransfers(
    initiations: BridgeEvent[],
    finalizations: BridgeEvent[],
    timestamps: Map<BridgeEvent, number>,
    warnAfterTimestamp: number
  ): BridgeEvent[] {
    // Group initiations by amount string, sorted by timestamp descending (newest first) within each group.
    const initiationsByAmount = new Map<string, BridgeEvent[]>();
    for (const event of initiations) {
      const key = event.amount.toString();
      const group = initiationsByAmount.get(key) ?? [];
      group.push(event);
      initiationsByAmount.set(key, group);
    }
    for (const group of initiationsByAmount.values()) {
      group.sort((a, b) => timestamps.get(b)! - timestamps.get(a)!);
    }

    // Track which initiations have been matched.
    const matched = new Set<BridgeEvent>();

    // Sort finalizations by timestamp descending (newest first).
    const sortedFinalizations = [...finalizations].sort((a, b) => timestamps.get(b)! - timestamps.get(a)!);

    for (const fin of sortedFinalizations) {
      const finTs = timestamps.get(fin)!;
      const key = fin.amount.toString();
      const candidates = initiationsByAmount.get(key);
      if (!candidates) {
        if (finTs >= warnAfterTimestamp) {
          this.log(
            "Unmatched finalization event in recent window",
            { amount: key, blockNumber: fin.blockNumber, txnRef: fin.txnRef, timestamp: finTs },
            "warn",
            "matchTransfers"
          );
        }
        continue;
      }

      // Find most recent unmatched initiation with timestamp <= finalization timestamp.
      // Candidates are sorted newest-first, so the first qualifying match is the most recent.
      let foundMatch = false;
      for (const init of candidates) {
        if (!matched.has(init) && timestamps.get(init)! <= finTs) {
          matched.add(init);
          foundMatch = true;
          break;
        }
      }

      if (!foundMatch && finTs >= warnAfterTimestamp) {
        this.log(
          "Unmatched finalization event in recent window",
          { amount: key, blockNumber: fin.blockNumber, txnRef: fin.txnRef, timestamp: finTs },
          "warn",
          "matchTransfers"
        );
      }
    }

    // Return unmatched initiations (preserving original order).
    return initiations.filter((e) => !matched.has(e));
  }

  async getOutstandingCrossChainTransfers(l1Tokens: EvmAddress[]): Promise<OutstandingTransfers> {
    const { l1SearchConfig, l2SearchConfig, windowStartTimestamp } =
      await this.computeTimestampAlignedSearchConfigs();
    const availableL1Tokens = this.filterSupportedTokens(l1Tokens);
    const warnAfterTimestamp = windowStartTimestamp + FINALIZER_TOKENBRIDGE_LOOKBACK / 2;

    const outstandingTransfers: OutstandingTransfers = {};

    for (const monitoredAddress of this.monitoredAddresses) {
      for (const l1Token of availableL1Tokens) {
        const bridge = this.bridges[l1Token.toNative()];
        const [depositInitiatedResults, depositFinalizedResults] = await Promise.all([
          bridge.queryL1BridgeInitiationEvents(l1Token, monitoredAddress, monitoredAddress, l1SearchConfig),
          bridge.queryL2BridgeFinalizationEvents(l1Token, monitoredAddress, monitoredAddress, l2SearchConfig),
        ]);

        for (const [l2Token, initiationEvents] of Object.entries(depositInitiatedResults)) {
          const finalizationEvents = depositFinalizedResults?.[l2Token] ?? [];

          // Resolve timestamps for all events.
          const timestamps = await this.resolveEventTimestamps(initiationEvents, finalizationEvents);

          // Trim events to the window.
          const windowedInitiations = initiationEvents.filter((e) => timestamps.get(e)! >= windowStartTimestamp);
          const windowedFinalizations = finalizationEvents.filter((e) => timestamps.get(e)! >= windowStartTimestamp);

          // Match transfers by amount + temporal ordering.
          const unmatchedInitiations = this.matchTransfers(
            windowedInitiations,
            windowedFinalizations,
            timestamps,
            warnAfterTimestamp
          );

          const totalAmount = unmatchedInitiations.reduce((acc, event) => acc.add(event.amount), bnZero);
          assign(outstandingTransfers, [monitoredAddress.toNative(), l1Token.toNative(), l2Token], {
            totalAmount,
            depositTxHashes: unmatchedInitiations.map((event) => event.txnRef),
          });
        }
      }
    }

    return outstandingTransfers;
  }
}
