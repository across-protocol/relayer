import {
  assign,
  BigNumber,
  Contract,
  runTransaction,
  spreadEvent,
  spreadEventWithBlockNumber,
  winston,
  BigNumberish,
  isDefined,
} from "../../utils";
import { toBN, toWei, paginatedEventQuery, Promise, Event } from "../../utils";
import { SpokePoolClient } from "../../clients";
import { BaseAdapter } from "./BaseAdapter";
import { arbitrumL2Erc20GatewayInterface, arbitrumL1Erc20GatewayInterface } from "./ContractInterfaces";
import { SortableEvent } from "../../interfaces";

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
  "0x44108f0223A3C3028F5Fe7AEC7f9bb2E66beF82F": "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC", // ACX
} as const;

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
  "0x44108f0223A3C3028F5Fe7AEC7f9bb2E66beF82F": "0x09e9222E96E7B4AE2a407B98d48e330053351EEe", // ACX
} as const;

type SupportedL1Token = keyof typeof l1Gateways & keyof typeof l2Gateways;

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
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    super(spokePoolClients, 42161, monitoredAddresses, logger);
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]) {
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();
    this.log("Getting cross-chain txs", { l1Tokens, l1Config: l1SearchConfig, l2Config: l2SearchConfig });

    const promises: Promise<Event[]>[] = [];
    const validTokens: string[] = [];
    // Fetch bridge events for all monitored addresses.
    for (const monitoredAddress of this.monitoredAddresses) {
      for (const l1Token of l1Tokens) {
        // Skip the token if we can't find the corresponding bridge.
        // This is a valid use case as it's more convenient to check cross chain transfers for all tokens
        // rather than maintaining a list of native bridge-supported tokens.
        if (!this.isSupportedToken(l1Token)) continue;

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
          paginatedEventQuery(l1Bridge, l1Bridge.filters.DepositInitiated(...l1SearchFilter), l1SearchConfig),
          paginatedEventQuery(l2Bridge, l2Bridge.filters.DepositFinalized(...l2SearchFilter), l2SearchConfig)
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
      // The logic below takes the results from the promises and spreads them into the l1DepositInitiatedEvents and
      // l2DepositFinalizedEvents state from the BaseAdapter.
      eventsToProcess.forEach((result, index) => {
        const l1Token = validTokens[Math.floor(index / 2)];
        // l1Token is not an indexed field on Aribtrum gateway's deposit events, so these events are for all tokens.
        // Therefore, we need to filter unrelated deposits of other tokens.
        const filteredEvents = result.filter((event) => spreadEvent(event)["l1Token"] === l1Token);
        const events = filteredEvents.map((event) => {
          // TODO: typing here is a little janky. To get these right, we'll probably need to rework how we're sorting
          // these different types of events into the array to get stronger guarantees when extracting them.
          const eventSpread = spreadEventWithBlockNumber(event) as SortableEvent & {
            amount?: BigNumberish;
            _amount?: BigNumberish;
          };
          return {
            amount: eventSpread[index % 2 === 0 ? "_amount" : "amount"]!,
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
    const associatedL1Bridges = l1Tokens
      .map((l1Token) => {
        if (!this.isSupportedToken(l1Token)) return null;
        return this.getL1Bridge(l1Token).address;
      })
      .filter(isDefined);
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

  getL1Bridge(l1Token: SupportedL1Token): Contract {
    return new Contract(l1Gateways[l1Token], arbitrumL1Erc20GatewayInterface, this.getSigner(1));
  }

  getL1GatewayRouter() {
    return new Contract(l1GatewayRouter, arbitrumL1Erc20GatewayInterface, this.getSigner(1));
  }

  getL2Bridge(l1Token: SupportedL1Token) {
    return new Contract(l2Gateways[l1Token], arbitrumL2Erc20GatewayInterface, this.getSigner(this.chainId));
  }

  isSupportedToken(l1Token: string): l1Token is SupportedL1Token {
    return l1Token in l1Gateways && l1Token in l2Gateways;
  }
}
