import {
  assign,
  Contract,
  BigNumber,
  bnToHex,
  winston,
  Event,
  isDefined,
  BigNumberish,
  TransactionResponse,
  ZERO_ADDRESS,
  spreadEventWithBlockNumber,
  paginatedEventQuery,
  CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
  bnZero,
  assert,
} from "../../utils";
import { SpokePoolClient } from "../../clients";
import { SortableEvent, OutstandingTransfers } from "../../interfaces";
import { CONTRACT_ADDRESSES, SUPPORTED_TOKENS } from "../../common";
import { CCTPAdapter } from "./CCTPAdapter";

// ether bridge = 0x8484Ef722627bf18ca5Ae6BcF031c23E6e922B30
// erc20 bridge = 0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf
// matic bridge = 0x401f6c983ea34274ec46f84d70b31c151321188b

// When bridging ETH to Polygon we MUST send ETH which is then wrapped in the bridge to WETH. We are unable to send WETH
// directly over the bridge, just like in the Optimism/Boba cases.

// TODO: Move to ../../common/ContractAddresses.ts
const tokenToBridge = {
  [TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // USDC
  [TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // USDT
  [TOKEN_SYMBOLS_MAP.DAI.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.DAI.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // DAI
  [TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.WBTC.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // WBTC
  [TOKEN_SYMBOLS_MAP.UMA.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.UMA.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // UMA
  [TOKEN_SYMBOLS_MAP.BADGER.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.BADGER.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // BADGER
  [TOKEN_SYMBOLS_MAP.BAL.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.BAL.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // BAL
  [TOKEN_SYMBOLS_MAP.ACX.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.ACX.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // ACX
  [TOKEN_SYMBOLS_MAP.POOL.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.POOL.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // POOL
  [TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x8484Ef722627bf18ca5Ae6BcF031c23E6e922B30",
    l2TokenAddress: TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.POLYGON],
    l1Method: "LockedEther",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // WETH
  [TOKEN_SYMBOLS_MAP.MATIC.addresses[CHAIN_IDs.MAINNET]]: {
    l1BridgeAddress: "0x401f6c983ea34274ec46f84d70b31c151321188b",
    l2TokenAddress: ZERO_ADDRESS,
    l1Method: "NewDepositBlock",
    l1AmountProp: "amountOrNFTId",
    l2AmountProp: "amount",
  }, // MATIC
} as const;

type SupportedL1Token = string;

export class PolygonAdapter extends CCTPAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    const { POLYGON } = CHAIN_IDs;
    super(spokePoolClients, POLYGON, monitoredAddresses, logger, SUPPORTED_TOKENS[POLYGON]);
  }

  // On polygon a bridge transaction looks like a transfer from address(0) to the target.
  async getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<OutstandingTransfers> {
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();

    // Skip the tokens if we can't find the corresponding bridge.
    // This is a valid use case as it's more convenient to check cross chain transfers for all tokens
    // rather than maintaining a list of native bridge-supported tokens.
    const availableTokens = this.filterSupportedTokens(l1Tokens);

    const promises: Promise<Event[]>[] = [];
    const cctpOutstandingTransfersPromise: Record<string, Promise<SortableEvent[]>> = {};
    // Fetch bridge events for all monitored addresses. This function will not work to monitor the hub pool contract,
    // only the spoke pool address and EOA's.
    const monitoredAddresses = this.monitoredAddresses.filter((address) => address !== this.getHubPool().address);
    for (const monitoredAddress of monitoredAddresses) {
      for (const l1Token of availableTokens) {
        if (this.isL1TokenUsdc(l1Token)) {
          cctpOutstandingTransfersPromise[monitoredAddress] = this.getOutstandingCctpTransfers(monitoredAddress);
        }

        const l1Bridge = this.getL1Bridge(l1Token);
        const l2Token = this.getL2Token(l1Token);

        const l1Method = tokenToBridge[l1Token].l1Method;
        let l1SearchFilter: (string | undefined)[] = [];
        if (l1Method === "LockedERC20") {
          l1SearchFilter = [undefined /* depositor */, monitoredAddress /* depositReceiver */, l1Token];
        }
        if (l1Method === "LockedEther") {
          l1SearchFilter = [undefined /* depositor */, monitoredAddress /* depositReceiver */];
        }
        if (l1Method === "NewDepositBlock") {
          // @dev This won't work for tracking Hub to Spoke transfers since the l1 "owner" will be different
          // from the L2 "user". We leave it in here for future EOA relayer rebalancing of Matic.
          l1SearchFilter = [monitoredAddress /* owner */, TOKEN_SYMBOLS_MAP.MATIC.addresses[CHAIN_IDs.MAINNET]];
        }

        const l2Method =
          l1Token === TOKEN_SYMBOLS_MAP.MATIC.addresses[CHAIN_IDs.MAINNET] ? "TokenDeposited" : "Transfer";
        let l2SearchFilter: (string | undefined)[] = [];
        if (l2Method === "Transfer") {
          l2SearchFilter = [ZERO_ADDRESS, monitoredAddress];
        }
        if (l2Method === "TokenDeposited") {
          l2SearchFilter = [
            TOKEN_SYMBOLS_MAP.MATIC.addresses[CHAIN_IDs.MAINNET],
            ZERO_ADDRESS,
            monitoredAddress /* user */,
          ];
        }

        promises.push(
          paginatedEventQuery(l1Bridge, l1Bridge.filters[l1Method](...l1SearchFilter), l1SearchConfig),
          paginatedEventQuery(l2Token, l2Token.filters[l2Method](...l2SearchFilter), l2SearchConfig)
        );
      }
    }

    const [results, resolvedCCTPEvents] = await Promise.all([
      Promise.all(promises),
      Promise.all(monitoredAddresses.map((monitoredAddress) => cctpOutstandingTransfersPromise[monitoredAddress])),
    ]);
    const resultingCCTPEvents: Record<string, SortableEvent[]> = Object.fromEntries(
      monitoredAddresses.map((monitoredAddress, idx) => [monitoredAddress, resolvedCCTPEvents[idx]])
    );

    // 2 events per token.
    const numEventsPerMonitoredAddress = 2 * availableTokens.length;

    // Segregate the events list by monitored address.
    const resultsByMonitoredAddress = Object.fromEntries(
      monitoredAddresses.map((monitoredAddress, index) => {
        const start = index * numEventsPerMonitoredAddress;
        return [monitoredAddress, results.slice(start, start + numEventsPerMonitoredAddress)];
      })
    );

    // Process events for each monitored address.
    for (const monitoredAddress of monitoredAddresses) {
      const eventsToProcess = resultsByMonitoredAddress[monitoredAddress];
      eventsToProcess.forEach((result, index) => {
        if (eventsToProcess.length === 0) {
          return;
        }
        assert(eventsToProcess.length % 2 === 0, "Events list length should be even");
        const l1Token = availableTokens[Math.floor(index / 2)];
        const amountProp = index % 2 === 0 ? tokenToBridge[l1Token].l1AmountProp : tokenToBridge[l1Token].l2AmountProp;
        const events = result.map((event) => {
          // Hacky typing here. We should probably rework the structure of this function to improve.
          const eventSpread = spreadEventWithBlockNumber(event) as unknown as SortableEvent & {
            [amount in typeof amountProp]?: BigNumberish;
          } & { depositReceiver: string };
          return {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            amount: eventSpread[amountProp]!,
            to: eventSpread["depositReceiver"],
            ...eventSpread,
          };
        });
        const eventsStorage = index % 2 === 0 ? this.l1DepositInitiatedEvents : this.l2DepositFinalizedEvents;
        const l2Token = this.resolveL2TokenAddress(l1Token, false); // these are all either normal L2 tokens or bridged USDC
        assign(eventsStorage, [monitoredAddress, l1Token, l2Token], events);
      });
      if (isDefined(resultingCCTPEvents[monitoredAddress])) {
        assign(
          this.l1DepositInitiatedEvents,
          [
            monitoredAddress,
            TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId],
            TOKEN_SYMBOLS_MAP.USDC.addresses[this.chainId], // Must map to the USDC Native L2 token address
          ],
          resultingCCTPEvents[monitoredAddress]
        );
      }
    }

    this.baseL1SearchConfig.fromBlock = l1SearchConfig.toBlock + 1;
    this.baseL2SearchConfig.fromBlock = l2SearchConfig.toBlock + 1;

    return this.computeOutstandingCrossChainTransfers(availableTokens);
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
      let method = "depositFor";
      // note that the amount is the bytes 32 encoding of the amount.
      let args = [address, l1Token, bnToHex(amount)];

      // If this token is WETH (the tokenToEvent maps to the ETH method) then we modify the params to deposit ETH.
      if (this.isWeth(l1Token)) {
        method = "bridgeWethToPolygon";
        args = [address, amount.toString()];
      }
      return this._sendTokenToTargetChain(
        l1Token,
        l2Token,
        amount,
        this.getL1TokenGateway(l1Token),
        method,
        args,
        1,
        bnZero,
        simMode
      );
    }
  }

  async checkTokenApprovals(address: string, l1Tokens: string[]): Promise<void> {
    const l1TokenListToApprove = [];

    const associatedL1Bridges = l1Tokens
      .flatMap((l1Token) => {
        if (!this.isSupportedToken(l1Token)) {
          return [];
        }
        if (this.isWeth(l1Token)) {
          l1TokenListToApprove.push(l1Token);
          return [this.getL1TokenGateway(l1Token)?.address];
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

  getL1Bridge(l1Token: SupportedL1Token): Contract {
    return new Contract(
      tokenToBridge[l1Token].l1BridgeAddress,
      CONTRACT_ADDRESSES[1].polygonBridge.abi,
      this.getSigner(this.hubChainId)
    );
  }

  getL1TokenGateway(l1Token: string): Contract {
    if (this.isWeth(l1Token)) {
      return this.getAtomicDepositor();
    } else {
      return new Contract(
        CONTRACT_ADDRESSES[1].polygonRootChainManager.address,
        CONTRACT_ADDRESSES[1].polygonRootChainManager.abi,
        this.getSigner(this.hubChainId)
      );
    }
  }

  // Note that on polygon we dont query events on the L2 bridge. rather, we look for mint events on the L2 token.
  getL2Token(l1Token: SupportedL1Token): Contract {
    return new Contract(
      tokenToBridge[l1Token].l2TokenAddress,
      CONTRACT_ADDRESSES[137].withdrawableErc20.abi,
      this.getSigner(this.chainId)
    );
  }

  async wrapEthIfAboveThreshold(): Promise<TransactionResponse | null> {
    throw new Error("Unnecessary to wrap ETH on Polygon");
  }
}
