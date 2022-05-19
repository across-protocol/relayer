import { spreadEvent, assign, Contract, BigNumber, EventSearchConfig } from "../../utils";
import { toBN, Event, ZERO_ADDRESS, winston, paginatedEventQuery, spreadEventWithBlockNumber } from "../../utils";

// ether bridge = 0x8484Ef722627bf18ca5Ae6BcF031c23E6e922B30
// erc20 bridfge = 0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf
// matic bridge = 0x401f6c983ea34274ec46f84d70b31c151321188b

// When bridging ETH to Polygon we MUST send ETH which is then wrapped in the bridge to WETH. We are unable to send WETh
// Directlry to the bridge.
const l1BridgeInterface = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "depositor", type: "address" },
      { indexed: true, internalType: "address", name: "depositReceiver", type: "address" },
      { indexed: true, internalType: "address", name: "rootToken", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "LockedERC20",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "depositor", type: "address" },
      { indexed: true, internalType: "address", name: "depositReceiver", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "LockedEther",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "owner", type: "address" },
      { indexed: true, internalType: "address", name: "token", type: "address" },
      { indexed: false, internalType: "uint256", name: "amountOrNFTId", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "depositBlockId", type: "uint256" },
    ],
    name: "NewDepositBlock",
    type: "event",
  },
];

const l1MaticAddress = "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0";

const tokenToBridge = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
    firstBlockToSearch: 10735445,
  }, // USDC
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
    firstBlockToSearch: 10735445,
  }, // DAI
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": {
    l1BridgeAddress: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    l2TokenAddress: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    l1Method: "LockedERC20",
    l1AmountProp: "amount",
    l2AmountProp: "value",
    firstBlockToSearch: 10735445,
  }, // WBTC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": {
    l1BridgeAddress: "0x8484Ef722627bf18ca5Ae6BcF031c23E6e922B30",
    l2TokenAddress: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    l1Method: "LockedEther",
    l1AmountProp: "amount",
    l2AmountProp: "value",
    firstBlockToSearch: 10735538,
  }, // WETH
  [l1MaticAddress]: {
    l1BridgeAddress: "0x401f6c983ea34274ec46f84d70b31c151321188b",
    l2TokenAddress: ZERO_ADDRESS,
    l1Method: "NewDepositBlock",
    l1AmountProp: "amountOrNFTId",
    l2AmountProp: "amount",
    firstBlockToSearch: 10167767,
  }, // MATIC
};

// On polygon a bridge transaction looks like a transfer from address(0) to the target.
const l2BridgeInterface = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      { indexed: false, internalType: "uint256", name: "value", type: "uint256" },
    ],
    name: "Transfer",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "rootToken", type: "address" },
      { indexed: true, internalType: "address", name: "childToken", type: "address" },
      { indexed: true, internalType: "address", name: "user", type: "address" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "depositCount", type: "uint256" },
    ],
    name: "TokenDeposited",
    type: "event",
  },
];

export async function getOutstandingCrossChainTransfers(
  l1Provider: any,
  polygonProvider: any,
  relayerAddress: string,
  l1Token: string,
  l1SearchConfig: any,
  polygonSearchConfig: any
) {
  const l1Bridge = new Contract(tokenToBridge[l1Token].l1BridgeAddress, l1BridgeInterface, l1Provider);
  const polygonBridge = new Contract(tokenToBridge[l1Token].l2TokenAddress, l2BridgeInterface, polygonProvider);

  const l1Method = tokenToBridge[l1Token].l1Method;
  let l1SearchFilter = [];
  if (l1Method == "LockedERC20") l1SearchFilter = [relayerAddress, undefined, l1Token];
  if (l1Method == "LockedEther") l1SearchFilter = [relayerAddress];
  if (l1Method == "NewDepositBlock") l1SearchFilter = [relayerAddress, l1MaticAddress];

  const l2Method = l1Token == l1MaticAddress ? "TokenDeposited" : "Transfer";
  let l2SearchFilter = [];
  if (l2Method == "Transfer") l2SearchFilter = [ZERO_ADDRESS, relayerAddress];
  if (l2Method == "TokenDeposited") l2SearchFilter = [l1MaticAddress, ZERO_ADDRESS, relayerAddress];

  l1SearchConfig = { ...l1SearchConfig, fromBlock: tokenToBridge[l1Token].firstBlockToSearch };
  polygonSearchConfig = { ...polygonSearchConfig, fromBlock: 0 };

  const [l1DepositInitiatedEvents, polygonDepositFinalizedEvents] = await Promise.all([
    paginatedEventQuery(l1Bridge, l1Bridge.filters[l1Method](...l1SearchFilter), l1SearchConfig),
    paginatedEventQuery(polygonBridge, polygonBridge.filters[l2Method](...l2SearchFilter), polygonSearchConfig),
  ]);

  const totalDepositsInitiated = l1DepositInitiatedEvents
    .map((event: Event) => event.args[tokenToBridge[l1Token].l1AmountProp])
    .reduce((acc, curr) => acc.add(curr), toBN(0));

  const totalDepositsFinalized = polygonDepositFinalizedEvents
    .map((event: Event) => event.args[tokenToBridge[l1Token].l2AmountProp])
    .reduce((acc, curr) => acc.add(curr), toBN(0));

  console.log("polygon", totalDepositsInitiated.toString(), totalDepositsFinalized.toString());

  return totalDepositsInitiated.sub(totalDepositsFinalized);
}
