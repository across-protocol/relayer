import { spreadEvent, assign, Contract, BigNumber, EventSearchConfig } from "../../utils";
import { toBN, Event, ZERO_ADDRESS, winston, paginatedEventQuery, spreadEventWithBlockNumber } from "../../utils";

const l1BridgeInterface = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "_l1Token", type: "address" },
      { indexed: true, internalType: "address", name: "_l2Token", type: "address" },
      { indexed: true, internalType: "address", name: "_from", type: "address" },
      { indexed: false, internalType: "address", name: "_to", type: "address" },
      { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
      { indexed: false, internalType: "bytes", name: "_data", type: "bytes" },
    ],
    name: "ERC20DepositInitiated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "_from", type: "address" },
      { indexed: true, internalType: "address", name: "_to", type: "address" },
      { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
      { indexed: false, internalType: "bytes", name: "_data", type: "bytes" },
    ],
    name: "ETHDepositInitiated",
    type: "event",
  },
];

const tokenToEvent = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "ERC20DepositInitiated", // USDC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "ETHDepositInitiated", // WETH
};

const l1StandardBridgeAddressOvm = "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1";
const l1StandardBridgeAddressBoba = "0xdc1664458d2f0B6090bEa60A8793A4E66c2F1c00";

const firstL1BlockToSearchOvm = 13352477;
const firstL1BlockToSearchBoba = 13012048;

const ovmL2BridgeInterface = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "_l1Token", type: "address" },
      { indexed: true, internalType: "address", name: "_l2Token", type: "address" },
      { indexed: true, internalType: "address", name: "_from", type: "address" },
      { indexed: false, internalType: "address", name: "_to", type: "address" },
      { indexed: false, internalType: "uint256", name: "_amount", type: "uint256" },
      { indexed: false, internalType: "bytes", name: "_data", type: "bytes" },
    ],
    name: "DepositFinalized",
    type: "event",
  },
];

const ovmL2StandardBridgeAddress = "0x4200000000000000000000000000000000000010";

export async function getOutstandingCrossChainTransfers(
  l1Provider: any,
  ovmProvider: any,
  relayerAddress: string,
  l1Token: string,
  l1SearchConfig: any,
  ovmSearchConfig: any,
  isOptimism: boolean = true
) {
  // TODO: this wont support looking for events for non-standard bridges (such as DAI or SNX).
  const l1BridgeAddress = isOptimism ? l1StandardBridgeAddressOvm : l1StandardBridgeAddressBoba;
  const l1Bridge = new Contract(l1BridgeAddress, l1BridgeInterface, l1Provider);
  const ovmBridge = new Contract(ovmL2StandardBridgeAddress, ovmL2BridgeInterface, ovmProvider);

  const l1Method = tokenToEvent[l1Token];
  const l1SearchFilter = l1Method == "ERC20DepositInitiated" ? [l1Token, undefined, relayerAddress] : [relayerAddress];
  const ovmSearchFilter =
    l1Method == "ERC20DepositInitiated"
      ? [l1Token, undefined, relayerAddress]
      : ["0x0000000000000000000000000000000000000000", undefined, relayerAddress];
  l1SearchConfig = {
    ...l1SearchConfig,
    fromBlock: isOptimism ? firstL1BlockToSearchOvm : firstL1BlockToSearchBoba,
  };
  ovmSearchConfig = { ...ovmSearchConfig, fromBlock: 0 };

  const [l1DepositInitiatedEvents, ovmDepositFinalizedEvents] = await Promise.all([
    paginatedEventQuery(l1Bridge, l1Bridge.filters[l1Method](...l1SearchFilter), l1SearchConfig),
    paginatedEventQuery(ovmBridge, ovmBridge.filters.DepositFinalized(...ovmSearchFilter), ovmSearchConfig),
  ]);

  const totalDepositsInitiated = l1DepositInitiatedEvents
    .map((event: Event) => event.args._amount)
    .reduce((acc, curr) => acc.add(curr), toBN(0));

  const totalDepositsFinalized = ovmDepositFinalizedEvents
    .map((event: Event) => event.args._amount)
    .reduce((acc, curr) => acc.add(curr), toBN(0));

  console.log(isOptimism ? "optimism" : "boba", totalDepositsInitiated.toString(), totalDepositsFinalized.toString());

  return totalDepositsInitiated.sub(totalDepositsFinalized);
}
