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
  ZERO_ADDRESS,
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
  EvmAddress,
  Address,
  getNativeTokenSymbol,
  getWrappedNativeTokenAddress,
} from "../utils";
import { AugmentedTransaction, TransactionClient } from "../clients/TransactionClient";
import { approveTokens, getTokenAllowanceFromCache, aboveAllowanceThreshold, setTokenAllowanceInCache } from "./utils";
import { BaseBridgeAdapter } from "./bridges/BaseBridgeAdapter";
import { OutstandingTransfers } from "../interfaces";
import WETH_ABI from "../common/abi/Weth.json";
import { BaseL2BridgeAdapter } from "./l2Bridges/BaseL2BridgeAdapter";

export type SupportedL1Token = EvmAddress;
export type SupportedTokenSymbol = string;

export class BaseChainAdapter {
  protected baseL1SearchConfig: MakeOptional<EventSearchConfig, "toBlock">;
  protected baseL2SearchConfig: MakeOptional<EventSearchConfig, "toBlock">;
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

  protected getSearchConfig(chainId: number): MakeOptional<EventSearchConfig, "toBlock"> {
    return { ...this.spokePoolClients[chainId].eventSearchConfig };
  }

  protected getSigner(chainId: number): Signer {
    return this.spokePoolClients[chainId].spokePool.signer;
  }

  // Note: this must be called after the SpokePoolClients are updated.
  public getUpdatedSearchConfigs(): { l1SearchConfig: EventSearchConfig; l2SearchConfig: EventSearchConfig } {
    const l1LatestBlock = this.spokePoolClients[this.hubChainId].latestBlockSearched;
    const l2LatestBlock = this.spokePoolClients[this.chainId].latestBlockSearched;
    if (l1LatestBlock === 0 || l2LatestBlock === 0) {
      throw new Error("One or more SpokePoolClients have not been updated");
    }
    return {
      l1SearchConfig: {
        ...this.baseL1SearchConfig,
        toBlock: this.baseL1SearchConfig?.toBlock ?? l1LatestBlock,
      },
      l2SearchConfig: {
        ...this.baseL2SearchConfig,
        toBlock: this.baseL2SearchConfig?.toBlock ?? l2LatestBlock,
      },
    };
  }

  /**
   * Determine whether this adapter supports an l1 token address
   * @param l1Token an address
   * @returns True if l1Token is supported
   */
  isSupportedToken(l1Token: EvmAddress): l1Token is SupportedL1Token {
    const relevantSymbols = matchTokenSymbol(l1Token.toAddress(), this.hubChainId);
    // if the symbol is not in the supported tokens list, it's not supported
    return relevantSymbols.some((symbol) => this.supportedTokens.includes(symbol));
  }

  // @todo: Only take `EvmAddress` objects as input once the SDK clients do not output strings for addresses.
  isSupportedL2Bridge(l1Token: string): boolean {
    return isDefined(this.l2Bridges[l1Token]);
  }

  filterSupportedTokens(l1Tokens: EvmAddress[]): EvmAddress[] {
    return l1Tokens.filter((l1Token) => this.isSupportedToken(l1Token));
  }

  async checkTokenApprovals(l1Tokens: EvmAddress[]): Promise<void> {
    const unavailableTokens: EvmAddress[] = [];
    // Approve tokens to bridges. This includes the tokens we want to send over a bridge as well as the custom gas tokens
    // each bridge supports (if applicable).
    const [bridgeTokensToApprove, gasTokensToApprove] = await Promise.all([
      mapAsync(
        l1Tokens.map((token) => [token, this.bridges[token.toAddress()]?.l1Gateways] as [EvmAddress, EvmAddress[]]),
        async ([l1Token, bridges]) => {
          const l1TokenAddress = l1Token.toAddress();
          const erc20 = ERC20.connect(l1TokenAddress, this.getSigner(this.hubChainId));
          if (!isDefined(bridges) || !this.isSupportedToken(l1Token)) {
            unavailableTokens.push(l1Token);
            return { token: erc20, bridges: [] };
          }
          const bridgesToApprove = await filterAsync(bridges, async (bridge) => {
            const senderAddress = EvmAddress.from(await erc20.signer.getAddress());
            const cachedResult = await getTokenAllowanceFromCache(l1Token, senderAddress, bridge);
            const allowance = cachedResult ?? (await erc20.allowance(senderAddress.toAddress(), bridge.toAddress()));
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
          const erc20 = ERC20.connect(gasToken.toAddress(), this.getSigner(this.hubChainId));
          const bridgesToApprove = await filterAsync(bridge.l1Gateways, async (gateway) => {
            const senderAddress = EvmAddress.from(await erc20.signer.getAddress());
            const cachedResult = await getTokenAllowanceFromCache(gasToken, senderAddress, gateway);
            const allowance = cachedResult ?? (await erc20.allowance(senderAddress.toAddress(), gateway.toAddress()));
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
        unavailableTokens: unavailableTokens.map((token) => token.toAddress()),
      });
    }
    if (tokensToApprove.length === 0) {
      this.log("No token bridge approvals needed", { l1Tokens: l1Tokens.map((token) => token.toAddress()) });
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
    const _l1Token = getL1TokenAddress(l2Token.toAddress(), this.chainId);
    const l1Token = EvmAddress.from(_l1Token);
    if (!this.isSupportedL2Bridge(l1Token.toAddress())) {
      return [];
    }
    const txnsToSend = await this.l2Bridges[l1Token.toAddress()].constructWithdrawToL1Txns(
      address,
      l2Token,
      l1Token,
      amount
    );
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
    const l1Token = getL1TokenAddress(l2Token.toAddress(), this.chainId);
    if (!this.isSupportedL2Bridge(l1Token)) {
      return bnZero;
    }
    const [l1SearchFromBlock, l2SearchFromBlock] = await Promise.all([
      getBlockForTimestamp(this.hubChainId, getCurrentTime() - lookbackPeriodSeconds),
      getBlockForTimestamp(this.chainId, getCurrentTime() - lookbackPeriodSeconds),
    ]);
    const l1EventSearchConfig: EventSearchConfig = {
      fromBlock: l1SearchFromBlock,
      toBlock: this.baseL1SearchConfig.toBlock,
    };
    const l2EventSearchConfig: EventSearchConfig = {
      fromBlock: l2SearchFromBlock,
      toBlock: this.baseL2SearchConfig.toBlock,
    };
    return await this.l2Bridges[l1Token].getL2PendingWithdrawalAmount(
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
    const bridge = this.bridges[l1Token.toAddress()];
    assert(isDefined(bridge) && this.isSupportedToken(l1Token), `Token ${l1Token} is not supported`);
    const { contract, method, args, value } = await bridge.constructL1ToL2Txn(address, l1Token, l2Token, amount);
    const tokenSymbol = matchTokenSymbol(l1Token.toAddress(), this.hubChainId)[0];
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
        l1Token: l1Token.toAddress(),
        l2Token: l2Token.toAddress(),
        amount,
        contract: contract.address,
        txnRequestData,
      },
      "debug",
      "sendTokenToTargetChain"
    );
    if (simMode) {
      this.log("Simulation result", { succeed }, "debug", "sendTokenToTargetChain");
      return { hash: ZERO_ADDRESS } as TransactionResponse;
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
    const contract = new Contract(nativeTokenAddress, WETH_ABI, l2Signer);

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
      return { hash: ZERO_ADDRESS } as TransactionResponse;
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
        const bridge = this.bridges[l1Token.toAddress()];
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
          assign(outstandingTransfers, [monitoredAddress.toAddress(), l1Token.toAddress(), l2Token], {
            totalAmount: _totalAmount.gt(bnZero) ? _totalAmount : bnZero,
            depositTxHashes: outstandingInitiatedEvents.map((event) => event.txnRef),
          });
        });
      });
    });

    return outstandingTransfers;
  }
}
