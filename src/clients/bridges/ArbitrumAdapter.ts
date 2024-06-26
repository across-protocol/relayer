import {
  assign,
  BigNumber,
  Contract,
  spreadEvent,
  spreadEventWithBlockNumber,
  winston,
  BigNumberish,
  isDefined,
  TransactionResponse,
  toBN,
  toWei,
  paginatedEventQuery,
  Event,
  assert,
  CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
  EventSearchConfig,
} from "../../utils";
import { SpokePoolClient } from "../../clients";
import { SortableEvent, OutstandingTransfers } from "../../interfaces";
import { CONTRACT_ADDRESSES, SUPPORTED_TOKENS } from "../../common";
import { CCTPAdapter } from "./CCTPAdapter";

// TODO: Move to ../../common/ContractAddresses.ts
// These values are obtained from Arbitrum's gateway router contract.
export const l1Gateways = {
  [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: "0xcEe284F754E854890e311e3280b767F80797180d", // USDC
  [TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]]: "0xcEe284F754E854890e311e3280b767F80797180d", // USDT
  [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: "0xd92023E9d9911199a6711321D1277285e6d4e2db", // WETH
  [TOKEN_SYMBOLS_MAP.DAI.addresses[CHAIN_IDs.MAINNET]]: "0xD3B5b60020504bc3489D6949d545893982BA3011", // DAI
  [TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.MAINNET]]: "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC", // WBTC
  [TOKEN_SYMBOLS_MAP.UMA.addresses[CHAIN_IDs.MAINNET]]: "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC", // UMA
  [TOKEN_SYMBOLS_MAP.BADGER.addresses[CHAIN_IDs.MAINNET]]: "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC", // BADGER
  [TOKEN_SYMBOLS_MAP.BAL.addresses[CHAIN_IDs.MAINNET]]: "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC", // BAL
  [TOKEN_SYMBOLS_MAP.ACX.addresses[CHAIN_IDs.MAINNET]]: "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC", // ACX
  [TOKEN_SYMBOLS_MAP.POOL.addresses[CHAIN_IDs.MAINNET]]: "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC", // POOL
} as const;

export const l2Gateways = {
  [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: "0x096760F208390250649E3e8763348E783AEF5562", // USDC
  [TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]]: "0x096760F208390250649E3e8763348E783AEF5562", // USDT
  [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: "0x6c411aD3E74De3E7Bd422b94A27770f5B86C623B", // WETH
  [TOKEN_SYMBOLS_MAP.DAI.addresses[CHAIN_IDs.MAINNET]]: "0x467194771dAe2967Aef3ECbEDD3Bf9a310C76C65", // DAI
  [TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.MAINNET]]: "0x09e9222E96E7B4AE2a407B98d48e330053351EEe", // WBTC
  [TOKEN_SYMBOLS_MAP.UMA.addresses[CHAIN_IDs.MAINNET]]: "0x09e9222E96E7B4AE2a407B98d48e330053351EEe", // UMA
  [TOKEN_SYMBOLS_MAP.BADGER.addresses[CHAIN_IDs.MAINNET]]: "0x09e9222E96E7B4AE2a407B98d48e330053351EEe", // BADGER
  [TOKEN_SYMBOLS_MAP.BAL.addresses[CHAIN_IDs.MAINNET]]: "0x09e9222E96E7B4AE2a407B98d48e330053351EEe", // BAL
  [TOKEN_SYMBOLS_MAP.ACX.addresses[CHAIN_IDs.MAINNET]]: "0x09e9222E96E7B4AE2a407B98d48e330053351EEe", // ACX
  [TOKEN_SYMBOLS_MAP.POOL.addresses[CHAIN_IDs.MAINNET]]: "0x09e9222E96E7B4AE2a407B98d48e330053351EEe", // POOL
} as const;

type SupportedL1Token = string;

// TODO: replace these numbers using the arbitrum SDK. these are bad values that mean we will over pay but transactions
// wont get stuck.

export class ArbitrumAdapter extends CCTPAdapter {
  l2GasPrice: BigNumber = toBN(20e9);
  l2GasLimit: BigNumber = toBN(150000);
  // abi.encoding of the maxL2Submission cost. of 0.01e18
  transactionSubmissionData =
    "0x000000000000000000000000000000000000000000000000002386f26fc1000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000";

  l1SubmitValue: BigNumber = toWei(0.013);
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    const { ARBITRUM } = CHAIN_IDs;
    super(spokePoolClients, ARBITRUM, monitoredAddresses, logger, SUPPORTED_TOKENS[ARBITRUM]);
  }

  async getL1DepositInitiatedEvents(
    l1Token: string,
    monitoredAddress: string,
    l1SearchConfig: EventSearchConfig
  ): Promise<Event[]> {
    const l1Bridge = this.getL1Bridge(l1Token);

    // l1Token is not an indexed field on deposit events in L1 but is on finalization events on Arb.
    // This unfortunately leads to fetching of all deposit events for all tokens multiple times, one per l1Token.
    // There's likely not much we can do here as the deposit events don't have l1Token as an indexed field.
    // https://github.com/OffchainLabs/arbitrum/blob/master/packages/arb-bridge-peripherals/contracts/tokenbridge/ethereum/gateway/L1ArbitrumGateway.sol#L51
    const l1SearchFilter = [undefined, monitoredAddress];
    const events = await paginatedEventQuery(
      l1Bridge,
      l1Bridge.filters.DepositInitiated(...l1SearchFilter),
      l1SearchConfig
    );
    // l1Token is not an indexed field on Aribtrum gateway's deposit events, so these events are for all tokens.
    // Therefore, we need to filter unrelated deposits of other tokens.
    const filteredEvents = events.filter((event) => event.args.l1Token === l1Token);
    return filteredEvents;
  }

  async getL2DepositFinalizedEvents(
    l1Token: string,
    monitoredAddress: string,
    l2SearchConfig: EventSearchConfig
  ): Promise<Event[]> {
    const l2Bridge = this.getL2Bridge(l1Token);

    // https://github.com/OffchainLabs/arbitrum/blob/d75568fa70919364cf56463038c57c96d1ca8cda/packages/arb-bridge-peripherals/contracts/tokenbridge/arbitrum/gateway/L2ArbitrumGateway.sol#L40
    const l2SearchFilter = [l1Token, monitoredAddress, undefined];
    const events = await paginatedEventQuery(
      l2Bridge,
      l2Bridge.filters.DepositFinalized(...l2SearchFilter),
      l2SearchConfig
    );
    return events;
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<OutstandingTransfers> {
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();

    // Skip the token if we can't find the corresponding bridge.
    // This is a valid use case as it's more convenient to check cross chain transfers for all tokens
    // rather than maintaining a list of native bridge-supported tokens.
    const availableL1Tokens = this.filterSupportedTokens(l1Tokens);

    const promises: Promise<Event[]>[] = [];
    const cctpOutstandingTransfersPromise: Record<string, Promise<SortableEvent[]>> = {};
    // Fetch bridge events for all monitored addresses.
    for (const monitoredAddress of this.monitoredAddresses) {
      for (const l1Token of availableL1Tokens) {
        if (this.isL1TokenUsdc(l1Token)) {
          cctpOutstandingTransfersPromise[monitoredAddress] = this.getOutstandingCctpTransfers(monitoredAddress);
        }

        promises.push(
          this.getL1DepositInitiatedEvents(l1Token, monitoredAddress, l1SearchConfig),
          this.getL2DepositFinalizedEvents(l1Token, monitoredAddress, l2SearchConfig)
        );
      }
    }

    const [results, resolvedCCTPEvents] = await Promise.all([
      Promise.all(promises),
      Promise.all(this.monitoredAddresses.map((monitoredAddress) => cctpOutstandingTransfersPromise[monitoredAddress])),
    ]);
    const resultingCCTPEvents: Record<string, SortableEvent[]> = Object.fromEntries(
      this.monitoredAddresses.map((monitoredAddress, idx) => [monitoredAddress, resolvedCCTPEvents[idx]])
    );

    // 2 events per token.
    const numEventsPerMonitoredAddress = 2 * availableL1Tokens.length;

    // Segregate the events list by monitored address.
    const resultsByMonitoredAddress = Object.fromEntries(
      this.monitoredAddresses.map((monitoredAddress, index) => {
        const start = index * numEventsPerMonitoredAddress;
        return [monitoredAddress, results.slice(start, start + numEventsPerMonitoredAddress)];
      })
    );

    // Process events for each monitored address.
    for (const monitoredAddress of this.monitoredAddresses) {
      const eventsToProcess = resultsByMonitoredAddress[monitoredAddress];
      // The logic below takes the results from the promises and spreads them into the l1DepositInitiatedEvents and
      // l2DepositFinalizedEvents state from the BaseAdapter.
      eventsToProcess.forEach((result, index) => {
        if (eventsToProcess.length === 0) {
          return;
        }
        assert(eventsToProcess.length % 2 === 0, "Events list length should be even");
        const l1Token = availableL1Tokens[Math.floor(index / 2)];
        // l1Token is not an indexed field on Aribtrum gateway's deposit events, so these events are for all tokens.
        // Therefore, we need to filter unrelated deposits of other tokens.
        const filteredEvents = result.filter((event) => spreadEvent(event.args)["l1Token"] === l1Token);
        const events = filteredEvents.map((event) => {
          // TODO: typing here is a little janky. To get these right, we'll probably need to rework how we're sorting
          // these different types of events into the array to get stronger guarantees when extracting them.
          const eventSpread = spreadEventWithBlockNumber(event) as SortableEvent & {
            amount: BigNumberish;
            _amount: BigNumberish;
          };
          return {
            ...eventSpread,
            amount: eventSpread[index % 2 === 0 ? "_amount" : "amount"],
          };
        });
        const eventsStorage = index % 2 === 0 ? this.l1DepositInitiatedEvents : this.l2DepositFinalizedEvents;
        const l2Token = this.resolveL2TokenAddress(l1Token, false); // This codepath will never have native USDC - therefore we should pass `false`.
        assign(eventsStorage, [monitoredAddress, l1Token, l2Token], events);
      });
      if (isDefined(resultingCCTPEvents[monitoredAddress])) {
        const usdcL1Token = TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId];
        const usdcL2Token = this.resolveL2TokenAddress(usdcL1Token, true); // Must specifically be native USDC
        assign(
          this.l1DepositInitiatedEvents,
          [monitoredAddress, usdcL1Token, usdcL2Token],
          resultingCCTPEvents[monitoredAddress]
        );
      }
    }

    return this.computeOutstandingCrossChainTransfers(availableL1Tokens);
  }

  async checkTokenApprovals(address: string, l1Tokens: string[]): Promise<void> {
    const l1TokenListToApprove = [];

    // Note we send the approvals to the L1 Bridge but actually send outbound transfers to the L1 Gateway Router.
    // Note that if the token trying to be approved is not configured in this client (i.e. not in the l1Gateways object)
    // then this will pass null into the checkAndSendTokenApprovals. This method gracefully deals with this case.
    const associatedL1Bridges = l1Tokens
      .flatMap((l1Token) => {
        if (!this.isSupportedToken(l1Token)) {
          return [];
        }
        const bridgeAddresses: string[] = [];
        if (this.isL1TokenUsdc(l1Token)) {
          bridgeAddresses.push(this.getL1CCTPTokenMessengerBridge().address);
        }
        bridgeAddresses.push(this.getL1Bridge(l1Token).address);

        // Push the l1 token to the list of tokens to approve N times, where N is the number of bridges.
        // I.e. the arrays have to be parallel.
        l1TokenListToApprove.push(...Array(bridgeAddresses.length).fill(l1Token));

        return bridgeAddresses;
      })
      .filter(isDefined);
    await this.checkAndSendTokenApprovals(address, l1TokenListToApprove, associatedL1Bridges);
  }

  sendTokenToTargetChain(
    address: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    simMode = false
  ): Promise<TransactionResponse> {
    // If both the L1 & L2 tokens are native USDC, we use the CCTP bridge.
    if (this.isL1TokenUsdc(l1Token) && this.isL2TokenUsdc(l2Token)) {
      return this.sendCctpTokenToTargetChain(address, l1Token, l2Token, amount, simMode);
    } else {
      const args = [
        l1Token, // token
        address, // to
        amount, // amount
        this.l2GasLimit, // maxGas
        this.l2GasPrice, // gasPriceBid
        this.transactionSubmissionData, // data
      ];
      // Pad gas for deposits to Arbitrum to account for under-estimation in Geth. Offchain Labs confirm that this is
      // due to their use of BASEFEE to trigger conditional logic. https://github.com/ethereum/go-ethereum/pull/28470.
      const gasMultiplier = 1.2;
      return this._sendTokenToTargetChain(
        l1Token,
        l2Token,
        amount,
        this.getL1GatewayRouter(),
        "outboundTransfer",
        args,
        gasMultiplier,
        this.l1SubmitValue,
        simMode
      );
    }
  }

  // The arbitrum relayer expects to receive ETH steadily per HubPool bundle processed, since it is the L2 refund
  // address hardcoded in the Arbitrum Adapter.
  async wrapEthIfAboveThreshold(
    threshold: BigNumber,
    target: BigNumber,
    simMode = false
  ): Promise<TransactionResponse | null> {
    const { chainId } = this;
    assert(42161 === chainId, `chainId ${chainId} is not supported`);

    const weth = CONTRACT_ADDRESSES[this.chainId].weth;
    const ethBalance = await this.getSigner(chainId).getBalance();

    if (ethBalance.gt(threshold)) {
      const l2Signer = this.getSigner(chainId);
      const contract = new Contract(weth.address, weth.abi, l2Signer);
      const value = ethBalance.sub(target);
      this.logger.debug({ at: this.getName(), message: "Wrapping ETH", threshold, target, value, ethBalance });
      return await this._wrapEthIfAboveThreshold(threshold, contract, value, simMode);
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

  protected getL1Bridge(l1Token: SupportedL1Token): Contract {
    return new Contract(
      l1Gateways[l1Token],
      CONTRACT_ADDRESSES[1].arbitrumErc20GatewayRouter.abi,
      this.getSigner(this.hubChainId)
    );
  }

  protected getL1GatewayRouter(): Contract {
    return new Contract(
      CONTRACT_ADDRESSES[1].arbitrumErc20GatewayRouter.address,
      CONTRACT_ADDRESSES[1].arbitrumErc20GatewayRouter.abi,
      this.getSigner(this.hubChainId)
    );
  }

  protected getL2Bridge(l1Token: SupportedL1Token): Contract {
    return new Contract(l2Gateways[l1Token], CONTRACT_ADDRESSES[42161].erc20Gateway.abi, this.getSigner(this.chainId));
  }
}
