import { SpokePoolClient } from "../clients";
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
} from "../utils";
import { AugmentedTransaction, TransactionClient } from "../clients/TransactionClient";
import { approveTokens, getTokenAllowanceFromCache, isMaxAllowance, setTokenAllowanceInCache } from "./utils";
import { BaseBridgeAdapter } from "./bridges/BaseBridgeAdapter";
import { CONTRACT_ADDRESSES } from "../common";
import { OutstandingTransfers } from "../interfaces";

export type SupportedL1Token = string;
export type SupportedTokenSymbol = string;

export class BaseChainAdapter {
  protected baseL1SearchConfig: MakeOptional<EventSearchConfig, "toBlock">;
  protected baseL2SearchConfig: MakeOptional<EventSearchConfig, "toBlock">;
  private transactionClient: TransactionClient;

  constructor(
    protected readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    protected readonly chainId: number,
    protected readonly hubChainId: number,
    protected readonly monitoredAddresses: string[],
    protected readonly logger: winston.Logger,
    public readonly supportedTokens: SupportedTokenSymbol[],
    protected readonly bridges: { [l1Token: string]: BaseBridgeAdapter },
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
  isSupportedToken(l1Token: string): l1Token is SupportedL1Token {
    const relevantSymbols = matchTokenSymbol(l1Token, this.hubChainId);
    // if the symbol is not in the supported tokens list, it's not supported
    return relevantSymbols.some((symbol) => this.supportedTokens.includes(symbol));
  }

  filterSupportedTokens(l1Tokens: string[]): string[] {
    return l1Tokens.filter((l1Token) => this.isSupportedToken(l1Token));
  }

  async checkTokenApprovals(l1Tokens: string[]): Promise<void> {
    const unavailableTokens: string[] = [];
    const tokensToApprove = (
      await mapAsync(
        l1Tokens.map((token) => [token, this.bridges[token]?.l1Gateways] as [string, string[]]),
        async ([l1Token, bridges]) => {
          const erc20 = ERC20.connect(l1Token, this.getSigner(this.hubChainId));
          if (!isDefined(bridges) || !this.isSupportedToken(l1Token)) {
            unavailableTokens.push(l1Token);
            return { token: erc20, bridges: [] };
          }
          const bridgesToApprove = await filterAsync(bridges, async (bridge) => {
            const senderAddress = await erc20.signer.getAddress();
            const cachedResult = await getTokenAllowanceFromCache(l1Token, senderAddress, bridge);
            const allowance = cachedResult ?? (await erc20.allowance(senderAddress, bridge));
            if (!isDefined(cachedResult) && isMaxAllowance(allowance)) {
              await setTokenAllowanceInCache(l1Token, senderAddress, bridge, allowance);
            }
            return !isMaxAllowance(allowance);
          });
          return { token: erc20, bridges: bridgesToApprove };
        }
      )
    ).filter(({ bridges }) => bridges.length > 0);
    if (unavailableTokens.length > 0) {
      this.log("Some tokens do not have a bridge contract", { unavailableTokens });
    }
    if (tokensToApprove.length === 0) {
      this.log("No token bridge approvals needed", { l1Tokens });
      return;
    }
    const mrkdwn = await approveTokens(tokensToApprove, this.chainId, this.hubChainId, this.logger);
    this.log("Approved whitelisted tokens! 💰", { mrkdwn }, "info");
  }

  async sendTokenToTargetChain(
    address: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse> {
    const bridge = this.bridges[l1Token];
    assert(isDefined(bridge) && this.isSupportedToken(l1Token), `Token ${l1Token} is not supported`);
    const { contract, method, args, value } = await bridge.constructL1ToL2Txn(address, l1Token, l2Token, amount);
    const tokenSymbol = matchTokenSymbol(l1Token, this.hubChainId)[0];
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
      { l1Token, l2Token, amount, contract: contract.address, txnRequestData },
      "debug",
      "sendTokenToTargetChain"
    );
    if (simMode) {
      this.log("Simulation result", { succeed }, "debug", "sendTokenToTargetChain");
      return { hash: ZERO_ADDRESS } as TransactionResponse;
    }
    return (await this.transactionClient.submit(this.hubChainId, [{ ...txnRequest }]))[0];
  }

  async wrapEthIfAboveThreshold(
    threshold: BigNumber,
    target: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse | null> {
    const { address: wethAddress, abi: wethABI } = CONTRACT_ADDRESSES[this.chainId].weth;
    const ethBalance = await this.getSigner(this.chainId).getBalance();
    if (ethBalance.lte(threshold)) {
      this.log("ETH balance below threshold", { threshold, ethBalance });
      return null;
    }
    const l2Signer = this.getSigner(this.chainId);
    const contract = new Contract(wethAddress, wethABI, l2Signer);
    const value = ethBalance.sub(target);
    this.log("Wrapping ETH", { threshold, target, value, ethBalance }, "debug", "wrapEthIfAboveThreshold");
    const method = "deposit";
    const formatFunc = createFormatFunction(2, 4, false, 18);
    const mrkdwn =
      `${formatFunc(toBN(value).toString())} Ether on chain ${
        this.chainId
      } was wrapped due to being over the threshold of ` + `${formatFunc(toBN(threshold).toString())} ETH.`;
    const message = `${formatFunc(toBN(value).toString())} Eth wrapped on target chain ${this.chainId}🎁`;
    const augmentedTxn = { contract, chainId: this.chainId, method, args: [], value, mrkdwn, message };
    if (simMode) {
      const { succeed, reason } = (await this.transactionClient.simulate([augmentedTxn]))[0];
      this.log("Simulation result", { succeed, reason, contract, value }, "debug", "wrapEthIfAboveThreshold");
      return { hash: ZERO_ADDRESS } as TransactionResponse;
    } else {
      (await this.transactionClient.submit(this.chainId, [augmentedTxn]))[0];
    }
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<OutstandingTransfers> {
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();
    const availableL1Tokens = this.filterSupportedTokens(l1Tokens);

    const outstandingTransfers: OutstandingTransfers = {};

    await forEachAsync(this.monitoredAddresses, async (monitoredAddress) => {
      await forEachAsync(availableL1Tokens, async (l1Token) => {
        const bridge = this.bridges[l1Token];
        const [depositInitiatedResults, depositFinalizedResults] = await Promise.all([
          bridge.queryL1BridgeInitiationEvents(l1Token, monitoredAddress, undefined, l1SearchConfig),
          bridge.queryL2BridgeFinalizationEvents(l1Token, monitoredAddress, undefined, l2SearchConfig),
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
          assign(outstandingTransfers, [monitoredAddress, l1Token, l2Token], {
            totalAmount: outstandingInitiatedEvents.reduce((acc, event) => acc.add(event.amount), BigNumber.from(0)),
            depositTxHashes: outstandingInitiatedEvents.map((event) => event.transactionHash),
          });
        });
      });
    });

    this.baseL1SearchConfig.fromBlock = l1SearchConfig.toBlock + 1;
    this.baseL2SearchConfig.fromBlock = l2SearchConfig.toBlock + 1;

    return outstandingTransfers;
  }
}
