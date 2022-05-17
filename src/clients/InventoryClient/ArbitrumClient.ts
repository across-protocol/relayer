import { spreadEvent, assign, Contract, BigNumber, EventSearchConfig } from "../../utils";
import { toBN, Event, ZERO_ADDRESS, winston, paginatedEventQuery, spreadEventWithBlockNumber } from "../../utils";

const l1Erc20GatewayInterface = [
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "address", name: "l1Token", type: "address" },
      { indexed: true, internalType: "address", name: "_from", type: "address" },
      { indexed: true, internalType: "address", name: "_to", type: "address" },
      { indexed: true, internalType: "uint256", name: "_sequenceNumber", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
    ],
    name: "DepositInitiated",
    type: "event",
  },
];

const l1GatewayAddresses = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "0xcEe284F754E854890e311e3280b767F80797180d", // USDC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "0xd92023E9d9911199a6711321D1277285e6d4e2db", // WETH
};

const firstBlockToSearch = 12640865;

const l2Erc20GatewayInterface = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "l1Token", type: "address" },
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "DepositFinalized",
    type: "event",
  },
];

const l2GatewayAddresses = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "0x096760F208390250649E3e8763348E783AEF5562", // USDC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "0x6c411aD3E74De3E7Bd422b94A27770f5B86C623B", // WETH
};

export async function getOutstandingCrossChainTransfers(
  l1Provider: any,
  avmProvider: any,
  relayerAddress: string,
  l1Token: string,
  l1SearchConfig: any,
  avmSearchConfig: any
) {
  const l1Bridge = new Contract(l1GatewayAddresses[l1Token], l1Erc20GatewayInterface, l1Provider);
  const avmBridge = new Contract(l2GatewayAddresses[l1Token], l2Erc20GatewayInterface, avmProvider);

  const searchFilter = [undefined, relayerAddress];
  console.log("searchFilter", searchFilter);
  l1SearchConfig = { ...l1SearchConfig, fromBlock: firstBlockToSearch };
  console.log("l1SearchConfig", l1SearchConfig);
  avmSearchConfig = { ...avmSearchConfig, fromBlock: 0 };

  const [l1DepositInitiatedEvents, avmDepositFinalizedEvents] = await Promise.all([
    paginatedEventQuery(l1Bridge, l1Bridge.filters.DepositInitiated(...searchFilter), l1SearchConfig),
    paginatedEventQuery(avmBridge, avmBridge.filters.DepositFinalized(...searchFilter), avmSearchConfig),
  ]);

  const totalDepositsInitiated = l1DepositInitiatedEvents
    .filter((event: any) => event.args.l1Token.toLowerCase() == l1Token.toLowerCase())
    .map((event: Event) => event.args._amount)
    .reduce((acc, curr) => acc.add(curr), toBN(0));

  const totalDepositsFinalized = avmDepositFinalizedEvents
    .filter((event: any) => event.args.l1Token.toLowerCase() == l1Token.toLowerCase())
    .map((event: Event) => event.args.amount)
    .reduce((acc, curr) => acc.add(curr), toBN(0));

  console.log("Aribtrum totals", l1Token, totalDepositsInitiated.toString(), totalDepositsFinalized.toString());

  return totalDepositsInitiated.sub(totalDepositsFinalized);
}
