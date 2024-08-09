import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  Signer,
  EventSearchConfig,
  Provider,
  isContractDeployedToAddress,
  ZERO_ADDRESS,
  TOKEN_SYMBOLS_MAP,
  assert,
} from "../../utils";
import { CONTRACT_ADDRESSES, DEFAULT_GAS_MULTIPLIER } from "../../common";
import { isDefined } from "../../utils/TypeGuards";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";
import * as zksync from "zksync-ethers";
import { zkSync as zkSyncUtils } from "../../utils/chains";

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
    const { address: l1MailboxAddress, abi: l1MailboxAbi } = CONTRACT_ADDRESSES[hubChainId].zkSyncMailbox;
    this.l2Eth = new Contract(l2EthAddress, l2EthAbi, l2SignerOrProvider);
    this.l2Weth = new Contract(TOKEN_SYMBOLS_MAP.WETH.addresses[l2chainId], l2EthAbi, l2SignerOrProvider);
    this.atomicDepositor = new Contract(atomicDepositorAddress, atomicDepositorAbi, l1Signer);
    this.l1Bridge = new Contract(l1MailboxAddress, l1MailboxAbi, l1Signer);
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

    // Calling this function requires knowledge of the l1 gas price. In the past, this task was deferred to the atomic depositor, which would use tx.gasprice to
    // obtain the effective_gas_price = block.base_fee_per_gas + priority_fee_per_gas. In general, this info is unknown to these bridges, since they just construct
    // the transaction and perform no simulation or priority fee adjustment. Here, we just estimate the gas price and multiply by a small amount to simulate priority fee
    // scaling.
    const currentGasPrice = await l1Provider.getGasPrice();
    const l2TransactionBaseCost = await this.getL1Bridge().l2TransactionBaseCost(
      currentGasPrice.mul(DEFAULT_GAS_MULTIPLIER[this.l2chainId] ?? 1),
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
    // To fund the l2 transaction, we withdraw `amount + gasCost` worth of WETH, but only specify `amount` to bridge in bridgeCalldata.
    return Promise.resolve({
      contract: this.atomicDepositor,
      method: "bridgeWeth",
      args: [this.l2chainId, amount + l2TransactionBaseCost, bridgeCalldata],
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // This fn will only work to track EOA's or the SpokePool's transfers, so exclude the hub pool
    // and any L2 contracts that are not the SpokePool.
    if (fromAddress === this.getHubPool().address) {
      return Promise.resolve({});
    }
    const isL2Contract = await this.isL2ChainContract(toAddress);
    const hubPool = this.getHubPool();

    // If sending WETH from EOA, we can assume the EOA is unwrapping ETH and sending it through the
    // AtomicDepositor. If sending WETH from a contract, then the only event we can track from a ZkSync contract
    // is the NewPriorityRequest event which doesn't have any parameters about the 'to' or 'amount' sent.
    // Therefore, we must track the HubPool and assume any transfers we are tracking from contracts are
    // being sent by the HubPool.
    const events = await paginatedEventQuery(
      isL2Contract ? hubPool : this.atomicDepositor,
      isL2Contract
        ? hubPool.filters.TokensRelayed()
        : this.atomicDepositor.filters.AtomicWethDepositInitiated(fromAddress, this.l2chainId),
      eventConfig
    );
    // We have no way of knowing the recipient of the atomic depositor, however, we know the depositor is an EOA, so we assume that from === to.
    const processedEvents = events.map((event) =>
      isL2Contract ? processEvent(event, "amount", "to", "l2Token") : processEvent(event, "amount", "from", "from")
    );
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
    // This fn will also only work to track EOA's or the SpokePool's transfers, so exclude the hub pool
    // and any L2 contracts that are not the SpokePool.
    if (fromAddress === this.getHubPool().address) {
      return Promise.resolve({});
    }

    const isL2Contract = await this.isL2ChainContract(toAddress);
    const hubPool = this.getHubPool();
    const events = await paginatedEventQuery(
      this.l2Eth,
      this.l2Eth.filters.Transfer(
        zksync.utils.applyL1ToL2Alias(isL2Contract ? hubPool.address : this.atomicDepositor.address),
        toAddress
      ),
      eventConfig
    );
    // For WETH transfers involving an EOA, only count them if a wrap txn followed the L2 deposit finalization.
    if (isL2Contract) {
      events.concat(
        await paginatedEventQuery(this.l2Weth, this.l2Weth.filters.Transfer(ZERO_ADDRESS, fromAddress), eventConfig)
      );
    }
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "amount", "_to", "_from")),
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
