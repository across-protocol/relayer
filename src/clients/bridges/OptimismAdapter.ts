import assert from "assert";
import {
  Contract,
  BigNumber,
  ZERO_ADDRESS,
  paginatedEventQuery,
  BigNumberish,
  TransactionResponse,
  compareAddressesSimple,
  ethers,
  Event,
  EventSearchConfig,
  Signer,
  Provider,
} from "../../utils";
import { spreadEventWithBlockNumber, assign, winston } from "../../utils";
import { SpokePoolClient } from "../../clients";
import { BaseAdapter } from "./";
import { SortableEvent } from "../../interfaces";
import { OutstandingTransfers } from "../../interfaces";
import { constants } from "@across-protocol/sdk-v2";
import { CONTRACT_ADDRESSES } from "../../common";
import { CHAIN_IDs } from "@across-protocol/contracts-v2";
import { OpStackAdapter, OpStackBridge, TransactionDetails } from "./OpStackAdapter";
const { TOKEN_SYMBOLS_MAP } = constants;

class DaiOptimismBridge implements OpStackBridge {
  private readonly l1Bridge: Contract;
  private readonly l2Bridge: Contract;

  constructor(private l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].daiOptimismBridge;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].daiOptimismBridge;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    l2Gas: number
  ): TransactionDetails {
    return {
      contract: this.l1Bridge,
      method: "depositERC20",
      args: [l1Token, l2Token, amount, l2Gas, "0x"],
    };
  }

  queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<Event[]> {
    return paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.ERC20DepositInitiated(l1Token, undefined, fromAddress),
      eventConfig
    );
  }

  queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<Event[]> {
    return paginatedEventQuery(
      this.l2Bridge,
      this.l2Bridge.filters.DepositFinalized(l1Token, undefined, fromAddress),
      eventConfig
    );
  }
}

class SnxOptimismBridge implements OpStackBridge {
  private readonly l1Bridge: Contract;
  private readonly l2Bridge: Contract;

  constructor(private l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].snxOptimismBridge;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].snxOptimismBridge;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    l2Gas: number
  ): TransactionDetails {
    return {
      contract: this.l1Bridge,
      method: "depositTo",
      args: [toAddress, amount],
    };
  }

  queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<Event[]> {
    return paginatedEventQuery(this.l1Bridge, this.l1Bridge.filters.DepositInitiated(fromAddress), eventConfig);
  }

  queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<Event[]> {
    return paginatedEventQuery(this.l2Bridge, this.l2Bridge.filters.DepositFinalized(fromAddress), eventConfig);
  }
}

export class OptimismAdapter extends OpStackAdapter {
  private customL1OptimismBridgeAddresses = {
    [TOKEN_SYMBOLS_MAP.DAI.addresses[1]]: CONTRACT_ADDRESSES[1].daiOptimismBridge,
    [TOKEN_SYMBOLS_MAP.SNX.addresses[1]]: CONTRACT_ADDRESSES[1].snxOptimismBridge,
  } as const;

  private customOvmBridgeAddresses = {
    [TOKEN_SYMBOLS_MAP.DAI.addresses[1]]: CONTRACT_ADDRESSES[10].daiOptimismBridge,
    [TOKEN_SYMBOLS_MAP.SNX.addresses[1]]: CONTRACT_ADDRESSES[10].snxOptimismBridge,
  } as const;

  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[],
    // Optional sender address where the cross chain transfers originate from. This is useful for the use case of
    // monitoring transfers from HubPool to SpokePools where the sender is HubPool.
    readonly senderAddress?: string
  ) {
    const hubChainId = BaseAdapter.HUB_CHAIN_ID;
    const l2ChainId = 10;
    const hubChainSigner = spokePoolClients[hubChainId].spokePool.signer;
    const l2Signer = spokePoolClients[l2ChainId].spokePool.signer;
    const daiBridge = new DaiOptimismBridge(l2ChainId, hubChainId, hubChainSigner, l2Signer);
    const snxBridge = new SnxOptimismBridge(l2ChainId, hubChainId, hubChainSigner, l2Signer);
    super(
      10,
      {
        [TOKEN_SYMBOLS_MAP.DAI.addresses[hubChainId]]: daiBridge,
        [TOKEN_SYMBOLS_MAP.SNX.addresses[hubChainId]]: snxBridge,
      },
      logger,
      ["DAI", "SNX", "USDC", "USDT", "WETH", "WBTC", "UMA", "BAL", "ACX", "POOL"],
      spokePoolClients,
      monitoredAddresses,
      senderAddress
    );
  }
}
