import assert from "assert";
import {
  Contract,
  BigNumber,
  ZERO_ADDRESS,
  paginatedEventQuery,
  BigNumberish,
  TransactionResponse,
  isDefined,
} from "../../utils";
import { spreadEventWithBlockNumber, assign, winston } from "../../utils";
import { AugmentedTransaction, SpokePoolClient, TransactionClient } from "../../clients";
import { BaseAdapter } from "./";
import { SortableEvent } from "../../interfaces";
import { OutstandingTransfers } from "../../interfaces";
import { constants } from "@across-protocol/sdk-v2";
import { CONTRACT_ADDRESSES } from "../../common";
import { CHAIN_IDs } from "@across-protocol/contracts-v2";
const { TOKEN_SYMBOLS_MAP } = constants;

export class OptimismAdapter extends BaseAdapter {
  public l2Gas: number;
  private txnClient: TransactionClient;

  private customL1OptimismBridgeAddresses = {
    [TOKEN_SYMBOLS_MAP.DAI.addresses[1]]: CONTRACT_ADDRESSES[1].daiOptimismBridge,
    [TOKEN_SYMBOLS_MAP.SNX.addresses[1]]: CONTRACT_ADDRESSES[1].snxOptimismBridge,
  } as const;

  private customOvmBridgeAddresses = {
    [TOKEN_SYMBOLS_MAP.DAI.addresses[1]]: CONTRACT_ADDRESSES[10].daiOptimismBridge,
    [TOKEN_SYMBOLS_MAP.SNX.addresses[1]]: CONTRACT_ADDRESSES[10].snxOptimismBridge,
  } as const;

  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[],
    // Optional sender address where the cross chain transfers originate from. This is useful for the use case of
    // monitoring transfers from HubPool to SpokePools where the sender is HubPool.
    readonly senderAddress?: string
  ) {
    super(
      spokePoolClients,
      10,
      monitoredAddresses,
      logger,
      Object.values(TOKEN_SYMBOLS_MAP)
        .filter(({ addresses }) => isDefined(addresses[CHAIN_IDs.OPTIMISM]))
        .map(({ symbol }) => symbol)
    );
    this.l2Gas = 200000;
    this.txnClient = new TransactionClient(logger);
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<OutstandingTransfers> {
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();
    this.log("Getting cross-chain txs", { l1Tokens, l1Config: l1SearchConfig, l2Config: l2SearchConfig });

    const promises = [];
    // Fetch bridge events for all monitored addresses.
    for (const monitoredAddress of this.monitoredAddresses) {
      for (const l1Token of l1Tokens) {
        const l1Method = this.isWeth(l1Token)
          ? "ETHDepositInitiated"
          : this.isSNX(l1Token)
          ? "DepositInitiated"
          : "ERC20DepositInitiated";
        let l1SearchFilter = [l1Token, undefined, monitoredAddress];
        let l2SearchFilter = [l1Token, undefined, monitoredAddress];
        if (this.isWeth(l1Token)) {
          l1SearchFilter = [undefined, monitoredAddress];
          l2SearchFilter = [ZERO_ADDRESS, undefined, monitoredAddress];
        } else if (this.isSNX(l1Token)) {
          l1SearchFilter = [monitoredAddress];
          l2SearchFilter = [monitoredAddress];
        }
        const l1Bridge = this.getL1Bridge(l1Token);
        const l2Bridge = this.getL2Bridge(l1Token);
        // Transfers might have come from the monitored address itself or another sender address (if specified).
        const senderAddress = this.senderAddress || this.atomicDepositorAddress;
        const adapterSearchConfig = this.isSNX(l1Token) ? [senderAddress] : [ZERO_ADDRESS, undefined, senderAddress];
        promises.push(
          paginatedEventQuery(l1Bridge, l1Bridge.filters[l1Method](...l1SearchFilter), l1SearchConfig),
          paginatedEventQuery(l2Bridge, l2Bridge.filters.DepositFinalized(...l2SearchFilter), l2SearchConfig),
          paginatedEventQuery(l2Bridge, l2Bridge.filters.DepositFinalized(...adapterSearchConfig), l2SearchConfig)
        );
      }
    }

    const results = await Promise.all(promises);

    // 3 events per token.
    const numEventsPerMonitoredAddress = 3 * l1Tokens.length;

    // Segregate the events list by monitored address.
    const resultsByMonitoredAddress = Object.fromEntries(
      this.monitoredAddresses.map((monitoredAddress, index) => {
        const start = index * numEventsPerMonitoredAddress;
        return [monitoredAddress, results.slice(start, start + numEventsPerMonitoredAddress + 1)];
      })
    );

    // Process events for each monitored address.
    for (const monitoredAddress of this.monitoredAddresses) {
      const eventsToProcess = resultsByMonitoredAddress[monitoredAddress];
      // The logic below takes the results from the promises and spreads them into the l1DepositInitiatedEvents,
      // l2DepositFinalizedEvents and l2DepositFinalizedEvents_DepositAdapter state from the BaseAdapter.
      eventsToProcess.forEach((result, index) => {
        const l1Token = l1Tokens[Math.floor(index / 3)];
        const events = result.map((event) => {
          const eventSpread = spreadEventWithBlockNumber(event) as SortableEvent & {
            _amount: BigNumberish;
            _to: string;
          };
          return {
            amount: eventSpread["_amount"],
            to: eventSpread["_to"],
            ...eventSpread,
          };
        });
        const eventsStorage = [
          this.l1DepositInitiatedEvents,
          this.l2DepositFinalizedEvents,
          this.l2DepositFinalizedEvents_DepositAdapter,
        ][index % 3];

        assign(eventsStorage, [monitoredAddress, l1Token], events);
      });
    }

    this.baseL1SearchConfig.fromBlock = l1SearchConfig.toBlock + 1;
    this.baseL1SearchConfig.fromBlock = l2SearchConfig.toBlock + 1;

    return this.computeOutstandingCrossChainTransfers(l1Tokens);
  }

  async sendTokenToTargetChain(
    address: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<TransactionResponse> {
    const { chainId: destinationChainId, l2Gas, txnClient } = this;
    assert(destinationChainId === 10, `chainId ${destinationChainId} is not supported`);

    const contract = this.getL1TokenGateway(l1Token);
    const originChainId = (await contract.provider.getNetwork()).chainId;
    assert(originChainId !== destinationChainId);

    let method = this.isSNX(l1Token) ? "depositTo" : "depositERC20";
    let args = this.isSNX(l1Token) ? [address, amount] : [l1Token, l2Token, amount, l2Gas, "0x"];

    assert(this.isSupportedToken(l1Token), `Token ${l1Token} is not supported`);
    // If this token is WETH(the tokenToEvent maps to the ETH method) then we modify the params to call bridgeWethToOvm
    // on the atomic depositor contract. Note that value is still 0 as this method will pull WETH from the caller.
    if (this.isWeth(l1Token)) {
      method = "bridgeWethToOvm";
      args = [address, amount, l2Gas, destinationChainId];
    }

    // Pad gas when bridging to Optimism: https://community.optimism.io/docs/developers/bedrock/differences
    const gasLimitMultiplier = 1.5;
    const _txnRequest: AugmentedTransaction = { contract, chainId: originChainId, method, args, gasLimitMultiplier };
    const { reason, succeed, transaction: txnRequest } = (await txnClient.simulate([_txnRequest]))[0];
    if (!succeed) {
      const message = `Failed to simulate ${method} deposit to chainId ${destinationChainId} for mainnet token ${l1Token}`;
      this.logger.warn({ at: this.getName(), message, reason });
      throw new Error(`${message} (${reason})`);
    }

    this.logger.debug({ at: this.getName(), message: "Bridging tokens", l1Token, l2Token, amount });
    return (await txnClient.submit(originChainId, [txnRequest]))[0];
  }

  async wrapEthIfAboveThreshold(threshold: BigNumber): Promise<TransactionResponse | null> {
    const { chainId, txnClient } = this;
    assert(chainId === 10, `chainId ${chainId} is not supported`);

    const ovmWeth = CONTRACT_ADDRESSES[10].weth;
    const ethBalance = await this.getSigner(chainId).getBalance();
    if (ethBalance.gt(threshold)) {
      const l2Signer = this.getSigner(chainId);
      const contract = new Contract(ovmWeth.address, ovmWeth.abi, l2Signer);
      const method = "deposit";
      const value = ethBalance.sub(threshold);
      this.logger.debug({ at: this.getName(), message: "Wrapping ETH", threshold, value, ethBalance });
      return (await txnClient.submit(chainId, [{ contract, chainId, method, args: [], value }]))[0];
    }
    return null;
  }

  async checkTokenApprovals(address: string, l1Tokens: string[]): Promise<void> {
    // We need to approve the Atomic depositor to bridge WETH to optimism via the ETH route.
    const associatedL1Bridges = l1Tokens.map((l1Token) => this.getL1TokenGateway(l1Token).address);
    await this.checkAndSendTokenApprovals(address, l1Tokens, associatedL1Bridges);
  }

  getL1Bridge(l1Token: string): Contract {
    if (this.chainId !== 10) {
      throw new Error(`chainId ${this.chainId} is not supported`);
    }
    const l1BridgeData = this.hasCustomL1Bridge(l1Token)
      ? this.customL1OptimismBridgeAddresses[l1Token]
      : CONTRACT_ADDRESSES[1].ovmStandardBridge;
    return new Contract(l1BridgeData.address, l1BridgeData.abi, this.getSigner(1));
  }

  getL1TokenGateway(l1Token: string): Contract {
    if (this.isWeth(l1Token)) {
      return this.getAtomicDepositor();
    } else {
      return this.getL1Bridge(l1Token);
    }
  }

  getL2Bridge(l1Token: string): Contract {
    if (this.chainId !== 10) {
      throw new Error(`chainId ${this.chainId} is not supported`);
    }
    const l2BridgeData = this.hasCustomL2Bridge(l1Token)
      ? this.customOvmBridgeAddresses[l1Token]
      : CONTRACT_ADDRESSES[10].ovmStandardBridge;
    return new Contract(l2BridgeData.address, l2BridgeData.abi, this.getSigner(this.chainId));
  }

  isSNX(l1Token: string): boolean {
    return l1Token.toLowerCase() === "0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f";
  }

  private hasCustomL1Bridge(l1Token: string): boolean {
    return l1Token in this.customL1OptimismBridgeAddresses;
  }

  private hasCustomL2Bridge(l1Token: string): boolean {
    return l1Token in this.customOvmBridgeAddresses;
  }
}
