import {
  Contract,
  BigNumber,
  EventSearchConfig,
  Signer,
  Provider,
  ZERO_ADDRESS,
  bnZero,
  compareAddressesSimple,
  paginatedEventQuery,
  isDefined,
} from "../../utils";
import { ZKStackBridge } from "./";
import { processEvent, matchL2EthDepositAndWrapEvents } from "../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails, BridgeEvents } from "./BaseBridgeAdapter";

const ETH_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000001";
export class ZKStackWethBridge extends ZKStackBridge {
  private readonly atomicDepositor: Contract;
  private readonly l2Weth: Contract;
  private readonly l2Eth: Contract;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: string
  ) {
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, l1Token);
    const { address: atomicDepositorAddress, abi: atomicDepositorAbi } = CONTRACT_ADDRESSES[hubChainId].atomicDepositor;
    this.atomicDepositor = new Contract(atomicDepositorAddress, atomicDepositorAbi, l1Signer);

    // Overwrite the bridge gateway to the correct gateway. The correct gateway is the atomic depositor since this is the
    // address which is pulling weth out of the relayer via a `transferFrom`.
    this.l1Gateways = [atomicDepositorAddress];

    // Grab both the l2 WETH and l2 ETH contract addresses. Note: If the L2 uses a custom gas token, then the l2 ETH contract
    // will be unused, so it must not necessarily be defined in CONTRACT_ADDRESSES.
    const { address: l2WethAddress, abi: l2WethAbi } = CONTRACT_ADDRESSES[l2chainId].l2Weth;
    this.l2Weth = new Contract(l2WethAddress, l2WethAbi, l2SignerOrProvider);
    if (!isDefined(this.gasToken)) {
      const { address: l2EthAddress, abi: l2EthAbi } = CONTRACT_ADDRESSES[l2chainId].l2Eth;
      this.l2Eth = new Contract(l2EthAddress, l2EthAbi, l2SignerOrProvider);
    }
  }

  override async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    const txBaseCost = await this._txBaseCost();
    const secondBridgeCalldata = this._secondBridgeCalldata(toAddress, ETH_TOKEN_ADDRESS, bnZero);

    const bridgeCalldata = this.getL1Bridge().interface.encodeFunctionData("requestL2TransactionTwoBridges", [
      [
        this.l2chainId,
        txBaseCost,
        0,
        this.l2GasLimit,
        this.gasPerPubdataLimit,
        toAddress,
        this.sharedBridgeAddress,
        amount,
        secondBridgeCalldata,
      ],
    ]);
    const usingCustomGasToken = isDefined(this.gasToken);
    const netValue = usingCustomGasToken ? amount : amount.add(txBaseCost);
    const feeAmount = usingCustomGasToken ? txBaseCost : bnZero;

    return {
      contract: this.getAtomicDepositor(),
      method: "bridgeWeth",
      args: [this.l2chainId, netValue, amount, feeAmount, bridgeCalldata],
    };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // If the fromAddress is the hub pool then ignore the query. This is because for calculating cross-chain
    // transfers, we query both the hub pool outstanding transfers *and* the spoke pool outstanding transfers,
    // meaning that querying this function for the hub pool as well would effectively double count the outstanding transfer amount.
    if (compareAddressesSimple(fromAddress, this.hubPool.address)) {
      return {};
    }

    const isL2Contract = await this._isContract(toAddress, this.getL2Bridge().provider!);
    let processedEvents;
    if (isL2Contract) {
      processedEvents = (await paginatedEventQuery(this.hubPool, this.hubPool.filters.TokensRelayed(), eventConfig))
        .filter((e) => compareAddressesSimple(e.args.to, toAddress) && compareAddressesSimple(e.args.l1Token, l1Token))
        .map((e) => {
          return {
            ...processEvent(e, "amount", "to", "to"),
            from: this.hubPool.address,
          };
        });
    } else {
      // This means we are bridging via an EOA, so we should just look for atomic weth deposits.
      const events = await paginatedEventQuery(
        this.getAtomicDepositor(),
        this.getAtomicDepositor().filters.AtomicWethDepositInitiated(fromAddress, this.l2chainId),
        eventConfig
      );
      // If we are in this branch, then the depositor is an EOA, so we can assume that from == to.
      processedEvents = events.map((e) => processEvent(e, "amount", "from", "from"));
    }
    return {
      [this.resolveL2TokenAddress(l1Token)]: processedEvents,
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Ignore hub pool queries for the same reason as above.
    if (compareAddressesSimple(fromAddress, this.hubPool.address)) {
      return {};
    }
    const isL2Contract = await this._isContract(toAddress, this.getL2Bridge().provider!);

    // Events change slightly if the L2 has a custom gas token.
    const usingCustomGasToken = isDefined(this.gasToken);

    let processedEvents;
    if (isL2Contract || usingCustomGasToken) {
      // Assume the transfer came from the hub pool. If the chain has a custom gas token, then query weth. Otherwise,
      // query ETH.
      const ethContract = usingCustomGasToken ? this.l2Weth : this.l2Eth;
      processedEvents = await paginatedEventQuery(
        ethContract,
        ethContract.filters.Transfer(ZERO_ADDRESS, toAddress),
        eventConfig
      );
    } else {
      // The transaction originated from the atomic depositor and the L2 does not use a custom gas token.
      const [events, wrapEvents] = await Promise.all([
        paginatedEventQuery(this.l2Eth, this.l2Eth.filters.Transfer(ZERO_ADDRESS, toAddress), eventConfig),
        paginatedEventQuery(this.l2Weth, this.l2Weth.filters.Transfer(ZERO_ADDRESS, toAddress), eventConfig),
      ]);
      processedEvents = matchL2EthDepositAndWrapEvents(events, wrapEvents);
    }
    return {
      [this.resolveL2TokenAddress(l1Token)]: processedEvents.map((e) => processEvent(e, "_amount", "_to", "from")),
    };
  }
  private getAtomicDepositor(): Contract {
    return this.atomicDepositor;
  }
}
