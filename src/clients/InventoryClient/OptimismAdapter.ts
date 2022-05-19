import { spreadEvent, assign, Contract, BigNumber, EventSearchConfig } from "../../utils";
import { toBN, Event, ZERO_ADDRESS, winston, paginatedEventQuery, runTransaction } from "../../utils";

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
  {
    inputs: [
      { internalType: "uint32", name: "_l2Gas", type: "uint32" },
      { internalType: "bytes", name: "_data", type: "bytes" },
    ],
    name: "depositETH",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "_l1Token", type: "address" },
      { internalType: "address", name: "_l2Token", type: "address" },
      { internalType: "uint256", name: "_amount", type: "uint256" },
      { internalType: "uint32", name: "_l2Gas", type: "uint32" },
      { internalType: "bytes", name: "_data", type: "bytes" },
    ],
    name: "depositERC20",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

const tokenToEvent = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "ERC20DepositInitiated", // USDC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "ETHDepositInitiated", // WETH
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "ERC20DepositInitiated", // DAI
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": "ERC20DepositInitiated", // WBTC
};

const customL1BridgeAddresses = {
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0x10e6593cdda8c58a1d0f14c5164b376352a55f2f", // DAI
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
const customOvmBridgeAddresses = {
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0x467194771dae2967aef3ecbedd3bf9a310c76c65",
};

const l2Gas = 200000;

// todo: optimize this adapter by making it a class that stores the previous events so we dont need to re-query past
// seen blocks on subsequent runs when running in non-serverless mode.
export async function getOutstandingCrossChainTransfers(
  l1Provider: any,
  ovmProvider: any,
  relayerAddress: string,
  l1Token: string,
  l1SearchConfig: any,
  ovmSearchConfig: any,
  isOptimism: boolean = true
): Promise<BigNumber> {
  const l1BridgeAddress = isOptimism
    ? Object.keys(customL1BridgeAddresses).includes(l1Token)
      ? customL1BridgeAddresses[l1Token]
      : l1StandardBridgeAddressOvm
    : l1StandardBridgeAddressBoba;
  const l2BridgeAddress = isOptimism
    ? Object.keys(customOvmBridgeAddresses).includes(l1Token)
      ? customOvmBridgeAddresses[l1Token]
      : ovmL2StandardBridgeAddress
    : ovmL2StandardBridgeAddress;
  const l1Bridge = new Contract(l1BridgeAddress, l1BridgeInterface, l1Provider);
  const ovmBridge = new Contract(l2BridgeAddress, ovmL2BridgeInterface, ovmProvider);

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

export async function sendTokenToTargetChain(logger, l1Provider, l1Token, l2Token, amount, isOptimism) {
  const l1BridgeAddress = isOptimism
    ? Object.keys(customL1BridgeAddresses).includes(l1Token)
      ? customL1BridgeAddresses[l1Token]
      : l1StandardBridgeAddressOvm
    : l1StandardBridgeAddressBoba;
  const l1Bridge = new Contract(l1BridgeAddress, l1BridgeInterface, l1Provider);
  let value = 0;
  let method = "depositERC20";
  let args = [l1Token, l2Token, amount, l2Gas, ""];
  if (tokenToEvent[l1Token] == "ETHDepositInitiated") {
    value = amount;
    method = "depositETH";
    args = [l2Gas, ""];
  }
  await runTransaction(logger, l1Bridge, method, args);
}
