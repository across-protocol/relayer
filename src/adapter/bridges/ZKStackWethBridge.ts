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
  EvmAddress,
} from "../../utils";
import { ZKStackBridge } from "./";
import { processEvent, matchL2EthDepositAndWrapEvents } from "../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails, BridgeEvents } from "./BaseBridgeAdapter";
import * as zksync from "zksync-ethers";

const ETH_TOKEN_ADDRESS = EvmAddress.from("0x0000000000000000000000000000000000000001");
export class ZKStackWethBridge extends ZKStackBridge {
  private readonly atomicDepositor: Contract;
  private readonly l2Weth: Contract;
  private readonly l2Eth: Contract;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress
  ) {
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, l1Token);
    const { address: atomicDepositorAddress, abi: atomicDepositorAbi } = CONTRACT_ADDRESSES[hubChainId].atomicDepositor;
    this.atomicDepositor = new Contract(atomicDepositorAddress, atomicDepositorAbi, l1Signer);

    // Overwrite the bridge gateway to the correct gateway. The correct gateway is the atomic depositor since this is the
    // address which is pulling weth out of the relayer via a `transferFrom`.
    this.l1Gateways = [EvmAddress.from(atomicDepositorAddress)];

    // Grab both the l2 WETH and l2 ETH contract addresses. Note: If the L2 uses a custom gas token, then the l2 ETH contract
    // will be unused, so it must not necessarily be defined in CONTRACT_ADDRESSES.
    const { address: l2WethAddress, abi: l2WethAbi } = CONTRACT_ADDRESSES[l2chainId].weth;
    this.l2Weth = new Contract(l2WethAddress, l2WethAbi, l2SignerOrProvider);
    if (!isDefined(this.gasToken)) {
      const { address: l2EthAddress, abi: l2EthAbi } = CONTRACT_ADDRESSES[l2chainId].nativeToken;
      this.l2Eth = new Contract(l2EthAddress, l2EthAbi, l2SignerOrProvider);
    }
  }

  override async constructL1ToL2Txn(
    toAddress: EvmAddress,
    l1Token: EvmAddress,
    l2Token: EvmAddress,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    const txBaseCost = await this._txBaseCost();

    const usingCustomGasToken = isDefined(this.gasToken);
    let netValue, feeAmount, bridgeCalldata;
    if (usingCustomGasToken) {
      bridgeCalldata = this.getL1Bridge().interface.encodeFunctionData("requestL2TransactionTwoBridges", [
        [
          this.l2chainId,
          txBaseCost,
          0,
          this.l2GasLimit,
          this.gasPerPubdataLimit,
          toAddress.toAddress(),
          this.sharedBridge.address,
          amount,
          this._secondBridgeCalldata(toAddress, ETH_TOKEN_ADDRESS, bnZero),
        ],
      ]);
      netValue = amount;
      feeAmount = txBaseCost;
    } else {
      bridgeCalldata = this.getL1Bridge().interface.encodeFunctionData("requestL2TransactionDirect", [
        [
          this.l2chainId,
          txBaseCost.add(amount),
          toAddress.toAddress(),
          amount,
          "0x",
          this.l2GasLimit,
          this.gasPerPubdataLimit,
          [],
          toAddress.toAddress(), // This is the L2 refund address. It is safe to use toAddress here since it is an EOA.
        ],
      ]);
      netValue = amount.add(txBaseCost);
      feeAmount = bnZero;
    }

    return {
      contract: this.getAtomicDepositor(),
      method: "bridgeWeth",
      args: [this.l2chainId, netValue, amount, feeAmount, bridgeCalldata],
    };
  }

  override async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // If the fromAddress is the hub pool then ignore the query. This is because for calculating cross-chain
    // transfers, we query both the hub pool outstanding transfers *and* the spoke pool outstanding transfers,
    // meaning that querying this function for the hub pool as well would effectively double count the outstanding transfer amount.
    if (compareAddressesSimple(fromAddress.toAddress(), this.hubPool.address)) {
      return {};
    }

    const isL2Contract = await this._isContract(toAddress.toAddress(), this.getL2Bridge().provider!);
    let processedEvents;
    if (isL2Contract) {
      processedEvents = (await paginatedEventQuery(this.hubPool, this.hubPool.filters.TokensRelayed(), eventConfig))
        .filter(
          (e) =>
            compareAddressesSimple(e.args.to, toAddress.toAddress()) &&
            compareAddressesSimple(e.args.l1Token, l1Token.toAddress())
        )
        .map((e) => processEvent(e, "amount"));
    } else {
      // This means we are bridging via an EOA, so we should just look for atomic weth deposits.
      const events = await paginatedEventQuery(
        this.getAtomicDepositor(),
        this.getAtomicDepositor().filters.AtomicWethDepositInitiated(fromAddress.toAddress(), this.l2chainId),
        eventConfig
      );
      processedEvents = events.map((e) => processEvent(e, "amount"));
    }
    return {
      [this.resolveL2TokenAddress(l1Token)]: processedEvents,
    };
  }

  override async queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Ignore hub pool queries for the same reason as above.
    if (compareAddressesSimple(fromAddress.toAddress(), this.hubPool.address)) {
      return {};
    }
    const isL2Contract = await this._isContract(toAddress.toAddress(), this.getL2Bridge().provider!);
    const usingCustomGasToken = isDefined(this.gasToken);

    let processedEvents;
    // ZkSync uses different logic for ETH L2 finalization. Most notably, the transfer events on L2 mark the aliased L1 sender as the sender, while
    // for custom gas token L2s, the L1 sender is the zero address.
    if (!usingCustomGasToken) {
      if (isL2Contract) {
        // Assume the transfer came from the hub pool if the L2 toAddress is a contract.
        processedEvents = await paginatedEventQuery(
          this.l2Eth,
          this.l2Eth.filters.Transfer(zksync.utils.applyL1ToL2Alias(this.hubPool.address), toAddress.toAddress()),
          eventConfig
        );
      } else {
        // The transaction originated from the atomic depositor and the L2 does not use a custom gas token.
        const [events, wrapEvents] = await Promise.all([
          paginatedEventQuery(
            this.l2Eth,
            this.l2Eth.filters.Transfer(
              zksync.utils.applyL1ToL2Alias(this.getAtomicDepositor().address),
              toAddress.toAddress()
            ),
            eventConfig
          ),
          paginatedEventQuery(
            this.l2Weth,
            this.l2Weth.filters.Transfer(ZERO_ADDRESS, toAddress.toAddress()),
            eventConfig
          ),
        ]);
        processedEvents = matchL2EthDepositAndWrapEvents(events, wrapEvents);
      }
    } else {
      processedEvents = await paginatedEventQuery(
        this.l2Weth,
        this.l2Weth.filters.Transfer(ZERO_ADDRESS, toAddress.toAddress()),
        eventConfig
      );
    }
    return {
      [this.resolveL2TokenAddress(l1Token)]: processedEvents.map((e) => processEvent(e, "_amount")),
    };
  }
  private getAtomicDepositor(): Contract {
    return this.atomicDepositor;
  }
}
