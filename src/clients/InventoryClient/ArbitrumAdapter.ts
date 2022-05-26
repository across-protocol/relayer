import { spreadEvent, assign, Contract, runTransaction, EventSearchConfig } from "../../utils";
import { toBN, toWei, Event, winston, paginatedEventQuery, Promise } from "../../utils";
import { SpokePoolClient } from "../../clients";
import { BaseAdapter } from "./BaseAdapter";
import { arbitrumL2Erc20GatewayInterface, arbitrumL1Erc20GatewayInterface } from "./ContractInterfaces";

const l1GatewayAddresses = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "0xcEe284F754E854890e311e3280b767F80797180d", // USDC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "0xd92023E9d9911199a6711321D1277285e6d4e2db", // WETH
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0xd3b5b60020504bc3489d6949d545893982ba3011", // DAI
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": "0xa3a7b6f88361f48403514059f1f16c8e78d60eec", // WBTC
};

const l1GatewayRouter = "0x72ce9c846789fdb6fc1f34ac4ad25dd9ef7031ef";

const firstBlockToSearch = 12640865;

const l2GatewayAddresses = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "0x096760F208390250649E3e8763348E783AEF5562", // USDC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "0x6c411aD3E74De3E7Bd422b94A27770f5B86C623B", // WETH
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0x467194771dae2967aef3ecbedd3bf9a310c76c65", // DAI
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": "0x09e9222e96e7b4ae2a407b98d48e330053351eee", // WBTC
};

// TODO: replace these numbers using the arbitrum SDK. these are bad values that mean we will over pay but transactions
// wont get stuck. These are the same params we are using in the smart contracts.
const l2GasPrice = toBN(5e9);
const l2GasLimit = toBN(2000000);
// abi.encodeing of the maxL2Submission cost. of 0.01e18
const transactionSubmissionData =
  "0x000000000000000000000000000000000000000000000000002386f26fc1000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000";
const l1SubmitValue = toWei(0.02);

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
      if (l1GatewayAddresses[l1Token] === undefined || l2GatewayAddresses[l1Token] === null) continue;

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
    // Note we send the approvals to the L1 Bridge but actually send outbound transfers to the L1 Gateway Router.
    const associatedL1Bridges = l1Tokens.map((l1Token) => this.getL1Bridge(l1Token).address);
    await this.checkAndSendTokenApprovals(l1Tokens, associatedL1Bridges);
  }

  async sendTokenToTargetChain(l1Token, l2Token, amount) {
    this.logger.debug({ at: this.getName(), message: "Bridging tokens", l1Token, l2Token, amount });
    const args = [l1Token, this.relayerAddress, amount, l2GasLimit, l2GasPrice, transactionSubmissionData];
    const tx = await runTransaction(this.logger, this.getL1GatewayRouter(), "outboundTransfer", args, l1SubmitValue);
    return await tx.wait();
  }

  getL1Bridge(l1Token: string) {
    return new Contract(l1GatewayAddresses[l1Token], arbitrumL1Erc20GatewayInterface, this.getProvider(1));
  }

  getL1GatewayRouter() {
    return new Contract(l1GatewayRouter, arbitrumL1Erc20GatewayInterface, this.getProvider(1));
  }

  getL2Bridge(l1Token: string) {
    return new Contract(l2GatewayAddresses[l1Token], arbitrumL2Erc20GatewayInterface, this.getProvider(this.chainId));
  }
}
