import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  Signer,
  EventSearchConfig,
  Provider,
  isContractDeployedToAddress,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { isDefined } from "../../utils/TypeGuards";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";
import * as zksync from "zksync-ethers";
import { gasPriceOracle } from "@across-protocol/sdk";
import { zkSync as zkSyncUtils } from "../../utils/chains";

/* For both the canonical bridge (this bridge) and the ZkSync Weth
 * bridge, we need to assume that the l1 and l2 signers contain
 * associated providers, since we need to get information about
 * addresses and gas prices (this is also why `constructL1toL2Txn`
 * is an async fn).
 */
export class ZKSyncBridge extends BaseBridgeAdapter {
  protected zkSyncMailbox: Contract;
  protected hubPoolAddress: string;

  private readonly gasPerPubdataLimit = zksync.utils.REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT;
  private readonly l2GasLimit = BigNumber.from(2_000_000); // We should dynamically define this.

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    _l1Token: string
  ) {
    // Lint Appeasement
    _l1Token;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [
      CONTRACT_ADDRESSES[hubChainId].zkSyncDefaultErc20Bridge.address,
    ]);

    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].zkSyncDefaultErc20Bridge;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].zkSyncDefaultErc20Bridge;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);

    const { address: mailboxAddress, abi: mailboxAbi } = CONTRACT_ADDRESSES[hubChainId].zkSyncMailbox;
    this.zkSyncMailbox = new Contract(mailboxAddress, mailboxAbi, l1Signer);

    // Set the hub address so that the bridge can be aware of transfers between Hub -> Spoke
    this.hubPoolAddress = CONTRACT_ADDRESSES[hubChainId].hubPool.address;
  }

  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    const l1Provider = this.getL1Bridge().provider;
    const l2Provider = this.getL2Bridge().provider;

    let zkProvider;
    try {
      zkProvider = zkSyncUtils.convertEthersRPCToZKSyncRPC(l2Provider);
    } catch (error) {
      // We do not have a logger in this class
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
      : this.l2GasLimit;

    const l2TransactionBaseCost = await this.getL2GasCost(l1Provider, l2GasLimit, this.gasPerPubdataLimit);

    return Promise.resolve({
      contract: this.getL1Bridge(),
      method: "deposit",
      args: [toAddress, l1Token, amount, l2GasLimit.toString(), this.gasPerPubdataLimit],
      value: l2TransactionBaseCost,
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const isSpokePool = await isContractDeployedToAddress(toAddress, this.l2Bridge.provider);
    // If the monitored address is the hub pool address, then we automatically assume that
    // we are tracking a Hub -> Spoke transfer; therefore, we manually set the toAddress.
    // Otherwise, we make no assumptions of the tracking and make the associated query.
    const events = isSpokePool
      ? await paginatedEventQuery(
          this.getL1Bridge(),
          this.getL1Bridge().filters.DepositInitiated(undefined, this.hubPoolAddress, toAddress),
          eventConfig
        )
      : await paginatedEventQuery(
          this.getL1Bridge(),
          this.getL1Bridge().filters.DepositInitiated(undefined, fromAddress, toAddress),
          eventConfig
        );

    const filteredEvents = events.filter(({ args }) => args.l1Token === l1Token);
    return {
      [this.resolveL2TokenAddress(l1Token)]: filteredEvents.map((event) =>
        processEvent(event, "_amount", "_to", "from")
      ),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l2Token = this.resolveL2TokenAddress(l1Token);
    // Similar to the query, if we are sending to the spoke pool, we must assume that the sender is the hubPool,
    // so we add a special case for this reason.
    const isSpokePool = await isContractDeployedToAddress(toAddress, this.l2Bridge.provider);
    const events = isSpokePool
      ? await paginatedEventQuery(
          this.getL2Bridge(),
          this.getL2Bridge().filters.FinalizeDeposit(this.hubPoolAddress, toAddress, l2Token),
          eventConfig
        )
      : await paginatedEventQuery(
          this.getL2Bridge(),
          this.getL2Bridge().filters.FinalizeDeposit(fromAddress, toAddress, l2Token),
          eventConfig
        );

    return {
      [l2Token]: events.map((event) => processEvent(event, "_amount", "_to", "l1Sender")),
    };
  }

  protected async getL2GasCost(
    provider: Provider,
    l2GasLimit: BigNumber,
    gasPerPubdataLimit: number
  ): Promise<BigNumber> {
    const l1GasPriceData = await gasPriceOracle.getGasPriceEstimate(provider);

    // The ZkSync Mailbox contract checks that the msg.value of the transaction is enough to cover the transaction base
    // cost. The transaction base cost can be queried from the Mailbox by passing in an L1 "executed" gas price,
    // which is the priority fee plus base fee. This is the same as calling tx.gasprice on-chain as the Mailbox
    // contract does here:
    // https://github.com/matter-labs/era-contracts/blob/3a4506522aaef81485d8abb96f5a6394bd2ba69e/ethereum/contracts/zksync/facets/Mailbox.sol#L287

    // The l2TransactionBaseCost needs to be included as msg.value to pay for the transaction. its a bit of an
    // overestimate if the estimatedL1GasPrice and/or l2GasLimit are overestimates, and if its insufficient then the
    // L1 transaction will revert.

    const estimatedL1GasPrice = l1GasPriceData.maxPriorityFeePerGas.add(l1GasPriceData.maxFeePerGas);
    const l2Gas = await this.getMailboxContract().l2TransactionBaseCost(
      estimatedL1GasPrice,
      l2GasLimit,
      gasPerPubdataLimit
    );
    return l2Gas;
  }

  protected getMailboxContract(): Contract {
    return this.zkSyncMailbox;
  }
}
