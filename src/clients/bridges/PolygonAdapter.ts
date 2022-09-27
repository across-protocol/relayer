import {
  runTransaction,
  assign,
  Contract,
  BigNumber,
  bnToHex,
  winston,
  Event,
  isDefined,
  BigNumberish,
} from "../../utils";
import { ZERO_ADDRESS, spreadEventWithBlockNumber, paginatedEventQuery, Promise } from "../../utils";
import { SpokePoolClient } from "../../clients";
import { BaseAdapter, polygonL1BridgeInterface, polygonL2BridgeInterface } from "./";
import { polygonL1RootChainManagerInterface, atomicDepositorInterface } from "./";
import { SortableEvent } from "../../interfaces";

// ether bridge = 0x8484Ef722627bf18ca5Ae6BcF031c23E6e922B30
// erc20 bridge = 0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf
// matic bridge = 0x401f6c983ea34274ec46f84d70b31c151321188b

// When bridging ETH to Polygon we MUST send ETH which is then wrapped in the bridge to WETH. We are unable to send WETH
// directly over the bridge, just like in the Optimism/Boba cases.

const l1MaticAddress = "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0";

const l1RootChainManager = "0xA0c68C638235ee32657e8f720a23ceC1bFc77C77";

const tokenToBridge = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7": {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // USDT
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // DAI
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // WBTC
  "0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828": {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: "0x3066818837c5e6ed6601bd5a91b0762877a6b731",
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // UMA
  "0x3472A5A71965499acd81997a54BBA8D852C6E53d": {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: "0x1FcbE5937B0cc2adf69772D228fA4205aCF4D9b2",
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // BADGER
  "0xba100000625a3754423978a60c9317c58a424e3D": {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: "0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A3",
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // BAL
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": {
    l1BridgeAddress: "0x8484Ef722627bf18ca5Ae6BcF031c23E6e922B30",
    l2TokenAddress: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    l1Method: "LockedEther",
    l1AmountProp: "amount",
    l2AmountProp: "value",
  }, // WETH
  [l1MaticAddress]: {
    l1BridgeAddress: "0x401f6c983ea34274ec46f84d70b31c151321188b",
    l2TokenAddress: ZERO_ADDRESS,
    l1Method: "NewDepositBlock",
    l1AmountProp: "amountOrNFTId",
    l2AmountProp: "amount",
  }, // MATIC
} as const;

type SupportedL1Token = keyof typeof tokenToBridge;

const atomicDepositorAddress = "0x26eaf37ee5daf49174637bdcd2f7759a25206c34";

export class PolygonAdapter extends BaseAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    super(spokePoolClients, 137, monitoredAddresses, logger);
  }

  // On polygon a bridge transaction looks like a transfer from address(0) to the target.
  async getOutstandingCrossChainTransfers(l1Tokens: string[]) {
    this.updateSearchConfigs();
    this.log("Getting cross-chain txs", { l1Tokens, l1Config: this.l1SearchConfig, l2Config: this.l2SearchConfig });

    const promises: Promise<Event[]>[] = [];
    const validTokens: SupportedL1Token[] = [];
    // Fetch bridge events for all monitored addresses.
    for (const monitoredAddress of this.monitoredAddresses) {
      for (const l1Token of l1Tokens) {
        const l1Bridge = this.getL1Bridge(l1Token);
        // Skip the token if we can't find the corresponding bridge.
        // This is a valid use case as it's more convenient to check cross chain transfers for all tokens
        // rather than maintaining a list of native bridge-supported tokens.
        if (l1Bridge === null) continue;

        const l2Token = this.getL2Token(l1Token);

        if (l2Token === null) continue;
        if (!this.isSupportedToken(l1Token)) continue;

        const l1Method = tokenToBridge[l1Token].l1Method;
        let l1SearchFilter: (string | undefined)[] = [];
        if (l1Method === "LockedERC20") l1SearchFilter = [monitoredAddress, undefined, l1Token];
        if (l1Method === "LockedEther") l1SearchFilter = [undefined, monitoredAddress];
        if (l1Method === "NewDepositBlock") l1SearchFilter = [monitoredAddress, l1MaticAddress];

        const l2Method = l1Token === l1MaticAddress ? "TokenDeposited" : "Transfer";
        let l2SearchFilter: (string | undefined)[] = [];
        if (l2Method === "Transfer") l2SearchFilter = [ZERO_ADDRESS, monitoredAddress];
        if (l2Method === "TokenDeposited") l2SearchFilter = [l1MaticAddress, ZERO_ADDRESS, monitoredAddress];

        promises.push(
          paginatedEventQuery(l1Bridge, l1Bridge.filters[l1Method](...l1SearchFilter), this.l1SearchConfig),
          paginatedEventQuery(l2Token, l2Token.filters[l2Method](...l2SearchFilter), this.l2SearchConfig)
        );
        validTokens.push(l1Token);
      }
    }

    const results = await Promise.all(promises);

    // 2 events per token.
    const numEventsPerMonitoredAddress = 2 * validTokens.length;

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
      eventsToProcess.forEach((result, index) => {
        const l1Token = validTokens[Math.floor(index / 2)];
        const amountProp = index % 2 === 0 ? tokenToBridge[l1Token].l1AmountProp : tokenToBridge[l1Token].l2AmountProp;
        const events = result.map((event) => {
          // Hacky typing here. We should probably rework the structure of this function to improve.
          const eventSpread = spreadEventWithBlockNumber(event) as unknown as SortableEvent & {
            [amount in typeof amountProp]?: BigNumberish;
          } & { depositReceiver: string };
          return {
            amount: eventSpread[amountProp]!,
            to: eventSpread["depositReceiver"],
            ...eventSpread,
          };
        });
        const eventsStorage = index % 2 === 0 ? this.l1DepositInitiatedEvents : this.l2DepositFinalizedEvents;
        assign(eventsStorage, [monitoredAddress, l1Token], events);
      });
    }

    this.l1SearchConfig.fromBlock = this.l1SearchConfig.toBlock + 1;
    this.l2SearchConfig.fromBlock = this.l2SearchConfig.toBlock + 1;

    return this.computeOutstandingCrossChainTransfers(validTokens);
  }

  async sendTokenToTargetChain(address: string, l1Token: string, l2Token: string, amount: BigNumber) {
    let method = "depositFor";
    // note that the amount is the bytes 32 encoding of the amount.
    let args = [address, l1Token, bnToHex(amount)];

    // If this token is WETH (the tokenToEvent maps to the ETH method) then we modify the params to deposit ETH.
    if (this.isWeth(l1Token)) {
      method = "bridgeWethToPolygon";
      args = [address, amount.toString()];
    }
    this.logger.debug({ at: this.getName(), message: "Bridging tokens", l1Token, l2Token, amount });
    return await runTransaction(this.logger, this.getL1TokenGateway(l1Token), method, args);
  }

  async checkTokenApprovals(address: string, l1Tokens: string[]) {
    const associatedL1Bridges = l1Tokens
      .map((l1Token) => {
        if (this.isWeth(l1Token)) return this.getL1TokenGateway(l1Token)?.address;
        return this.getL1Bridge(l1Token)?.address;
      })
      .filter(isDefined);
    await this.checkAndSendTokenApprovals(address, l1Tokens, associatedL1Bridges);
  }

  getL1Bridge(l1Token: string): Contract | null {
    if (this.isSupportedToken(l1Token))
      return new Contract(tokenToBridge[l1Token].l1BridgeAddress, polygonL1BridgeInterface, this.getSigner(1));
    else {
      this.log(
        "Could not construct l1Bridge due to unsupported l1Token. Likely misconfiguration",
        { l1Token, tokenToBridge },
        "error"
      );
      return null;
    }
  }

  getL1TokenGateway(l1Token: string): Contract {
    if (this.isWeth(l1Token)) return new Contract(atomicDepositorAddress, atomicDepositorInterface, this.getSigner(1));
    else return new Contract(l1RootChainManager, polygonL1RootChainManagerInterface, this.getSigner(1));
  }

  // Note that on polygon we dont query events on the L2 bridge. rather, we look for mint events on the L2 token.
  getL2Token(l1Token: string): Contract | null {
    if (this.isSupportedToken(l1Token))
      return new Contract(
        tokenToBridge[l1Token].l2TokenAddress,
        polygonL2BridgeInterface,
        this.getSigner(this.chainId)
      );
    else {
      this.log(
        "Could not construct l2Token due to unsupported l1Token. Likely misconfiguration",
        { l1Token, tokenToBridge },
        "error"
      );
      return null;
    }
  }

  private isSupportedToken(l1Token: string): l1Token is SupportedL1Token {
    return l1Token in tokenToBridge;
  }
}
