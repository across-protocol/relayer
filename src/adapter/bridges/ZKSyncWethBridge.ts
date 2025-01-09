import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  Signer,
  EventSearchConfig,
  Provider,
  isContractDeployedToAddress,
  bnZero,
  ZERO_ADDRESS,
  TOKEN_SYMBOLS_MAP,
  assert,
  compareAddressesSimple,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { isDefined } from "../../utils/TypeGuards";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";
import * as zksync from "zksync-ethers";
import { zkSync as zkSyncUtils } from "../../utils/chains";
import { matchL2EthDepositAndWrapEvents } from "../../clients/bridges/utils";
import { gasPriceOracle } from "@across-protocol/sdk";

/* For both the canonical bridge and the ZkSync Weth bridge (this
 * bridge), we need to assume that the l1 and l2 signers contain
 * associated providers, since we need to get information about
 * addresses and gas prices (this is also why `constructL1toL2Txn`
 * is an async fn).
 */
export class ZKSyncWethBridge extends BaseBridgeAdapter {
  protected l2Eth: Contract;
  protected l2Weth: Contract;
  protected atomicDepositor: Contract;

  private readonly gasPerPubdataLimit = zksync.utils.REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    _l1Token: string
  ) {
    // Lint Appeasement
    _l1Token;
    const { address: atomicDepositorAddress, abi: atomicDepositorAbi } = CONTRACT_ADDRESSES[hubChainId].atomicDepositor;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [atomicDepositorAddress]);

    const { address: l2EthAddress, abi: l2EthAbi } = CONTRACT_ADDRESSES[l2chainId].eth;
    const { address: mailboxAddress, abi: mailboxAbi } = CONTRACT_ADDRESSES[hubChainId].zkSyncMailbox;

    this.l2Eth = new Contract(l2EthAddress, l2EthAbi, l2SignerOrProvider);
    this.l2Weth = new Contract(TOKEN_SYMBOLS_MAP.WETH.addresses[l2chainId], l2EthAbi, l2SignerOrProvider);
    this.atomicDepositor = new Contract(atomicDepositorAddress, atomicDepositorAbi, l1Signer);
    this.l1Bridge = new Contract(mailboxAddress, mailboxAbi, l1Signer);
  }

  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    const l1Provider = this.atomicDepositor.provider;
    const l2Provider = this.l2Eth.provider;

    let zkProvider;
    try {
      zkProvider = zkSyncUtils.convertEthersRPCToZKSyncRPC(l2Provider);
    } catch (error) {
      assert(process.env.RELAYER_TEST === "true");
    }
    // If zkSync provider can't be created for some reason, default to a very conservative 2mil L2 gas limit
    // which should be sufficient for this transaction.
    const l2GasLimit = isDefined(zkProvider)
      ? await zksync.utils.estimateDefaultBridgeDepositL2Gas(
          l1Provider,
          zkProvider,
          l1Token,
          amount,
          toAddress,
          toAddress,
          this.gasPerPubdataLimit
        )
      : BigNumber.from(2_000_000);

    const l1GasPriceData = await gasPriceOracle.getGasPriceEstimate(l1Provider);
    const estimatedL1GasPrice = l1GasPriceData.maxPriorityFeePerGas.add(l1GasPriceData.maxFeePerGas);
    const l2TransactionBaseCost = await this.getL1Bridge().l2TransactionBaseCost(
      estimatedL1GasPrice,
      l2GasLimit,
      this.gasPerPubdataLimit
    );

    const bridgeCalldata = this.getL1Bridge().interface.encodeFunctionData("requestL2Transaction", [
      toAddress,
      amount,
      "0x",
      l2GasLimit,
      this.gasPerPubdataLimit,
      [],
      toAddress,
    ]);
    return Promise.resolve({
      contract: this.atomicDepositor,
      method: "bridgeWeth",
      args: [this.l2chainId, amount.add(l2TransactionBaseCost), amount, bnZero, bridgeCalldata],
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const hubPool = this.getHubPool();
    if (compareAddressesSimple(fromAddress, hubPool.address)) {
      return Promise.resolve({});
    }
    const wethAddress = TOKEN_SYMBOLS_MAP.WETH.addresses[this.hubChainId];
    const isL2Contract = await this.isL2ChainContract(toAddress);
    // If sending WETH from EOA, we can assume the EOA is unwrapping ETH and sending it through the
    // AtomicDepositor. If sending WETH from a contract, then the only event we can track from a ZkSync contract
    // is the NewPriorityRequest event which doesn't have any parameters about the 'to' or 'amount' sent.
    // Therefore, we must track the HubPool and assume any transfers we are tracking from contracts are
    // being sent by the HubPool.
    let events, processedEvents;
    if (isL2Contract) {
      events = await paginatedEventQuery(hubPool, hubPool.filters.TokensRelayed(), eventConfig);
      processedEvents = events
        .filter(
          (e) => compareAddressesSimple(e.args.to, toAddress) && compareAddressesSimple(e.args.l1Token, wethAddress)
        )
        .map((e) => {
          return {
            ...processEvent(e, "amount", "to", "to"),
            from: hubPool.address,
          };
        });
    } else {
      events = await paginatedEventQuery(
        this.atomicDepositor,
        this.atomicDepositor.filters.AtomicWethDepositInitiated(fromAddress, this.l2chainId),
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
    const hubPool = this.getHubPool();
    if (compareAddressesSimple(fromAddress, hubPool.address)) {
      return Promise.resolve({});
    }

    const isL2Contract = await this.isL2ChainContract(toAddress);
    let processedEvents;
    if (isL2Contract) {
      processedEvents = await paginatedEventQuery(
        this.l2Eth,
        this.l2Eth.filters.Transfer(zksync.utils.applyL1ToL2Alias(hubPool.address), toAddress),
        eventConfig
      );
    } else {
      const [events, wrapEvents] = await Promise.all([
        paginatedEventQuery(
          this.l2Eth,
          this.l2Eth.filters.Transfer(zksync.utils.applyL1ToL2Alias(this.atomicDepositor.address), toAddress),
          eventConfig
        ),
        paginatedEventQuery(this.l2Weth, this.l2Weth.filters.Transfer(ZERO_ADDRESS, toAddress), eventConfig),
      ]);
      processedEvents = matchL2EthDepositAndWrapEvents(events, wrapEvents);
    }
    return {
      [this.resolveL2TokenAddress(l1Token)]: processedEvents.map((e) => processEvent(e, "_amount", "_to", "from")),
    };
  }

  /*
   * ZkSync Weth Bridge Utility Functions
   */

  private getHubPool(): Contract {
    const hubPoolContractData = CONTRACT_ADDRESSES[this.hubChainId]?.hubPool;
    if (!hubPoolContractData) {
      throw new Error(`hubPoolContractData not found for chain ${this.hubChainId}`);
    }
    return new Contract(hubPoolContractData.address, hubPoolContractData.abi, this.l1Signer);
  }

  private isL2ChainContract(address: string): Promise<boolean> {
    return isContractDeployedToAddress(address, this.l2Eth.provider);
  }
}
