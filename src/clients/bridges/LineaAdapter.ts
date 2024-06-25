import * as sdk from "@across-protocol/sdk";
import { CONTRACT_ADDRESSES, SUPPORTED_TOKENS } from "../../common";
import { OutstandingTransfers } from "../../interfaces";
import {
  BigNumber,
  CHAIN_IDs,
  Contract,
  EventSearchConfig,
  Event,
  TOKEN_SYMBOLS_MAP,
  TransactionResponse,
  assert,
  bnZero,
  compareAddressesSimple,
  isDefined,
  paginatedEventQuery,
  winston,
} from "../../utils";
import { SpokePoolClient } from "../SpokePoolClient";
import { BaseAdapter } from "./BaseAdapter";

export class LineaAdapter extends BaseAdapter {
  readonly l1TokenBridge = CONTRACT_ADDRESSES[this.hubChainId].lineaL1TokenBridge.address;
  readonly l1UsdcBridge = CONTRACT_ADDRESSES[this.hubChainId].lineaL1UsdcBridge.address;

  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    const { LINEA } = CHAIN_IDs;
    super(spokePoolClients, LINEA, monitoredAddresses, logger, SUPPORTED_TOKENS[LINEA]);
  }
  async checkTokenApprovals(l1Tokens: string[]): Promise<void> {
    const address = await this.getSigner(this.hubChainId).getAddress();
    // Note: Linea has two bridges: one for
    const associatedL1Bridges = l1Tokens
      .map((l1Token) => {
        if (!this.isSupportedToken(l1Token)) {
          return null;
        }
        return this.getL1Bridge(l1Token).address;
      })
      .filter(isDefined);
    await this.checkAndSendTokenApprovals(address, l1Tokens, associatedL1Bridges);
  }

  async wrapEthIfAboveThreshold(
    threshold: BigNumber,
    target: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse> {
    const { chainId } = this;
    assert(sdk.utils.chainIsLinea(chainId), `ChainId ${chainId} is not supported as a Linea chain`);
    const { address: wethAddress, abi: wethABI } = CONTRACT_ADDRESSES[this.chainId].weth;
    const ethBalance = await this.getSigner(chainId).getBalance();
    if (ethBalance.gt(threshold)) {
      const l2Signer = this.getSigner(chainId);
      const contract = new Contract(wethAddress, wethABI, l2Signer);
      const value = ethBalance.sub(target);
      this.logger.debug({ at: this.getName(), message: "Wrapping ETH", threshold, target, value, ethBalance });
      return this._wrapEthIfAboveThreshold(threshold, contract, value, simMode);
    } else {
      this.logger.debug({
        at: this.getName(),
        message: "ETH balance below threshold",
        threshold,
        ethBalance,
      });
    }
    return null;
  }

  getL2MessageService(): Contract {
    const chainId = this.chainId;
    return new Contract(
      CONTRACT_ADDRESSES[chainId].l2MessageService.address,
      CONTRACT_ADDRESSES[chainId].l2MessageService.abi,
      this.getSigner(chainId)
    );
  }

  getL1MessageService(): Contract {
    const { hubChainId } = this;
    return new Contract(
      CONTRACT_ADDRESSES[hubChainId].lineaMessageService.address,
      CONTRACT_ADDRESSES[hubChainId].lineaMessageService.abi,
      this.getSigner(hubChainId)
    );
  }

  getL1TokenBridge(): Contract {
    const { hubChainId } = this;
    return new Contract(
      this.l1TokenBridge,
      CONTRACT_ADDRESSES[hubChainId].lineaL1TokenBridge.abi,
      this.getSigner(hubChainId)
    );
  }

  getL1UsdcBridge(): Contract {
    const { hubChainId } = this;
    return new Contract(
      this.l1UsdcBridge,
      CONTRACT_ADDRESSES[hubChainId].lineaL1UsdcBridge.abi,
      this.getSigner(hubChainId)
    );
  }

  getL2TokenBridge(): Contract {
    const chainId = this.chainId;
    return new Contract(
      CONTRACT_ADDRESSES[chainId].lineaL2TokenBridge.address,
      CONTRACT_ADDRESSES[chainId].lineaL2TokenBridge.abi,
      this.getSigner(chainId)
    );
  }

  getL2UsdcBridge(): Contract {
    const chainId = this.chainId;
    return new Contract(
      CONTRACT_ADDRESSES[chainId].lineaL2UsdcBridge.address,
      CONTRACT_ADDRESSES[chainId].lineaL2UsdcBridge.abi,
      this.getSigner(chainId)
    );
  }

  getL2Bridge(l1Token: string): Contract {
    return this.isUsdc(l1Token) ? this.getL2UsdcBridge() : this.getL2TokenBridge();
  }

  isUsdc(l1Token: string): boolean {
    return compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]);
  }

  getL1Bridge(l1Token: string): Contract {
    return this.isWeth(l1Token)
      ? this.getAtomicDepositor()
      : this.isUsdc(l1Token)
      ? this.getL1UsdcBridge()
      : this.getL1TokenBridge();
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<OutstandingTransfers> {
    const outstandingTransfers: OutstandingTransfers = {};
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();
    const supportedL1Tokens = this.filterSupportedTokens(l1Tokens);
    await sdk.utils.mapAsync(this.monitoredAddresses, async (address) => {
      // We can only support monitoring the spoke pool contract, not the hub pool.
      if (address === CONTRACT_ADDRESSES[this.hubChainId]?.hubPool?.address) {
        return;
      }
      await sdk.utils.mapAsync(supportedL1Tokens, async (l1Token) => {
        if (this.isWeth(l1Token)) {
          const l1MessageService = this.getL1MessageService();
          const l2MessageService = this.getL2MessageService();

          // We need to do the following sequential steps.
          // 1. Get all initiated MessageSent events from the L1MessageService where the 'to' address is the
          //    user's address.
          // 2. Pipe the resulting _messageHash argument from step 1 into the MessageClaimed event filter
          // 3. For each MessageSent, match the _messageHash to the _messageHash in the MessageClaimed event
          //    any unmatched MessageSent events are considered outstanding transfers.
          const initiatedQueryResult = await this.getWethDepositInitiatedEvents(
            l1MessageService,
            address,
            l1SearchConfig
          );
          const internalMessageHashes = initiatedQueryResult.map(({ args }) => args._messageHash);
          const finalizedQueryResult = await this.getWethDepositFinalizedEvents(
            l2MessageService,
            internalMessageHashes,
            l2SearchConfig
          );
          this.matchWethDepositEvents(
            initiatedQueryResult,
            finalizedQueryResult,
            outstandingTransfers,
            address,
            l1Token
          );
        } else {
          const isUsdc = this.isUsdc(l1Token);
          const l1Bridge = this.getL1Bridge(l1Token);
          const l2Bridge = this.getL2Bridge(l1Token);

          // Define the initialized and finalized event filters for the L1 and L2 bridges. We only filter
          // on the recipient so that the filters work both to track Hub-->Spoke transfers and EOA transfers, and
          // because some filters like ReceivedFromOtherLayer only index the recipient.
          const [initiatedQueryResult, finalizedQueryResult] = await Promise.all([
            isUsdc
              ? this.getUsdcDepositInitiatedEvents(l1Bridge, address, l1SearchConfig)
              : this.getErc20DepositInitiatedEvents(l1Bridge, address, l1Token, l1SearchConfig),
            isUsdc
              ? this.getUsdcDepositFinalizedEvents(l2Bridge, address, l2SearchConfig)
              : this.getErc20DepositFinalizedEvents(l2Bridge, address, l1Token, l2SearchConfig),
          ]);
          if (isUsdc) {
            this.matchUsdcDepositEvents(
              initiatedQueryResult,
              finalizedQueryResult,
              outstandingTransfers,
              address,
              l1Token
            );
          } else {
            this.matchErc20DepositEvents(
              initiatedQueryResult,
              finalizedQueryResult,
              outstandingTransfers,
              address,
              l1Token
            );
          }
        }
      });
    });
    return outstandingTransfers;
  }

  async getWethDepositInitiatedEvents(
    l1MessageService: Contract,
    l2RecipientAddress: string,
    l1SearchConfig: EventSearchConfig
  ): Promise<Event[]> {
    const _initiatedQueryResult = await paginatedEventQuery(
      l1MessageService,
      l1MessageService.filters.MessageSent(null, l2RecipientAddress),
      l1SearchConfig
    );
    // @dev There will be a MessageSent to the SpokePool address for each RelayedRootBundle so remove
    // those with 0 value.
    return _initiatedQueryResult.filter(({ args }) => args._value.gt(0));
  }

  async getWethDepositFinalizedEvents(
    l2MessageService: Contract,
    internalMessageHashes: string[],
    l2SearchConfig: EventSearchConfig
  ): Promise<Event[]> {
    return await paginatedEventQuery(
      l2MessageService,
      // Passing in an array of message hashes results in an OR filter
      l2MessageService.filters.MessageClaimed(internalMessageHashes),
      l2SearchConfig
    );
  }

  matchWethDepositEvents(
    initiatedQueryResult: Event[],
    finalizedQueryResult: Event[],
    outstandingTransfers: OutstandingTransfers,
    monitoredAddress: string,
    l1Token: string
  ): void {
    const transferEvents = initiatedQueryResult.filter(
      ({ args }) =>
        !finalizedQueryResult.some(
          (finalizedEvent) => args._messageHash.toLowerCase() === finalizedEvent.args._messageHash.toLowerCase()
        )
    );
    this.computeOutstandingTransfers(outstandingTransfers, monitoredAddress, l1Token, transferEvents);
  }

  computeOutstandingTransfers(
    outstandingTransfers: OutstandingTransfers,
    monitoredAddress: string,
    l1Token: string,
    transferEvents: Event[]
  ): void {
    const l2Token = this.resolveL2TokenAddress(l1Token, false); // There's no native USDC on Linea
    assert(!isDefined(TOKEN_SYMBOLS_MAP.USDC.addresses[this.chainId])); // We can blow up if this eventually stops being true
    transferEvents.forEach((event) => {
      const txHash = event.transactionHash;
      // @dev WETH events have a _value field, while ERC20 events have an amount field.
      const amount = event.args._value ?? event.args.amount;
      outstandingTransfers[monitoredAddress] ??= {};
      outstandingTransfers[monitoredAddress][l1Token] ??= {};
      outstandingTransfers[monitoredAddress][l1Token][l2Token] ??= { totalAmount: bnZero, depositTxHashes: [] };
      outstandingTransfers[monitoredAddress][l1Token][l2Token] = {
        totalAmount: outstandingTransfers[monitoredAddress][l1Token][l2Token].totalAmount.add(amount),
        depositTxHashes: [...outstandingTransfers[monitoredAddress][l1Token][l2Token].depositTxHashes, txHash],
      };
    });
  }

  async getErc20DepositInitiatedEvents(
    l1Bridge: Contract,
    monitoredAddress: string,
    l1Token: string,
    l1SearchConfig: EventSearchConfig
  ): Promise<Event[]> {
    const initiatedQueryResult = await paginatedEventQuery(
      l1Bridge,
      l1Bridge.filters.BridgingInitiatedV2(null /* sender */, monitoredAddress /* recipient */, l1Token),
      l1SearchConfig
    );
    return initiatedQueryResult;
  }

  async getErc20DepositFinalizedEvents(
    l2Bridge: Contract,
    monitoredAddress: string,
    l1Token: string,
    l2SearchConfig: EventSearchConfig
  ): Promise<Event[]> {
    const finalizedQueryResult = await paginatedEventQuery(
      l2Bridge,
      l2Bridge.filters.BridgingFinalizedV2(
        l1Token,
        null /* bridgedToken */,
        null /* bridgedToken */,
        monitoredAddress /* recipient */
      ),
      l2SearchConfig
    );
    return finalizedQueryResult;
  }

  matchErc20DepositEvents(
    initiatedQueryResult: Event[],
    finalizedQueryResult: Event[],
    outstandingTransfers: OutstandingTransfers,
    monitoredAddress: string,
    l1Token: string
  ): void {
    const transferEvents = initiatedQueryResult.filter(
      (initialEvent) =>
        !isDefined(
          finalizedQueryResult.find(
            (finalEvent) =>
              finalEvent.args.amount.eq(initialEvent.args.amount) &&
              compareAddressesSimple(initialEvent.args.recipient, finalEvent.args.recipient) &&
              compareAddressesSimple(finalEvent.args.nativeToken, initialEvent.args.token)
          )
        )
    );

    this.computeOutstandingTransfers(outstandingTransfers, monitoredAddress, l1Token, transferEvents);
  }

  getUsdcDepositInitiatedEvents(
    l1Bridge: Contract,
    monitoredAddress: string,
    l1SearchConfig: EventSearchConfig
  ): Promise<Event[]> {
    return paginatedEventQuery(
      l1Bridge,
      l1Bridge.filters.Deposited(null /* depositor */, null /* amount */, monitoredAddress /* to */),
      l1SearchConfig
    );
  }

  getUsdcDepositFinalizedEvents(
    l2Bridge: Contract,
    monitoredAddress: string,
    l2SearchConfig: EventSearchConfig
  ): Promise<Event[]> {
    return paginatedEventQuery(
      l2Bridge,
      l2Bridge.filters.ReceivedFromOtherLayer(monitoredAddress /* recipient */),
      l2SearchConfig
    );
  }

  matchUsdcDepositEvents(
    initiatedQueryResult: Event[],
    finalizedQueryResult: Event[],
    outstandingTransfers: OutstandingTransfers,
    monitoredAddress: string,
    l1Token: string
  ): void {
    const transferEvents = initiatedQueryResult.filter(
      (initialEvent) =>
        !isDefined(
          finalizedQueryResult.find(
            (finalEvent) =>
              finalEvent.args.amount.eq(initialEvent.args.amount) &&
              compareAddressesSimple(initialEvent.args.to, finalEvent.args.recipient)
          )
        )
    );
    this.computeOutstandingTransfers(outstandingTransfers, monitoredAddress, l1Token, transferEvents);
  }

  sendTokenToTargetChain(
    address: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse> {
    const isWeth = this.isWeth(l1Token);
    const isUsdc = this.isUsdc(l1Token);
    const l1Bridge = this.getL1Bridge(l1Token);
    const l1BridgeMethod = isWeth ? "bridgeWethToLinea" : isUsdc ? "depositTo" : "bridgeToken";
    // prettier-ignore
    const l1BridgeArgs = isUsdc
      ? [amount, address]
      : isWeth
        ? [address, amount]
        : [l1Token, amount, address];

    return this._sendTokenToTargetChain(
      l1Token,
      l2Token,
      amount,
      l1Bridge,
      l1BridgeMethod,
      l1BridgeArgs,
      2,
      bnZero,
      simMode
    );
  }
}
