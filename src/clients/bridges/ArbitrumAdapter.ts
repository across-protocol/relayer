import { assign, BigNumber, Contract, runTransaction, spreadEventWithBlockNumber, winston } from "../../utils";
import { toBN, toWei, paginatedEventQuery, Promise } from "../../utils";
import { SpokePoolClient } from "../../clients";
import { BaseAdapter } from "./BaseAdapter";
import { arbitrumL2Erc20GatewayInterface, arbitrumL1Erc20GatewayInterface } from "./ContractInterfaces";

// These values are obtained from Arbitrum's gateway router contract.
const l1Gateways = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "0xcEe284F754E854890e311e3280b767F80797180d", // USDC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "0xd92023E9d9911199a6711321D1277285e6d4e2db", // WETH
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0xd3b5b60020504bc3489d6949d545893982ba3011", // DAI
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": "0xa3a7b6f88361f48403514059f1f16c8e78d60eec", // WBTC
  "0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828": "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC", // UMA
  "0x3472A5A71965499acd81997a54BBA8D852C6E53d": "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC", // BADGER
};

const l1GatewayRouter = "0x72ce9c846789fdb6fc1f34ac4ad25dd9ef7031ef";

const firstL1BlockToSearch = 12640865;

const l2Gateways = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "0x096760F208390250649E3e8763348E783AEF5562", // USDC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "0x6c411aD3E74De3E7Bd422b94A27770f5B86C623B", // WETH
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0x467194771dae2967aef3ecbedd3bf9a310c76c65", // DAI
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": "0x09e9222e96e7b4ae2a407b98d48e330053351eee", // WBTC
  "0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828": "0x09e9222e96e7b4ae2a407b98d48e330053351eee", // UMA
  "0x3472A5A71965499acd81997a54BBA8D852C6E53d": "0x09e9222e96e7b4ae2a407b98d48e330053351eee", // BADGER
};

// TODO: replace these numbers using the arbitrum SDK. these are bad values that mean we will over pay but transactions
// wont get stuck.

export class ArbitrumAdapter extends BaseAdapter {
  l2GasPrice: BigNumber = toBN(20e9);
  l2GasLimit: BigNumber = toBN(150000);
  // abi.encoding of the maxL2Submission cost. of 0.01e18
  transactionSubmissionData =
    "0x000000000000000000000000000000000000000000000000002386f26fc1000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000";

  l1SubmitValue: BigNumber = toWei(0.013);
  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly monitoredAddresses: string[]
  ) {
    super(spokePoolClients, 42161, firstL1BlockToSearch);
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]) {
    await this.updateBlockSearchConfig();
    this.log("Getting cross-chain txs", { l1Tokens, l1Config: this.l1SearchConfig, l2Config: this.l2SearchConfig });

    const promises = [];
    const validTokens = [];
    // Fetch bridge events for all monitored addresses.
    for (const monitoredAddress of this.monitoredAddresses) {
      for (const l1Token of l1Tokens) {
        // Skip the token if we can't find the corresponding bridge.
        // This is a valid use case as it's more convenient to check cross chain transfers for all tokens
        // rather than maintaining a list of native bridge-supported tokens.
        if (l1Gateways[l1Token] === undefined || l2Gateways[l1Token] === null) continue;

        const l1Bridge = this.getL1Bridge(l1Token);
        const l2Bridge = this.getL2Bridge(l1Token);
        const searchFilter = [undefined, monitoredAddress];
        promises.push(
          paginatedEventQuery(l1Bridge, l1Bridge.filters.DepositInitiated(...searchFilter), this.l1SearchConfig),
          paginatedEventQuery(l2Bridge, l2Bridge.filters.DepositFinalized(...searchFilter), this.l2SearchConfig)
        );
        validTokens.push(l1Token);
      }
    }

    const results = await Promise.all(promises, { concurrency: 4 });

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
      // The logic below takes the results from the promises and spreads them into the l1DepositInitiatedEvents and
      // l2DepositFinalizedEvents state from the BaseAdapter.
      eventsToProcess.forEach((result, index) => {
        const l1Token = validTokens[Math.floor(index / 2)];
        const events = result.map((event) => {
          const eventSpread = spreadEventWithBlockNumber(event);
          return { amount: eventSpread[index % 2 === 0 ? "_amount" : "amount"], blockNumber: eventSpread.blockNumber };
        });
        const eventsStorage = index % 2 === 0 ? this.l1DepositInitiatedEvents : this.l2DepositFinalizedEvents;
        assign(eventsStorage, [monitoredAddress, l1Token], events);
      });
    }

    this.l1SearchConfig.fromBlock = this.l1SearchConfig.toBlock + 1;
    this.l2SearchConfig.fromBlock = this.l2SearchConfig.toBlock + 1;

    return this.computeOutstandingCrossChainTransfers(validTokens);
  }

  async checkTokenApprovals(address: string, l1Tokens: string[]) {
    // Note we send the approvals to the L1 Bridge but actually send outbound transfers to the L1 Gateway Router.
    // Note that if the token trying to be approved is not configured in this client (i.e. not in the l1Gateways object)
    // then this will pass null into the checkAndSendTokenApprovals. This method gracefully deals with this case.
    const associatedL1Bridges = l1Tokens.map((l1Token) => this.getL1Bridge(l1Token)?.address);
    await this.checkAndSendTokenApprovals(address, l1Tokens, associatedL1Bridges);
  }

  async sendTokenToTargetChain(address: string, l1Token: string, l2Token: string, amount: BigNumber) {
    this.log("Bridging tokens", { l1Token, l2Token, amount });
    const args = [
      l1Token, // token
      address, // to
      amount, // amount
      this.l2GasLimit, // maxGas
      this.l2GasPrice, // gasPriceBid
      this.transactionSubmissionData, // data
    ];
    return await runTransaction(this.logger, this.getL1GatewayRouter(), "outboundTransfer", args, this.l1SubmitValue);
  }

  getL1Bridge(l1Token: string): Contract | null {
    try {
      return new Contract(l1Gateways[l1Token], arbitrumL1Erc20GatewayInterface, this.getSigner(1));
    } catch (error) {
      this.log("Could not construct l1Bridge. Likely misconfiguration", { l1Token, error, l1Gateways }, "error");
      return null;
    }
  }

  getL1GatewayRouter() {
    return new Contract(l1GatewayRouter, arbitrumL1Erc20GatewayInterface, this.getSigner(1));
  }

  getL2Bridge(l1Token: string) {
    try {
      return new Contract(l2Gateways[l1Token], arbitrumL2Erc20GatewayInterface, this.getSigner(this.chainId));
    } catch (error) {
      this.log("Could not construct l2Bridge. Likely misconfiguration", { l1Token, error, l2Gateways }, "error");
      return null;
    }
  }
}
