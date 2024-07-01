import { BigNumber, BigNumberish, Contract } from "ethers";
import { BaseAdapter } from "./BaseAdapter";
import { OutstandingTransfers, SortableEvent } from "../../interfaces";
import {
  EventSearchConfig,
  paginatedEventQuery,
  TransactionResponse,
  winston,
  spreadEventWithBlockNumber,
  assign,
  Event,
  Provider,
  ZERO_ADDRESS,
  TOKEN_SYMBOLS_MAP,
  bnZero,
  CHAIN_IDs,
} from "../../utils";
import { SpokePoolClient } from "../.";
import assert from "assert";
import * as zksync from "zksync-web3";
import { CONTRACT_ADDRESSES, SUPPORTED_TOKENS } from "../../common";
import { isDefined } from "../../utils/TypeGuards";
import { gasPriceOracle, utils } from "@across-protocol/sdk";
import { zkSync as zkSyncUtils } from "../../utils/chains";
import { matchL2EthDepositAndWrapEvents } from "./utils";

/**
 * Responsible for providing a common interface for interacting with the ZKSync Era
 * where related to Across' inventory management.
 */
export class ZKSyncAdapter extends BaseAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    const { ZK_SYNC } = CHAIN_IDs;
    super(spokePoolClients, ZK_SYNC, monitoredAddresses, logger, SUPPORTED_TOKENS[ZK_SYNC]);
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<OutstandingTransfers> {
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();

    // Resolve the mailbox and bridge contracts for L1 and L2.
    const l2WethContract = this.getL2Weth();
    const atomicWethDepositor = this.getAtomicDepositor();
    const hubPool = this.getHubPool();
    const l1ERC20Bridge = this.getL1ERC20BridgeContract();
    const l2ERC20Bridge = this.getL2ERC20BridgeContract();
    const supportedL1Tokens = this.filterSupportedTokens(l1Tokens);

    // Predeclare this function for use below. It is used to process all events that are saved.
    const processEvent = (event: Event) => {
      // All events will have _amount and _to parameters.
      const eventSpread = spreadEventWithBlockNumber(event) as SortableEvent & {
        _amount: BigNumberish;
        _to: string;
        // WETH deposit events `ZkSyncEthDepositInitiated` (emitted by AtomicWethDepositor) don't have an l1Token param.
        l1Token?: string;
      };
      return {
        amount: eventSpread["_amount"],
        to: eventSpread["_to"],
        token: eventSpread?.l1Token ?? ZERO_ADDRESS,
        ...eventSpread,
      };
    };

    await utils.mapAsync(this.monitoredAddresses, async (address) => {
      return await utils.mapAsync(supportedL1Tokens, async (l1TokenAddress) => {
        const isL2Contract = await this.isL2ChainContract(address);
        // This adapter will only work to track EOA's or the SpokePool's transfers, so exclude the hub pool
        // and any L2 contracts that are not the SpokePool.
        if (address === hubPool.address) {
          return;
        }
        const isSpokePoolContract = isL2Contract;

        let initiatedQueryResult: Event[], finalizedQueryResult: Event[], wrapQueryResult: Event[];

        // Resolve whether the token is WETH or not.
        const isWeth = this.isWeth(l1TokenAddress);
        const l2Token = this.resolveL2TokenAddress(l1TokenAddress, false); // CCTP doesn't exist on ZkSync.
        if (isWeth) {
          // If sending WETH from EOA, we can assume the EOA is unwrapping ETH and sending it through the
          // AtomicDepositor. If sending WETH from a contract, then the only event we can track from a ZkSync contract
          // is the NewPriorityRequest event which doesn't have any parameters about the 'to' or 'amount' sent.
          // Therefore, we must track the HubPool and assume any transfers we are tracking from contracts are
          // being sent by the HubPool.
          const l1Bridge = isSpokePoolContract ? hubPool : atomicWethDepositor;
          const l2Sender = zksync.utils.applyL1ToL2Alias(
            isSpokePoolContract ? hubPool.address : atomicWethDepositor.address
          );

          const queries = [
            this.getWETHDeposits(l1Bridge, l1SearchConfig, address, address),
            // L2 WETH transfer will come from aliased L1 contract that initiated the deposit.
            this.getWETHReceipts(this.getL2Eth(), l2SearchConfig, l2Sender, address),
          ];

          // For WETH transfers involving an EOA, only count them if a wrap txn followed the L2 deposit finalization.
          if (!isSpokePoolContract) {
            const filter = l2WethContract.filters.Transfer(ZERO_ADDRESS, address);
            queries.push(paginatedEventQuery(l2WethContract, filter, l2SearchConfig));
          }
          [initiatedQueryResult, finalizedQueryResult, wrapQueryResult] = await Promise.all(queries);

          if (isSpokePoolContract) {
            // Filter here if monitoring SpokePool address since TokensRelayed does not have any indexed params.
            initiatedQueryResult = initiatedQueryResult.filter(
              (e) => e.args.to === address && e.args.l1Token === l1TokenAddress
            );
          } else {
            // If EOA, additionally verify that the ETH deposit was followed by a WETH wrap event.
            finalizedQueryResult = matchL2EthDepositAndWrapEvents(finalizedQueryResult, wrapQueryResult);
          }
        } else {
          const [from, to] = isL2Contract ? [hubPool.address, null] : [address, address];
          [initiatedQueryResult, finalizedQueryResult] = await Promise.all([
            this.getERC20Deposits(l1ERC20Bridge, l1SearchConfig, from, to),
            this.getERC20Receipts(l2ERC20Bridge, l2SearchConfig, from, to),
          ]);
        }

        assign(
          this.l1DepositInitiatedEvents,
          [address, l1TokenAddress, l2Token],
          // An initiatedQueryResult could be a zkSync DepositInitiated or an AtomicDepositor
          // ZkSyncEthDepositInitiated event, subject to whether the deposit token was WETH or not.
          // A ZkSyncEthDepositInitiated event doesn't have a token or l1Token param.
          initiatedQueryResult.map(processEvent).filter((e) => isWeth || e.l1Token === l1TokenAddress)
        );
        assign(
          this.l2DepositFinalizedEvents,
          [address, l1TokenAddress, l2Token],
          finalizedQueryResult.map(processEvent)
        );
      });
    });

    this.baseL1SearchConfig.fromBlock = l1SearchConfig.toBlock + 1;
    this.baseL2SearchConfig.fromBlock = l2SearchConfig.toBlock + 1;

    return this.computeOutstandingCrossChainTransfers(l1Tokens);
  }

  async getWETHDeposits(
    l1Bridge: Contract,
    searchConfig: EventSearchConfig,
    sender: string | null = null,
    recipient: string | null = null
  ): Promise<Event[]> {
    const filter =
      l1Bridge.address === this.getHubPool().address
        ? l1Bridge.filters.TokensRelayed()
        : l1Bridge.filters.ZkSyncEthDepositInitiated(sender, recipient);

    return paginatedEventQuery(l1Bridge, filter, searchConfig);
  }

  async getERC20Deposits(
    l1Bridge: Contract,
    searchConfig: EventSearchConfig,
    sender: string | null = null,
    recipient: string | null = null
  ): Promise<Event[]> {
    return paginatedEventQuery(l1Bridge, l1Bridge.filters.DepositInitiated(null, sender, recipient), searchConfig);
  }

  async getWETHReceipts(
    l2Bridge: Contract,
    searchConfig: EventSearchConfig,
    sender: string | null = null,
    recipient: string | null = null
  ): Promise<Event[]> {
    return paginatedEventQuery(l2Bridge, l2Bridge.filters.Transfer(sender, recipient), searchConfig);
  }

  async getERC20Receipts(
    l2Bridge: Contract,
    searchConfig: EventSearchConfig,
    sender: string | null = null,
    recipient: string | null = null,
    l2Token: string | null = null
  ): Promise<Event[]> {
    return paginatedEventQuery(l2Bridge, l2Bridge.filters.FinalizeDeposit(sender, recipient, l2Token), searchConfig);
  }

  async sendTokenToTargetChain(
    address: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    simMode = false
  ): Promise<TransactionResponse> {
    const { chainId: destinationChainId } = this;
    assert(destinationChainId === 324, `chainId ${destinationChainId} is not supported`);
    assert(this.isSupportedToken(l1Token), `Token ${l1Token} is not supported`);

    // Load common data that we'll need in order to correctly submit an L1 to L2 message. Ultimately we're going to
    // need to know the amount of msg.value that we'll have to send to the ZkSync bridge contract (i.e. Mailbox
    // or ERC20 Bridge) to pay for our message.

    // You can read more about the L2 fee model including refunds and out of gas errors here:
    // https://era.zksync.io/docs/reference/concepts/fee-model.html

    // gasPerPubdataLimit: The maximum amount L2 gas that  the operator may charge the user for single byte of pubdata.
    // Hardcoded in SDK, must be exact as enforced by L1 Mailbox contract.
    const gasPerPubdataLimit = zksync.utils.REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT;

    // Next, load estimated executed L1 gas price of the message transaction and the L2 gas limit.
    const l1Provider = this.getProvider(this.hubChainId);
    const l2Provider = this.spokePoolClients[this.chainId].spokePool.provider;
    let zkProvider: zksync.Provider;
    try {
      zkProvider = zkSyncUtils.convertEthersRPCToZKSyncRPC(l2Provider);
    } catch (error) {
      this.logger.warn({
        at: "ZkSyncClient#sendTokenToTargetChain",
        message: "Failed to get zkProvider, are you on a testnet or hardhat network?",
        error,
      });
    }
    // If zkSync provider can't be created for some reason, default to a very conservative 2mil L2 gas limit
    // which should be sufficient for this transaction.
    const l2GasLimit = isDefined(zkProvider)
      ? await zksync.utils.estimateDefaultBridgeDepositL2Gas(
          l1Provider,
          zkProvider,
          l1Token,
          amount,
          address,
          address,
          gasPerPubdataLimit
        )
      : BigNumber.from(2_000_000);

    const contract = this.getL1TokenBridge(l1Token);
    let args = [
      address, // L2 receiver
      amount, // Amount
      l2GasLimit.toString(), // L2 gas limit
      gasPerPubdataLimit, // GasPerPubdataLimit.
      address, // Refund recipient. Can set to caller address if an EOA.
    ];
    let method = "bridgeWethToZkSync";
    let value = bnZero;

    // If not using AtomicDepositor with WETH, sending over default ERC20 bridge requires including enough
    // msg.value to cover the L2 transaction cost.
    if (!this.isWeth(l1Token)) {
      args = [
        address, // L2 receiver
        l1Token, // L1 token to deposit
        amount, // Amount
        l2GasLimit.toString(), // L2 gas limit
        gasPerPubdataLimit, // GasPerPubdataLimit.
      ];
      method = "deposit";
      value = await this.getL2GasCost(l1Provider, l2GasLimit, gasPerPubdataLimit);
    }

    // Empirically this has failed with out of gas without a >1 gas limit multiplier.
    return await this._sendTokenToTargetChain(l1Token, l2Token, amount, contract, method, args, 3, value, simMode);
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
    this.log("Computed L1-->L2 message parameters for ERC20 deposit", {
      l2Gas,
      gasPerPubdataLimit,
      estimatedL1GasPrice,
      l1GasPriceData,
    });

    return l2Gas;
  }

  /**
   * @notice sendTokenToTargetChain will send WETH as ETH to the L2 recipient so we need to implement
   * this function so that the AdapterManager can know when to wrap ETH into WETH.
   * @param threshold
   * @returns
   */
  async wrapEthIfAboveThreshold(
    threshold: BigNumber,
    target: BigNumber,
    simMode = false
  ): Promise<TransactionResponse | null> {
    const { chainId } = this;
    assert(chainId === 324, `chainId ${chainId} is not supported`);

    const l2WethAddress = TOKEN_SYMBOLS_MAP.WETH.addresses[chainId];
    const ethBalance = await this.getSigner(chainId).getBalance();
    if (ethBalance.gt(threshold)) {
      const l2Signer = this.getSigner(chainId);
      // @dev Can re-use ABI from L1 weth as its the same for the purposes of this function.
      const contract = new Contract(l2WethAddress, CONTRACT_ADDRESSES[this.hubChainId].weth.abi, l2Signer);
      const value = ethBalance.sub(target);
      this.logger.debug({ at: this.getName(), message: "Wrapping ETH", threshold, target, value, ethBalance });
      return await this._wrapEthIfAboveThreshold(threshold, contract, value, simMode);
    } else {
      this.logger.debug({
        at: this.getName(),
        message: "ETH balance below threshold",
        threshold,
        ethBalance,
      });
    }
    return null;
  }

  async checkTokenApprovals(address: string, l1Tokens: string[]): Promise<void> {
    const associatedL1Bridges = l1Tokens
      .filter((token) => this.isSupportedToken(token))
      .map((l1Token) => this.getL1TokenBridge(l1Token).address);
    await this.checkAndSendTokenApprovals(address, l1Tokens, associatedL1Bridges);
  }

  private getMailboxContract(): Contract {
    const { hubChainId } = this;
    const zkSyncMailboxContractData = CONTRACT_ADDRESSES[hubChainId]?.zkSyncMailbox;
    if (!zkSyncMailboxContractData) {
      throw new Error(`zkSyncMailboxContractData not found for chain ${hubChainId}`);
    }
    return new Contract(zkSyncMailboxContractData.address, zkSyncMailboxContractData.abi, this.getSigner(hubChainId));
  }

  private getL2Eth(): Contract {
    const { chainId } = this;
    const ethContractData = CONTRACT_ADDRESSES[chainId]?.eth;
    if (!ethContractData) {
      throw new Error(`ethContractData not found for chain ${chainId}`);
    }
    return new Contract(ethContractData.address, ethContractData.abi, this.getSigner(chainId));
  }

  private getL2Weth(): Contract {
    const { chainId } = this;
    const wethContractData = CONTRACT_ADDRESSES[chainId]?.weth;
    if (!wethContractData) {
      throw new Error(`wethContractData not found for chain ${chainId}`);
    }
    return new Contract(wethContractData.address, wethContractData.abi, this.getSigner(chainId));
  }

  protected getL1ERC20BridgeContract(): Contract {
    const { hubChainId } = this;
    const l1Erc20BridgeContractData = CONTRACT_ADDRESSES[hubChainId]?.zkSyncDefaultErc20Bridge;
    if (!l1Erc20BridgeContractData) {
      throw new Error(`l1Erc20BridgeContractData not found for chain ${hubChainId}`);
    }
    return new Contract(l1Erc20BridgeContractData.address, l1Erc20BridgeContractData.abi, this.getSigner(hubChainId));
  }

  protected getL1TokenBridge(l1Token: string): Contract {
    return this.isWeth(l1Token) ? this.getAtomicDepositor() : this.getL1ERC20BridgeContract();
  }

  protected getL2ERC20BridgeContract(): Contract {
    const { provider } = this.spokePoolClients[this.chainId].spokePool;
    const l2Erc20BridgeContractData = CONTRACT_ADDRESSES[this.chainId]?.zkSyncDefaultErc20Bridge;
    if (!l2Erc20BridgeContractData) {
      throw new Error(`l2Erc20BridgeContractData not found for chain ${this.chainId}`);
    }
    return new Contract(l2Erc20BridgeContractData.address, l2Erc20BridgeContractData.abi, provider);
  }
}
