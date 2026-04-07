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
  getInventoryEquivalentL1TokenAddress,
  getBlockForTimestamp,
  getCurrentTime,
  bnZero,
  Address,
  getNativeTokenSymbol,
  getWrappedNativeTokenAddress,
  stringifyThrownValue,
  ZERO_BYTES,
  isEVMSpokePoolClient,
  isTVMSpokePoolClient,
  EvmAddress,
  chainIsEvm,
  sendAndConfirmSolanaTransaction,
  getSvmProvider,
  submitTransaction,
  getTokenInfo,
  ConvertDecimals,
  toAddressType,
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
import { BaseBridgeAdapter, BridgeTransactionDetails } from "./bridges/BaseBridgeAdapter";
import { OutstandingTransfers } from "../interfaces";
import WETH_ABI from "../common/abi/Weth.json";
import { BaseL2BridgeAdapter } from "./l2Bridges/BaseL2BridgeAdapter";
import { ExpandedERC20 } from "@across-protocol/sdk/typechain";
import { PendingBridgeRedisReader } from "../rebalancer/utils/PendingBridgeRedis";

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
    protected readonly monitoredAddresses: { [l1Token: string]: Address[] },
    protected readonly logger: winston.Logger,
    public readonly supportedTokens: SupportedTokenSymbol[],
    protected readonly bridges: { [l1Token: string]: BaseBridgeAdapter },
    protected readonly l2Bridges: { [l1Token: string]: BaseL2BridgeAdapter },
    protected readonly gasMultiplier: number,
    protected readonly pendingBridgeRedisReader?: PendingBridgeRedisReader
  ) {
    this.spokePoolManager = new SpokePoolManager(logger, spokePoolClients);
    this.baseL1SearchConfig = { ...this.getSearchConfig(this.hubChainId) };
    this.baseL2SearchConfig = { ...this.getSearchConfig(this.chainId) };
    this.transactionClient = new TransactionClient(logger);
    Object.values(this.bridges).forEach((bridge) => bridge.setPendingBridgeRedisReader(this.pendingBridgeRedisReader));
    Object.values(this.l2Bridges).forEach((bridge) =>
      bridge.setPendingBridgeRedisReader(this.pendingBridgeRedisReader)
    );
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
    assert(isEVMSpokePoolClient(spokePoolClient) || isTVMSpokePoolClient(spokePoolClient));
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
    const l1Token = this.getL1TokenAddress(l2Token, this.chainId);
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
          l2Token,
          l1Token,
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

  async getL2PendingWithdrawalLookbackPeriodSeconds(l2Token: Address): Promise<number> {
    const l1Token = this.getL1TokenAddress(l2Token, this.chainId);
    if (!this.isSupportedL2Bridge(l1Token)) {
      return -1;
    }
    const l2Bridge = this.l2Bridges[l1Token.toNative()];
    const lookbackPeriodSeconds = l2Bridge.pendingWithdrawalLookbackPeriodSeconds();
    return lookbackPeriodSeconds;
  }

  async getL2PendingWithdrawalAmount(
    lookbackPeriodSeconds: number,
    fromAddress: Address,
    l2Token: Address
  ): Promise<BigNumber> {
    const l1Token = this.getL1TokenAddress(l2Token, this.chainId);
    if (!this.isSupportedL2Bridge(l1Token)) {
      return bnZero;
    }
    const [l1SearchFromBlock, l2SearchFromBlock] = await Promise.all([
      getBlockForTimestamp(this.logger, this.hubChainId, getCurrentTime() - lookbackPeriodSeconds),
      getBlockForTimestamp(this.logger, this.chainId, getCurrentTime() - lookbackPeriodSeconds),
    ]);

    const l1SpokePoolClient = this.spokePoolManager.getClient(this.hubChainId);
    const hubChainBlockRange = l1SpokePoolClient.eventSearchConfig.maxLookBack;
    const l1LatestBlock = l1SpokePoolClient.latestHeightSearched;
    const l1EventSearchConfig = {
      from: l1SearchFromBlock,
      to: this.baseL1SearchConfig?.to ?? l1LatestBlock,
      maxLookBack: hubChainBlockRange,
    };

    const l2SpokePoolClient = this.spokePoolManager.getClient(this.chainId);
    const spokeChainBlockRange = l2SpokePoolClient.eventSearchConfig.maxLookBack;
    const l2LatestBlock = l2SpokePoolClient.latestHeightSearched;
    const l2EventSearchConfig = {
      from: l2SearchFromBlock,
      to: this.baseL2SearchConfig?.to ?? l2LatestBlock,
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
          address,
          l1Token,
          l2Token,
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
        l1Token,
        l2Token,
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
    }
    return (await this.transactionClient.submit(this.chainId, [augmentedTxn]))[0];
  }

  async getOutstandingCrossChainTransfers(l1Tokens: EvmAddress[]): Promise<OutstandingTransfers> {
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();
    const availableL1Tokens = this.filterSupportedTokens(l1Tokens);

    const outstandingTransfers: OutstandingTransfers = {};

    this.logger.debug({
      at: `${this.adapterName}#getOutstandingCrossChainTransfers`,
      message: "Getting outstanding cross chain transfers",
      monitoredAddresses: Object.fromEntries(
        Object.entries(this.monitoredAddresses).map(([l1Token, addresses]) => [l1Token, addresses])
      ),
    });

    await forEachAsync(availableL1Tokens, async (l1Token) => {
      const monitoredAddresses = this.monitoredAddresses[l1Token.toNative()];
      await forEachAsync(monitoredAddresses, async (monitoredAddress) => {
        const bridge = this.bridges[l1Token.toNative()];
        const [depositInitiatedResults, depositFinalizedResults] = await Promise.all([
          bridge.queryL1BridgeInitiationEvents(l1Token, monitoredAddress, monitoredAddress, l1SearchConfig),
          bridge.queryL2BridgeFinalizationEvents(l1Token, monitoredAddress, monitoredAddress, l2SearchConfig),
        ]);
        const ignoredPendingBridgeTxnRefs = await bridge.getIgnoredPendingBridgeTxnRefs(
          this.hubChainId,
          this.chainId,
          monitoredAddress
        );
        Object.entries(depositInitiatedResults).forEach(([l2Token, depositInitiatedEvents]) => {
          const filteredDepositEvents = (depositInitiatedEvents ?? []).filter(
            (event) => !ignoredPendingBridgeTxnRefs.has(event.txnRef)
          );
          const totalDepositedAmount = filteredDepositEvents.reduce((acc, event) => {
            return acc.add(event.amount);
          }, bnZero);
          const l2TokenDecimals = getTokenInfo(toAddressType(l2Token, this.chainId), this.chainId).decimals;
          const l1TokenDecimals = getTokenInfo(l1Token, this.hubChainId).decimals;
          const totalFinalizedAmount = (depositFinalizedResults?.[l2Token] ?? []).reduce((acc, event) => {
            return acc.add(ConvertDecimals(l2TokenDecimals, l1TokenDecimals)(event.amount));
          }, bnZero);

          // If there is a net unfinalized amount, go through deposit initiated events in newest to oldest order
          // and assume that the newest bridges are the ones that are not yet finalized.
          const outstandingInitiatedEvents: string[] = [];
          const totalAmount = totalDepositedAmount.sub(totalFinalizedAmount);
          let remainingUnfinalizedAmount = totalAmount;
          if (remainingUnfinalizedAmount.gt(0)) {
            for (const depositEvent of filteredDepositEvents) {
              if (remainingUnfinalizedAmount.lte(0)) {
                break;
              }
              outstandingInitiatedEvents.push(depositEvent.txnRef);
              remainingUnfinalizedAmount = remainingUnfinalizedAmount.sub(depositEvent.amount);
            }
          }
          if (totalAmount.gt(0) && outstandingInitiatedEvents.length > 0) {
            assign(outstandingTransfers, [monitoredAddress.toNative(), l1Token.toNative(), l2Token], {
              totalAmount,
              depositTxHashes: outstandingInitiatedEvents,
            });
          }
        });
      });
    });

    return outstandingTransfers;
  }

  private getL1TokenAddress(l2Token: Address, chainId: number): EvmAddress {
    return getInventoryEquivalentL1TokenAddress(l2Token, chainId, this.hubChainId);
  }
}
