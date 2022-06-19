import { runTransaction, assign, Contract, BigNumber, bnToHex, winston } from "../../utils";
import { ZERO_ADDRESS, spreadEventWithBlockNumber, paginatedEventQuery, Promise } from "../../utils";
import { SpokePoolClient } from "../../clients";
import { BaseAdapter, polygonL1BridgeInterface, polygonL2BridgeInterface } from "./";
import { polygonL1RootChainManagerInterface, atomicDepositorInterface } from "./";

// ether bridge = 0x8484Ef722627bf18ca5Ae6BcF031c23E6e922B30
// erc20 bridfge = 0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf
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
};

const firstL1BlockToSearch = 10167767;

const atomicDepositorAddress = "0x26eaf37ee5daf49174637bdcd2f7759a25206c34";

export class PolygonAdapter extends BaseAdapter {
  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly relayerAddress: string
  ) {
    super(spokePoolClients, 137, firstL1BlockToSearch);
  }

  // On polygon a bridge transaction looks like a transfer from address(0) to the target.
  async getOutstandingCrossChainTransfers(l1Tokens: string[]) {
    await this.updateBlockSearchConfig();
    this.log("Getting cross-chain txs", { l1Tokens, l1Config: this.l1SearchConfig, l2Config: this.l2SearchConfig });

    let promises = [];
    for (const l1Token of l1Tokens) {
      const l1Bridge = this.getL1Bridge(l1Token);
      const l2Token = this.getL2Token(l1Token);

      const l1Method = tokenToBridge[l1Token].l1Method;
      let l1SearchFilter = [];
      if (l1Method == "LockedERC20") l1SearchFilter = [this.relayerAddress, undefined, l1Token];
      if (l1Method == "LockedEther") l1SearchFilter = [undefined, this.relayerAddress];
      if (l1Method == "NewDepositBlock") l1SearchFilter = [this.relayerAddress, l1MaticAddress];

      const l2Method = l1Token == l1MaticAddress ? "TokenDeposited" : "Transfer";
      let l2SearchFilter = [];
      if (l2Method == "Transfer") l2SearchFilter = [ZERO_ADDRESS, this.relayerAddress];
      if (l2Method == "TokenDeposited") l2SearchFilter = [l1MaticAddress, ZERO_ADDRESS, this.relayerAddress];

      promises.push(
        paginatedEventQuery(l1Bridge, l1Bridge.filters[l1Method](...l1SearchFilter), this.l1SearchConfig),
        paginatedEventQuery(l2Token, l2Token.filters[l2Method](...l2SearchFilter), this.l2SearchConfig)
      );
    }
    const results = await Promise.all(promises, { concurrency: 2 });
    results.forEach((result, index) => {
      const l1Token = l1Tokens[Math.floor(index / 2)];
      const amountProp = index % 2 === 0 ? tokenToBridge[l1Token].l1AmountProp : tokenToBridge[l1Token].l2AmountProp;
      const events = result.map((event) => {
        const eventSpread = spreadEventWithBlockNumber(event);
        return {
          amount: eventSpread[amountProp],
          to: eventSpread["depositReceiver"],
          blockNumber: eventSpread["blockNumber"],
        };
      });
      const storageName = index % 2 === 0 ? "l1DepositInitiatedEvents" : "l2DepositFinalizedEvents";
      assign(this[storageName], [l1Token], events);
    });

    this.l1SearchConfig.fromBlock = this.l1SearchConfig.toBlock + 1;
    this.l2SearchConfig.fromBlock = this.l2SearchConfig.toBlock + 1;

    return this.computeOutstandingCrossChainTransfers(l1Tokens);
  }

  async sendTokenToTargetChain(l1Token: string, l2Token: string, amount: BigNumber) {
    let method = "depositFor";
    // note that the amount is the bytes 32 encoding of the amount.
    let args = [this.relayerAddress, l1Token, bnToHex(amount)];

    // If this token is WETH(the tokenToEvent maps to the ETH method) then we modify the params to deposit ETH.
    if (this.isWeth(l1Token)) {
      method = "bridgeWethToPolygon";
      args = [this.relayerAddress, amount.toString()];
    }
    this.logger.debug({ at: this.getName(), message: "Bridging tokens", l1Token, l2Token, amount });
    return await runTransaction(this.logger, this.getL1TokenGateway(l1Token), method, args);
  }

  async checkTokenApprovals(l1Tokens: string[], isDryRun: boolean) {
    const associatedL1Bridges = l1Tokens.map((l1Token) => {
      if (this.isWeth(l1Token)) return this.getL1TokenGateway(l1Token)?.address;
      return this.getL1Bridge(l1Token)?.address;
    });
    await this.checkAndSendTokenApprovals(l1Tokens, associatedL1Bridges, isDryRun);
  }

  getL1Bridge(l1Token: string): Contract | null {
    try {
      return new Contract(tokenToBridge[l1Token].l1BridgeAddress, polygonL1BridgeInterface, this.getSigner(1));
    } catch (error) {
      this.log("Could not construct l1Bridge. Likely misconfiguration", { l1Token, error, tokenToBridge }, "error");
      return null;
    }
  }

  getL1TokenGateway(l1Token: string): Contract | null {
    if (this.isWeth(l1Token)) return new Contract(atomicDepositorAddress, atomicDepositorInterface, this.getSigner(1));
    else
      try {
        return new Contract(l1RootChainManager, polygonL1RootChainManagerInterface, this.getSigner(1));
      } catch (error) {
        this.log("Could not construct l1Bridge. Likely misconfiguration", { l1Token, error, tokenToBridge }, "error");
        return null;
      }
  }

  // Note that on polygon we dont query events on the L2 bridge. rather, we look for mint events on the L2 token.
  getL2Token(l1Token: string): Contract | null {
    try {
      return new Contract(
        tokenToBridge[l1Token].l2TokenAddress,
        polygonL2BridgeInterface,
        this.getSigner(this.chainId)
      );
    } catch (error) {
      this.log("Could not construct l2Token. Likely misconfiguration", { l1Token, error, tokenToBridge }, "error");
      return null;
    }
  }
}
