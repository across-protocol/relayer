import { BigNumber, Contract } from "ethers";
import { BaseAdapter } from "./BaseAdapter";
import { OutstandingTransfers, SortableEvent } from "../../interfaces";
import {
  paginatedEventQuery,
  TransactionResponse,
  fromWei,
  winston,
  spreadEventWithBlockNumber,
  assign,
  Event,
  ZERO_ADDRESS,
  RetryProvider,
} from "../../utils";
import { SpokePoolClient } from "../SpokePoolClient";
import assert from "assert";
import * as zksync from "zksync-web3";
import { CONTRACT_ADDRESSES } from "../../common";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/contracts-v2";
import { isDefined } from "../../utils/TypeGuards";
import { gasPriceOracle } from "@across-protocol/sdk-v2";
import { convertEthersRPCToZKSyncRPC } from "../../utils/RPCUtils";
import { BigNumberish } from "../../utils/FormattingUtils";

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
    super(
      spokePoolClients,
      324,
      monitoredAddresses,
      logger,
      Object.values(TOKEN_SYMBOLS_MAP)
        .filter(({ addresses }) => isDefined(addresses[CHAIN_IDs.ZK_SYNC]))
        .map(({ symbol }) => symbol)
    );
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<OutstandingTransfers> {
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();
    this.log("Getting cross-chain txs", { l1Tokens, l1Config: l1SearchConfig, l2Config: l2SearchConfig });

    // Resolve the mailbox and bridge contracts for L1 and L2.
    const l2EthContract = this.getL2Eth();
    const atomicWethDepositor = this.getAtomicDepositor();
    const aliasedAtomicWethDepositor = zksync.utils.applyL1ToL2Alias(atomicWethDepositor.address);
    const l1ERC20Bridge = this.getL1ERC20BridgeContract();
    const l2ERC20Bridge = this.getL2ERC20BridgeContract();
    const supportedL1Tokens = l1Tokens.filter(this.isSupportedToken.bind(this));

    // Predeclare this function for use below. It is used to process all events that are saved.
    const processEvent = (event: Event) => {
      // All events will have _amount and _to parameters.
      const eventSpread = spreadEventWithBlockNumber(event) as SortableEvent & {
        _amount: BigNumberish;
        _to: string;
      };
      return {
        amount: eventSpread["_amount"],
        to: eventSpread["_to"],
        ...eventSpread,
      };
    };

    await Promise.all(
      this.monitoredAddresses.map((address) =>
        Promise.all(
          supportedL1Tokens.map(async (l1TokenAddress) => {
            // Resolve whether the token is WETH or not.
            const isWeth = this.isWeth(l1TokenAddress);

            let initiatedQueryResult: Event[], finalizedQueryResult: Event[];
            if (isWeth) {
              // If WETH, then the deposit initiated event will appear on AtomicDepositor and withdrawal finalized
              // will appear in mailbox.
              [initiatedQueryResult, finalizedQueryResult] = await Promise.all([
                // Filter on 'from' address and 'to' address
                paginatedEventQuery(
                  atomicWethDepositor,
                  atomicWethDepositor.filters.ZkSyncEthDepositInitiated(address, address),
                  l1SearchConfig
                ),

                // Filter on transfers between aliased AtomicDepositor address and l2Receiver
                paginatedEventQuery(
                  l2EthContract,
                  l2EthContract.filters.Transfer(aliasedAtomicWethDepositor, address),
                  l2SearchConfig
                ),
              ]);
            } else {
              [initiatedQueryResult, finalizedQueryResult] = await Promise.all([
                // Filter on 'from' and 'to' address
                paginatedEventQuery(
                  l1ERC20Bridge,
                  l1ERC20Bridge.filters.DepositInitiated(null, address, address),
                  l1SearchConfig
                ),

                // Filter on `l2Receiver` address and `l1Sender` address
                paginatedEventQuery(
                  l2ERC20Bridge,
                  l2ERC20Bridge.filters.FinalizeDeposit(address, address),
                  l2SearchConfig
                ),
              ]);
            }

            assign(this.l1DepositInitiatedEvents, [address, l1TokenAddress], initiatedQueryResult.map(processEvent));
            assign(this.l2DepositFinalizedEvents, [address, l1TokenAddress], finalizedQueryResult.map(processEvent));
          })
        )
      )
    );

    this.baseL1SearchConfig.fromBlock = l1SearchConfig.toBlock + 1;
    this.baseL1SearchConfig.fromBlock = l2SearchConfig.toBlock + 1;

    return this.computeOutstandingCrossChainTransfers(l1Tokens);
  }

  async sendTokenToTargetChain(
    address: string,
    l1Token: string,
    _l2Token: string,
    amount: BigNumber,
    simMode = false
  ): Promise<TransactionResponse> {
    const { chainId: destinationChainId } = this;
    assert(destinationChainId === 324, `chainId ${destinationChainId} is not supported`);
    assert(this.isSupportedToken(l1Token), `Token ${l1Token} is not supported`);

    const mailboxContract = this.getMailboxContract();

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
    let zkProvider;
    try {
      zkProvider = convertEthersRPCToZKSyncRPC(l2Provider as RetryProvider);
    } catch (error) {
      this.logger.error({
        at: "ZkSyncClient#sendTokenToTargetChain",
        message: "Failed to get zkProvider, are you on a testnet or hardhat network?",
        error,
      });
    }
    const [l1GasPriceData, l2GasLimit] = await Promise.all([
      gasPriceOracle.getGasPriceEstimate(l1Provider),
      isDefined(zkProvider)
        ? zksync.utils.estimateDefaultBridgeDepositL2Gas(
            l1Provider,
            zkProvider,
            l1Token,
            amount,
            address,
            address,
            gasPerPubdataLimit
          )
        : Promise.resolve(2_000_000),
    ]);

    // Now figure out the equivalent of the "tx.gasprice".
    const estimatedL1GasPrice = l1GasPriceData.maxPriorityFeePerGas.add(l1GasPriceData.maxFeePerGas);
    // The ZkSync Mailbox contract checks that the msg.value of the transaction is enough to cover the transaction base
    // cost. The transaction base cost can be queried from the Mailbox by passing in an L1 "executed" gas price,
    // which is the priority fee plus base fee. This is the same as calling tx.gasprice on-chain as the Mailbox
    // contract does here:
    // https://github.com/matter-labs/era-contracts/blob/3a4506522aaef81485d8abb96f5a6394bd2ba69e/ethereum/contracts/zksync/facets/Mailbox.sol#L287

    // The l2TransactionBaseCost needs to be included as msg.value to pay for the transaction. its a bit of an
    // overestimate if the estimatedL1GasPrice and/or l2GasLimit are overestimates, and if its insufficient then the
    // L1 transaction will revert.
    const l2TransactionBaseCost = await mailboxContract.l2TransactionBaseCost(
      estimatedL1GasPrice,
      l2GasLimit,
      gasPerPubdataLimit
    );
    this.log("Computed L1-->L2 message parameters", {
      l2TransactionBaseCost,
      gasPerPubdataLimit,
      estimatedL1GasPrice,
      l1GasPriceData,
      mailboxContract: mailboxContract.address,
    });

    const l1TokenBridge = this.getL1TokenBridge(l1Token);
    if (this.isWeth(l1Token)) {
      const args = [
        address, // L2 receiver
        amount, // Amount
        l2GasLimit.toString(), // L2 gas limit
        gasPerPubdataLimit, // GasPerPubdataLimit.
        address, // Refund recipient. Can set to caller address if an EOA.
      ];
      this.logger.debug({
        at: "ZkSyncClient#sendTokenToTargetChain",
        message: `💌⭐️ Sending ${fromWei(amount.toString())} ETH to ZkSync`,
      });
      const {
        succeed,
        reason,
        transaction: txnRequest,
      } = (
        await this.txnClient.simulate([
          { contract: l1TokenBridge, chainId: this.hubChainId, method: "bridgeWethToZkSync", args },
        ])
      )[0];
      if (!succeed) {
        const message = `Failed to simulate bridgeWethToZkSync deposit to chainId ${this.chainId} for mainnet token ${l1Token}`;
        this.logger.warn({ at: this.getName(), message, reason });
        throw new Error(`${message} (${reason})`);
      }
      if (simMode) {
        this.logger.info({
          at: "ZkSyncClient#sendTokenToTargetChain",
          message: `💌⭐️ Simulated sending ${fromWei(amount.toString())} ETH to ZkSync`,
          succeed,
        });
        return { hash: ZERO_ADDRESS } as TransactionResponse;
      } else {
        return (await this.txnClient.submit(this.hubChainId, [txnRequest]))[0];
      }
    }
    // If the token is an ERC20, use the default ERC20 bridge. We might need to use custom ERC20 bridges for other
    // tokens in the future but for now, all supported tokens including USDT, USDC and WBTC use this bridge.
    else {
      const tokenInfo = Object.values(TOKEN_SYMBOLS_MAP).find(({ addresses }) => {
        return addresses[this.hubChainId] === l1Token;
      });
      if (!isDefined(tokenInfo)) {
        throw new Error(`Cannot find L1 token ${l1Token} on chain ID ${this.hubChainId} in TOKEN_SYMBOLS_MAP`);
      }
      const isTokenSupported = this.isSupportedToken(l1Token);
      if (!isTokenSupported) {
        throw new Error(`Token ${l1Token} is not supported, make sure to add it to this.supportedERC20s`);
      }
      const args = [
        address, // L2 receiver
        l1Token, // L1 token to deposit
        amount, // Amount
        l2GasLimit.toString(), // L2 gas limit
        gasPerPubdataLimit, // GasPerPubdataLimit.
      ];
      this.logger.debug({
        at: "ZkSyncClient#sendTokenToTargetChain",
        message: `💌🪙 Sending ${fromWei(amount.toString(), tokenInfo.decimals)} ${tokenInfo.symbol} to ZkSync`,
      });
      const {
        succeed,
        reason,
        transaction: txnRequest,
      } = (
        await this.txnClient.simulate([
          { contract: l1TokenBridge, chainId: this.hubChainId, method: "deposit", args, value: l2TransactionBaseCost },
        ])
      )[0];
      if (!succeed) {
        const message = `Failed to simulate deposit to chainId ${this.chainId} for mainnet token ${l1Token}`;
        this.logger.warn({ at: this.getName(), message, reason });
        throw new Error(`${message} (${reason})`);
      }
      if (simMode) {
        this.logger.info({
          at: "ZkSyncClient#sendTokenToTargetChain",
          message: `💌⭐️ Simulated sending ${fromWei(amount.toString(), tokenInfo.decimals)} ERC20 to ZkSync`,
          succeed,
        });
        return { hash: ZERO_ADDRESS } as TransactionResponse;
      } else {
        return (await this.txnClient.submit(this.hubChainId, [txnRequest]))[0];
      }
    }
  }

  /**
   * @notice sendTokenToTargetChain will send WETH as ETH to the L2 recipient so we need to implement
   * this function so that the AdapterManager can know when to wrap ETH into WETH.
   * @param threshold
   * @returns
   */
  async wrapEthIfAboveThreshold(threshold: BigNumber): Promise<TransactionResponse | null> {
    const { chainId, txnClient } = this;
    assert(chainId === 324, `chainId ${chainId} is not supported`);

    const l2WethAddress = TOKEN_SYMBOLS_MAP.WETH.addresses[chainId];
    const ethBalance = await this.getSigner(chainId).getBalance();
    if (ethBalance.gt(threshold)) {
      const l2Signer = this.getSigner(chainId);
      // @dev Can re-use ABI from L1 weth as its the same for the purposes of this function.
      const contract = new Contract(l2WethAddress, CONTRACT_ADDRESSES[this.hubChainId].weth.abi, l2Signer);
      const method = "deposit";
      const value = ethBalance.sub(threshold);
      this.logger.debug({ at: this.getName(), message: "Wrapping ETH", threshold, value, ethBalance });
      return (await txnClient.submit(chainId, [{ contract, chainId, method, args: [], value }]))[0];
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
      throw new Error(`contractData not found for chain ${chainId}`);
    }
    return new Contract(ethContractData.address, ethContractData.abi, this.getSigner(chainId));
  }

  private getL1ERC20BridgeContract(): Contract {
    const { hubChainId } = this;
    const l1Erc20BridgeContractData = CONTRACT_ADDRESSES[hubChainId]?.zkSyncDefaultErc20Bridge;
    if (!l1Erc20BridgeContractData) {
      throw new Error(`l1Erc20BridgeContractData not found for chain ${hubChainId}`);
    }
    return new Contract(l1Erc20BridgeContractData.address, l1Erc20BridgeContractData.abi, this.getSigner(hubChainId));
  }

  private getL1TokenBridge(l1Token: string): Contract {
    if (this.isWeth(l1Token)) {
      return this.getAtomicDepositor();
    } else {
      return this.getL1ERC20BridgeContract();
    }
  }

  private getL2ERC20BridgeContract(): Contract {
    const { provider } = this.spokePoolClients[this.chainId].spokePool;
    const l2Erc20BridgeContractData = CONTRACT_ADDRESSES[this.chainId]?.zkSyncDefaultErc20Bridge;
    if (!l2Erc20BridgeContractData) {
      throw new Error(`l2Erc20BridgeContractData not found for chain ${this.chainId}`);
    }
    return new Contract(l2Erc20BridgeContractData.address, l2Erc20BridgeContractData.abi, provider);
  }
}
