import { Contract, BigNumber, paginatedEventQuery, Signer, EventSearchConfig, Provider } from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { isDefined } from "../../utils/TypeGuards";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";
import * as zksync from "zksync-web3";
import { gasPriceOracle } from "@across-protocol/sdk";
import { zkSync as zkSyncUtils } from "../../utils/chains";

/* For both the canonical bridge (this bridge) and the ZkSync Weth
 * bridge, we need to assume that the l1 and l2 signers contain
 * associated providers, since we need to get information about
 * addresses and gas prices (this is also why `constructL1toL2Txn`
 * is an async fn).
 */
export class ZKSyncBridge extends BaseBridgeAdapter {
  protected l1Bridge: Contract;
  protected l2Bridge: Contract;
  protected zkSyncMailbox: Contract;

  private readonly gasPerPubdataLimit = zksync.utils.REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT;
  private readonly l2GasLimit = 2_000_000; // We should dynamically define this.

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
  }

  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    const l1Provider = this.l1Bridge.provider;
    const l2Provider = this.l2Bridge.provider;

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
      : BigNumber.from(2_000_000);

    const l1GasPriceData = await gasPriceOracle.getGasPriceEstimate(l1Provider);
    // The ZkSync Mailbox contract checks that the msg.value of the transaction is enough to cover the transaction base
    // cost. The transaction base cost can be queried from the Mailbox by passing in an L1 "executed" gas price,
    // which is the priority fee plus base fee. This is the same as calling tx.gasprice on-chain as the Mailbox
    // contract does here:
    // https://github.com/matter-labs/era-contracts/blob/3a4506522aaef81485d8abb96f5a6394bd2ba69e/ethereum/contracts/zksync/facets/Mailbox.sol#L287

    // The l2TransactionBaseCost needs to be included as msg.value to pay for the transaction. its a bit of an
    // overestimate if the estimatedL1GasPrice and/or l2GasLimit are overestimates, and if its insufficient then the
    // L1 transaction will revert.

    const estimatedL1GasPrice = l1GasPriceData.maxPriorityFeePerGas.add(l1GasPriceData.maxFeePerGas);
    const l2TransactionBaseCost = await this.zkSyncMailbox.l2TransactionBaseCost(
      estimatedL1GasPrice,
      l2GasLimit,
      this.gasPerPubdataLimit
    );
    return Promise.resolve({
      contract: this.l1Bridge,
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
    const events = await paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.DepositInitiated(undefined, fromAddress, fromAddress),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "_amount", "_to", "from")),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l2Token = this.resolveL2TokenAddress(l1Token);
    const events = await paginatedEventQuery(
      this.l2Bridge,
      this.l2Bridge.filters.FinalizeDeposit(fromAddress, fromAddress, l2Token),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "_amount", "_to", "l1Sender")),
    };
  }
}
