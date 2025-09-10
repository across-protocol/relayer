import { MultiCallerClient, SpokePoolClient } from "../clients";
import {
  AnyObject,
  BigNumber,
  Contract,
  DefaultLogLevels,
  ERC20,
  EventSearchConfig,
  MakeOptional,
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
  getCurrentTime,
  bnZero,
  Address,
  getNativeTokenSymbol,
  getWrappedNativeTokenAddress,
  stringifyThrownValue,
  ZERO_BYTES,
  isEVMSpokePoolClient,
  EvmAddress,
} from "../utils";
import { AugmentedTransaction, TransactionClient } from "../clients/TransactionClient";
import {
  approveTokens,
  getTokenAllowanceFromCache,
  aboveAllowanceThreshold,
  setTokenAllowanceInCache,
  getL2TokenAllowanceFromCache,
  setL2TokenAllowanceInCache,
} from "./utils";
import { BaseBridgeAdapter, BridgeTransactionDetails } from "./bridges/BaseBridgeAdapter";
import { OutstandingTransfers } from "../interfaces";
import WETH_ABI from "../common/abi/Weth.json";
import { BaseL2BridgeAdapter } from "./l2Bridges/BaseL2BridgeAdapter";
import { ExpandedERC20 } from "@across-protocol/contracts";

export type SupportedL1Token = EvmAddress;
export type SupportedTokenSymbol = string;

export class BaseChainAdapter {
  protected baseL1SearchConfig: MakeOptional<EventSearchConfig, "to">;
  protected baseL2SearchConfig: MakeOptional<EventSearchConfig, "to">;
  private transactionClient: TransactionClient;

  constructor(
    protected readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    protected readonly chainId: number,
    protected readonly hubChainId: number,
    protected readonly monitoredAddresses: Address[],
    protected readonly logger: winston.Logger,
    public readonly supportedTokens: SupportedTokenSymbol[],
    protected readonly bridges: { [l1Token: string]: BaseBridgeAdapter },
    protected readonly l2Bridges: { [l1Token: string]: BaseL2BridgeAdapter },
    protected readonly gasMultiplier: number
  ) {
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
    return { ...this.spokePoolClients[chainId].eventSearchConfig };
  }

  protected getSigner(chainId: number): Signer {
    const spokePoolClient = this.spokePoolClients[chainId];
    assert(isEVMSpokePoolClient(spokePoolClient));
    return spokePoolClient.spokePool.signer;
  }

  // Note: this must be called after the SpokePoolClients are updated.
  public getUpdatedSearchConfigs(): { l1SearchConfig: EventSearchConfig; l2SearchConfig: EventSearchConfig } {
    const l1LatestBlock = this.spokePoolClients[this.hubChainId].latestHeightSearched;
    const l2LatestBlock = this.spokePoolClients[this.chainId].latestHeightSearched;
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
    simMode: boolean
  ): Promise<string[]> {
    const l1Token = getL1TokenAddress(l2Token, this.chainId);
    if (!this.isSupportedL2Bridge(l1Token)) {
      return [];
    }
    let txnsToSend: AugmentedTransaction[];
    try {
      txnsToSend = await this.l2Bridges[l1Token.toNative()].constructWithdrawToL1Txns(
        address,
        l2Token,
        l1Token,
        amount
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
    const multicallerClient = new MultiCallerClient(this.logger);
    txnsToSend.forEach((txn) => multicallerClient.enqueueTransaction(txn));
    const txnReceipts = await multicallerClient.executeTxnQueues(simMode);
    return txnReceipts[this.chainId];
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
    const l1EventSearchConfig: EventSearchConfig = {
      from: l1SearchFromBlock,
      to: this.baseL1SearchConfig.to,
    };
    const l2EventSearchConfig: EventSearchConfig = {
      from: l2SearchFromBlock,
      to: this.baseL2SearchConfig.to,
    };
    return await this.l2Bridges[l1Token.toNative()].getL2PendingWithdrawalAmount(
      l2EventSearchConfig,
      l1EventSearchConfig,
      fromAddress,
      l2Token
    );
  }

  async sendTokenToTargetChain(
    address: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse> {
    const bridge = this.bridges[l1Token.toNative()];
    assert(isDefined(bridge) && this.isSupportedToken(l1Token), `Token ${l1Token} is not supported`);
    let bridgeTransactionDetails: BridgeTransactionDetails;
    try {
      bridgeTransactionDetails = await bridge.constructL1ToL2Txn(address, l1Token, l2Token, amount);
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
    return (await this.transactionClient.submit(this.hubChainId, [{ ...txnRequest }]))[0];
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
      const prependW = nativeTokenSymbol === "ETH" || nativeTokenSymbol === "BNB";
      const expectedTokenSymbol = prependW ? `W${nativeTokenSymbol}` : nativeTokenSymbol;
      assert(
        symbol === expectedTokenSymbol,
        `Critical (may delete ${nativeTokenSymbol}): Unable to verify ${this.adapterName} ${nativeTokenSymbol} address (${contract.address})`
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

  async getOutstandingCrossChainTransfers(l1Tokens: EvmAddress[]): Promise<OutstandingTransfers> {
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();
    const availableL1Tokens = this.filterSupportedTokens(l1Tokens);

    const outstandingTransfers: OutstandingTransfers = {};

    await forEachAsync(this.monitoredAddresses, async (monitoredAddress) => {
      await forEachAsync(availableL1Tokens, async (l1Token) => {
        const bridge = this.bridges[l1Token.toNative()];
        const [depositInitiatedResults, depositFinalizedResults] = await Promise.all([
          bridge.queryL1BridgeInitiationEvents(l1Token, monitoredAddress, monitoredAddress, l1SearchConfig),
          bridge.queryL2BridgeFinalizationEvents(l1Token, monitoredAddress, monitoredAddress, l2SearchConfig),
        ]);

        Object.entries(depositInitiatedResults).forEach(([l2Token, depositInitiatedEvents]) => {
          const finalizedAmounts = depositFinalizedResults?.[l2Token]?.map((event) => event.amount.toString()) ?? [];
          const outstandingInitiatedEvents = depositInitiatedEvents.filter((event) => {
            // Remove the first match. This handles scenarios where are collisions by amount.
            const index = finalizedAmounts.indexOf(event.amount.toString());
            if (index > -1) {
              finalizedAmounts.splice(index, 1);
              return false;
            }
            return true;
          });
          const finalizedSum = finalizedAmounts.reduce((acc, amount) => acc.sub(BigNumber.from(amount)), bnZero);
          // The total amount outstanding is the outstanding initiated amount subtracted by the leftover finalized amount.
          const _totalAmount = outstandingInitiatedEvents.reduce((acc, event) => acc.add(event.amount), finalizedSum);
          assign(outstandingTransfers, [monitoredAddress.toNative(), l1Token.toNative(), l2Token], {
            totalAmount: _totalAmount.gt(bnZero) ? _totalAmount : bnZero,
            depositTxHashes: outstandingInitiatedEvents.map((event) => event.txnRef),
          });
        });
      });
    });

    return outstandingTransfers;
  }
}
