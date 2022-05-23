import { spreadEvent, assign, Contract, BigNumber, EventSearchConfig } from "../../utils";
import { toBN, Event, ZERO_ADDRESS, winston, paginatedEventQuery, Promise } from "../../utils";
import { SpokePoolClient } from "../../clients";
import { BaseAdapter } from "./BaseAdapter";
import { arbitrumL2Erc20GatewayInterface, arbitrumL1Erc20GatewayInterface } from "./ContractInterfaces";

const arbitrumL1GatewayAddresses = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "0xcEe284F754E854890e311e3280b767F80797180d", // USDC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "0xd92023E9d9911199a6711321D1277285e6d4e2db", // WETH
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0xd3b5b60020504bc3489d6949d545893982ba3011", // DAI
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": "0xa3a7b6f88361f48403514059f1f16c8e78d60eec", // WBTC
};

const firstBlockToSearch = 12640865;

const l2GatewayAddresses = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "0x096760F208390250649E3e8763348E783AEF5562", // USDC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "0x6c411aD3E74De3E7Bd422b94A27770f5B86C623B", // WETH
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0x467194771dae2967aef3ecbedd3bf9a310c76c65", // DAI
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": "0x09e9222e96e7b4ae2a407b98d48e330053351eee", // WBTC
};

export class ArbitrumAdapter extends BaseAdapter {
  constructor(
    readonly logger: any,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly relayerAddress: string
  ) {
    super(spokePoolClients);
    this.chainId = 42161;
    this.l1SearchConfig = { ...this.getSearchConfig(1), fromBlock: firstBlockToSearch };
    this.l2SearchConfig = { ...this.getSearchConfig(this.chainId), fromBlock: 0 };
  }
  async getOutstandingCrossChainTransfers(l1Tokens: string[]) {
    await this.updateFromBlockSearchConfig();
    this.logger.debug({ at: "ArbitrumAdapter", message: "Fetching outstanding transfers", l1Tokens });

    let promises = [];
    for (const l1Token of l1Tokens) {
      const l1Bridge = this.getL1Bridge(l1Token);
      const l2Bridge = this.getL2Bridge(l1Token);
      const searchFilter = [undefined, this.relayerAddress];
      promises.push(
        paginatedEventQuery(l1Bridge, l1Bridge.filters.DepositInitiated(...searchFilter), this.l1SearchConfig),
        paginatedEventQuery(l2Bridge, l2Bridge.filters.DepositFinalized(...searchFilter), this.l2SearchConfig)
      );
    }

    const results = await Promise.all(promises, { concurrency: 1 });
    results.forEach((result, index) => {
      const l1Token = l1Tokens[Math.floor(index / 2)];
      const storageName = index % 2 === 0 ? "l1DepositInitiatedEvents" : "l2DepositFinalizedEvents";
      assign(this[storageName], [l1Token], result);
    });

    let outstandingTransfers = {};
    for (const l1Token of l1Tokens) {
      const totalDepositsInitiated = this.l1DepositInitiatedEvents[l1Token]
        .filter((event: any) => event?.args?.l1Token.toLowerCase() == l1Token.toLowerCase())
        .map((event: Event) => event.args._amount)
        .reduce((acc, curr) => acc.add(curr), toBN(0));

      const totalDepositsFinalized = this.l2DepositFinalizedEvents[l1Token]
        .filter((event: any) => event?.args?.l1Token.toLowerCase() == l1Token.toLowerCase())
        .map((event: Event) => event.args.amount)
        .reduce((acc, curr) => acc.add(curr), toBN(0));
      outstandingTransfers[l1Token] = totalDepositsInitiated.sub(totalDepositsFinalized);
      console.log("Aribtrum totals", l1Token, totalDepositsInitiated.toString(), totalDepositsFinalized.toString());
    }

    return outstandingTransfers;
  }

  async checkTokenApprovals(l1Tokens: string[]) {
    // We dont need to do approvals for weth as optimism sends ETH over the bridge.
    const associatedL1Bridges = l1Tokens.map((l1Token) => this.getL1Bridge(l1Token).address);
    await this.checkAndSendTokenApprovals(l1Tokens, associatedL1Bridges);
  }

  getL1Bridge(l1Token: string) {
    return new Contract(arbitrumL1GatewayAddresses[l1Token], arbitrumL1Erc20GatewayInterface, this.getProvider(1));
  }

  getL2Bridge(l1Token: string) {
    return new Contract(l2GatewayAddresses[l1Token], arbitrumL2Erc20GatewayInterface, this.getProvider(this.chainId));
  }
}
