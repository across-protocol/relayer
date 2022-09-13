import {
  assign,
  BigNumber,
  Contract,
  runTransaction,
  spreadEvent,
  spreadEventWithBlockNumber,
  winston,
} from "../../utils";
import { toBN, toWei, paginatedEventQuery, Promise } from "../../utils";
import { SpokePoolClient } from "../../clients";
import { BaseAdapter } from "./BaseAdapter";
import { arbitrumL2Erc20GatewayInterface, arbitrumL1Erc20GatewayInterface } from "./ContractInterfaces";

// These values are obtained from Arbitrum's gateway router contract.
const l1Gateways = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "0xcEe284F754E854890e311e3280b767F80797180d", // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7": "0xcEe284F754E854890e311e3280b767F80797180d", // USDT
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "0xd92023E9d9911199a6711321D1277285e6d4e2db", // WETH
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0xD3B5b60020504bc3489D6949d545893982BA3011", // DAI
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC", // WBTC
  "0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828": "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC", // UMA
  "0x3472A5A71965499acd81997a54BBA8D852C6E53d": "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC", // BADGER
  "0xba100000625a3754423978a60c9317c58a424e3D": "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC", // BAL
};

const l1GatewayRouter = "0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef";

const l2Gateways = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "0x096760F208390250649E3e8763348E783AEF5562", // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7": "0x096760F208390250649E3e8763348E783AEF5562", // USDT
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "0x6c411aD3E74De3E7Bd422b94A27770f5B86C623B", // WETH
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0x467194771dAe2967Aef3ECbEDD3Bf9a310C76C65", // DAI
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": "0x09e9222E96E7B4AE2a407B98d48e330053351EEe", // WBTC
  "0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828": "0x09e9222E96E7B4AE2a407B98d48e330053351EEe", // UMA
  "0x3472A5A71965499acd81997a54BBA8D852C6E53d": "0x09e9222E96E7B4AE2a407B98d48e330053351EEe", // BADGER
  "0xba100000625a3754423978a60c9317c58a424e3D": "0x09e9222E96E7B4AE2a407B98d48e330053351EEe", // BAL
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
    super(spokePoolClients, 42161);
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]) {
    this.updateSearchConfigs();
    this.log("Getting Arbitrum cross-chain txs", {
      l1Tokens,
      l1Config: this.l1SearchConfig,
      l2Config: this.l2SearchConfig,
    });

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
        // l1Token is not an indexed field on deposit events in L1 but is on finalization events on Arb.
        // This unfortunately leads to fetching of all deposit events for all tokens multiple times, one per l1Token.
        // There's likely not much we can do here as the deposit events don't have l1Token as an indexed field.
        // https://github.com/OffchainLabs/arbitrum/blob/master/packages/arb-bridge-peripherals/contracts/tokenbridge/ethereum/gateway/L1ArbitrumGateway.sol#L51
        const l1SearchFilter = [undefined, monitoredAddress];
        // https://github.com/OffchainLabs/arbitrum/blob/d75568fa70919364cf56463038c57c96d1ca8cda/packages/arb-bridge-peripherals/contracts/tokenbridge/arbitrum/gateway/L2ArbitrumGateway.sol#L40
        const l2SearchFilter = [l1Token, monitoredAddress, undefined];
        promises.push(
          paginatedEventQuery(l1Bridge, l1Bridge.filters.DepositInitiated(...l1SearchFilter), this.l1SearchConfig),
          paginatedEventQuery(l2Bridge, l2Bridge.filters.DepositFinalized(...l2SearchFilter), this.l2SearchConfig)
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
        // l1Token is not an indexed field on Aribtrum gateway's deposit events, so these events are for all tokens.
        // Therefore, we need to filter unrelated deposits of other tokens.
        const filteredEvents = result.filter((event) => spreadEvent(event)["l1Token"] === l1Token);
        const events = filteredEvents.map((event) => {
          const eventSpread = spreadEventWithBlockNumber(event);
          return {
            amount: eventSpread[index % 2 === 0 ? "_amount" : "amount"],
            ...eventSpread,
          };
        });
        const eventsStorage = index % 2 === 0 ? this.l1DepositInitiatedEvents : this.l2DepositFinalizedEvents;
        assign(eventsStorage, [monitoredAddress, l1Token], events);
      });
    }

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
