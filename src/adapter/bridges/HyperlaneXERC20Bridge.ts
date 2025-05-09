import {
  BigNumber,
  Contract,
  Signer,
  Provider,
  EvmAddress,
  assert,
  isDefined,
  ethers,
  paginatedEventQuery,
  Address,
  CHAIN_IDs,
  EventSearchConfig, // For example domain mapping
} from "../../utils"; // Adjust path as necessary
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents, BridgeEvent } from "./BaseBridgeAdapter";
import { processEvent } from "../utils"; // Adjust path as necessary

// ABI for the Hyperlane xERC20 Router
const XERC20_ROUTER_ABI_STRING = `[
  {
    "inputs": [],
    "name": "wrappedToken",
    "outputs": [
      {
        "internalType": "contract IERC20",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint32",
        "name": "_destinationDomain",
        "type": "uint32"
      }
    ],
    "name": "quoteGasPayment",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint32",
        "name": "origin",
        "type": "uint32"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "recipient",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "ReceivedTransferRemote",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint32",
        "name": "destination",
        "type": "uint32"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "recipient",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "SentTransferRemote",
    "type": "event"
  },
  {
    "inputs": [
      {
        "internalType": "uint32",
        "name": "_destination",
        "type": "uint32"
      },
      {
        "internalType": "bytes32",
        "name": "_recipient",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "_amountOrId",
        "type": "uint256"
      }
    ],
    "name": "transferRemote",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "messageId",
        "type": "bytes32"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  }
]`;
const XERC20_ROUTER_ABI = JSON.parse(XERC20_ROUTER_ABI_STRING);

// --- Configuration PLACEHOLDERS ---
// User will need to provide actual values for these maps.
const HYPERLANE_DOMAIN_MAP: { [chainId: number]: number } = {
  [CHAIN_IDs.MAINNET]: 1, // Example: Ethereum Mainnet Hyperlane Domain
  [CHAIN_IDs.ARBITRUM]: 42161, // Example: Arbitrum Hyperlane Domain
  [CHAIN_IDs.POLYGON]: 137, // Example: Polygon Hyperlane Domain
  // Add other chainId -> Hyperlane Domain mappings here
};

// { chainId: { underlyingTokenAddressNormalized: routerAddress } }
const XERC20_ROUTER_ADDRESS_MAP: { [chainId: number]: { [tokenAddress: string]: string } } = {
  [CHAIN_IDs.MAINNET]: {
    "0xaf51912785462f6759bf1f7c1c1c0cb9a69a7c9a": "0xRouterAddressForEzEthOnMainnet", // Example: ezETH on Mainnet -> its Router
  },
  [CHAIN_IDs.ARBITRUM]: {
    "0x09c62708a758255a91010f94f84c46a133868ce5": "0xRouterAddressForEzEthOnArbitrum", // Example: ezETH on Arbitrum -> its Router
  },
  // Add other chainId -> {tokenAddress -> routerAddress} mappings
};

const DEFAULT_HYP_FEE_CAP_ETH = "0.1"; // Default fee cap in ETH string
const HYP_FEE_CAP_MAP: { [chainId: number]: BigNumber } = {
  // chainId : FeeCap (BigNumber)
  // [CHAIN_IDs.ARBITRUM]: ethers.utils.parseUnits("0.05", "ether"), // Example: 0.05 ETH for Arbitrum
};
// --- End Configuration PLACEHOLDERS ---

function addressToBytes32(address: string): string {
  return ethers.utils.hexZeroPad(ethers.utils.getAddress(address), 32);
}

export class HyperlaneXERC20Bridge extends BaseBridgeAdapter {
  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress // This is the underlying token, e.g., ezETH on L1
  ) {
    const l1RouterAddressStr = XERC20_ROUTER_ADDRESS_MAP[hubChainId]?.[l1Token.toAddress().toLowerCase()];
    assert(
      isDefined(l1RouterAddressStr),
      `No L1 xERC20 router found for token ${l1Token.toAddress()} on chain ${hubChainId}`
    );
    const l1RouterEvmAddress = EvmAddress.from(l1RouterAddressStr);

    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [l1RouterEvmAddress]);

    this.l1Bridge = new Contract(l1RouterAddressStr, XERC20_ROUTER_ABI, l1Signer);

    const l2UnderlyingTokenAddressStr = this.resolveL2TokenAddress(l1Token);
    const l2RouterAddressStr = XERC20_ROUTER_ADDRESS_MAP[l2chainId]?.[l2UnderlyingTokenAddressStr.toLowerCase()];
    assert(
      isDefined(l2RouterAddressStr),
      `No L2 xERC20 router found for token ${l2UnderlyingTokenAddressStr} on chain ${l2chainId}`
    );

    this.l2Bridge = new Contract(l2RouterAddressStr, XERC20_ROUTER_ABI, l2SignerOrProvider);
  }

  async constructL1ToL2Txn(
    toAddress: Address, // Recipient address on L2
    l1Token: EvmAddress, // Underlying L1 token (e.g. ezETH)
    _l2Token: Address, // Underlying L2 token (derived, not directly used if router known)
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(
      XERC20_ROUTER_ADDRESS_MAP[this.hubChainId]?.[l1Token.toAddress().toLowerCase()].toLowerCase() ===
        this.l1Bridge.address.toLowerCase(),
      "l1Token does not match the configured L1 router for this bridge instance."
    );

    const hypDstDomain = HYPERLANE_DOMAIN_MAP[this.l2chainId];
    assert(isDefined(hypDstDomain), `No Hyperlane destination domain found for chainId ${this.l2chainId}`);

    const fee: BigNumber = await this.l1Bridge.quoteGasPayment(hypDstDomain);

    const feeCap = HYP_FEE_CAP_MAP[this.l2chainId] ?? ethers.utils.parseEther(DEFAULT_HYP_FEE_CAP_ETH);
    if (fee.gt(feeCap)) {
      throw new Error(
        `Hyperlane fee ${ethers.utils.formatEther(fee)} ETH exceeds cap ${ethers.utils.formatEther(
          feeCap
        )} ETH for chain ${this.l2chainId}`
      );
    }

    const recipientBytes32 = addressToBytes32(toAddress.toAddress());

    return {
      contract: this.l1Bridge,
      method: "transferRemote",
      args: [hypDstDomain, recipientBytes32, amount],
      value: fee,
    };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress, // Underlying L1 token
    fromAddress: Address, // EOA/contract initiating the transfer on L1
    toAddress: Address, // Ultimate recipient on L2
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(
      XERC20_ROUTER_ADDRESS_MAP[this.hubChainId]?.[l1Token.toAddress().toLowerCase()].toLowerCase() ===
        this.l1Bridge.address.toLowerCase(),
      "l1Token does not match the configured L1 router for this bridge instance."
    );

    const hypDstDomain = HYPERLANE_DOMAIN_MAP[this.l2chainId];
    assert(isDefined(hypDstDomain), `No Hyperlane destination domain found for chainId ${this.l2chainId}`);

    const recipientBytes32 = addressToBytes32(toAddress.toAddress());

    const rawEvents = await paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.SentTransferRemote(hypDstDomain, recipientBytes32),
      eventConfig
    );

    const l1Provider = this.l1Signer.provider;
    assert(isDefined(l1Provider), "L1 signer provider is not defined");

    const filteredEvents: BridgeEvent[] = [];
    for (const event of rawEvents) {
      const tx = await l1Provider.getTransaction(event.transactionHash);
      if (tx && tx.from.toLowerCase() === fromAddress.toAddress().toLowerCase()) {
        filteredEvents.push(processEvent(event, "amount") as BridgeEvent);
      }
    }

    const l2ResolvedTokenAddress = this.resolveL2TokenAddress(l1Token);
    return {
      [l2ResolvedTokenAddress.toLowerCase()]: filteredEvents,
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress, // Underlying L1 token (to resolve its L2 equivalent)
    _fromAddress: Address, // Original sender on L1 (not directly in L2 event)
    toAddress: Address, // Recipient on L2
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l2ResolvedTokenAddress = this.resolveL2TokenAddress(l1Token);
    assert(
      XERC20_ROUTER_ADDRESS_MAP[this.l2chainId]?.[l2ResolvedTokenAddress.toLowerCase()].toLowerCase() ===
        this.l2Bridge.address.toLowerCase(),
      "L2 token router does not match the configured L2 router for this bridge instance."
    );

    const hypOriginDomain = HYPERLANE_DOMAIN_MAP[this.hubChainId];
    assert(isDefined(hypOriginDomain), `No Hyperlane origin domain found for chainId ${this.hubChainId}`);

    const recipientBytes32 = addressToBytes32(toAddress.toAddress());

    const rawEvents = await paginatedEventQuery(
      this.l2Bridge,
      this.l2Bridge.filters.ReceivedTransferRemote(hypOriginDomain, recipientBytes32),
      eventConfig
    );

    return {
      [l2ResolvedTokenAddress.toLowerCase()]: rawEvents.map((event) => processEvent(event, "amount") as BridgeEvent),
    };
  }
}
