import { BigNumber, Contract } from "ethers";
import { BaseAdapter } from "./BaseAdapter";
import { OutstandingTransfers } from "../../interfaces";
import { TransactionResponse, fromWei, winston } from "../../utils";
import { SpokePoolClient } from "../SpokePoolClient";
import { MultiCallerClient } from "../MultiCallerClient";
import assert from "assert";
import * as zksync from "zksync-web3";
import { CONTRACT_ADDRESSES } from "../../common";
import { TOKEN_SYMBOLS_MAP } from "@across-protocol/contracts-v2";
import { isDefined } from "../../utils/TypeGuards";
import { gasPriceOracle } from "@across-protocol/sdk-v2";

/**
 * Responsible for providing a common interface for interacting with the ZKSync Era
 * where related to Across' inventory management.
 */
export class ZKSyncAdapter extends BaseAdapter {
  // Tokens we know for sure that use the default L1 ERC20 bridge to bridge to ZkSync. This is added here for safety
  // so that we don't accidentally burn tokens by sending them over the wrong bridge contract. WETH/ETH is supported
  // via a different code path so its always supported.

  readonly supportedERC20s = ["USDC", "USDT", "WBTC"];
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly multicallerClient: MultiCallerClient,
    monitoredAddresses: string[]
  ) {
    super(spokePoolClients, 324, monitoredAddresses, logger);
  }

  // TODO: This will require observing production transfers to determine the correct events and contracts to track on
  // the L1 and L2 side.
  getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<OutstandingTransfers> {
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();
    this.log("Getting cross-chain txs", { l1Tokens, l1Config: l1SearchConfig, l2Config: l2SearchConfig });

    for (const l1Token of l1Tokens) {
      for (const monitoredAddress of this.monitoredAddresses) {
        l1Token;
        monitoredAddress;
        continue;
      }
    }
    throw new Error("Method not implemented.");
  }

  async sendTokenToTargetChain(
    address: string,
    l1Token: string,
    _l2Token: string,
    amount: BigNumber
  ): Promise<TransactionResponse> {
    const { chainId: destinationChainId, multicallerClient } = this;
    assert(destinationChainId === 324, `chainId ${destinationChainId} is not supported`);

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
    const [l1GasPriceData, l2GasLimit] = await Promise.all([
      gasPriceOracle.getGasPriceEstimate(this.getProvider(1), 1),
      zksync.utils.estimateDefaultBridgeDepositL2Gas(
        this.getProvider(1),
        // Need to pass in a custom ZkSyncProvider object here. We could grab this from the environment if we can
        // pull in the URL from the existing ZkSync provider.
        new zksync.Provider("https://mainnet.era.zksync.io"),
        l1Token,
        amount,
        address,
        address,
        gasPerPubdataLimit
      ),
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

    if (this.isWeth(l1Token)) {
      // 1. Unwrap WETH:
      this.log("Unwrapping WETH to deposit as ETH to ZkSync", { amount });
      const l1Weth = this.getWeth();
      multicallerClient.enqueueTransaction({
        contract: l1Weth,
        chainId: 1,
        method: "withdraw",
        args: [amount],
        message: "📦⭐️ Unwrapping WETH to deposit as ETH to ZkSync",
        mrkdwn: `📦⭐️ Unwrapping ${fromWei(amount.toString())} WETH to deposit as ETH to ZkSync`,
      });

      // 2. Send newly unwrapped ETH to ZkSync.
      const args = [
        address, // L2 receiver
        amount, // Amount
        "0x", // Data, set to 0x since we just want to send ETH
        l2GasLimit.toString(), // L2 gas limit
        gasPerPubdataLimit, // GasPerPubdataLimit.
        [], // Factory deps: An array of L2 bytecodes that will be marked as known on L2. Leave as [] unless
        // deploying a contract with libraries.
        address, // Refund recipient. Can set to address if an EOA.
      ];
      // We need to figure out how much ETH we'll have to include as msg.value in order to execute this message.
      multicallerClient.enqueueTransaction({
        contract: mailboxContract,
        chainId: 1,
        method: "requestL2Transaction",
        args,
        message: "💌⭐️ Sending ETH to ZkSync",
        mrkdwn: `💌⭐️ Sending ${fromWei(amount.toString())} ETH to ZkSync`,
        value: l2TransactionBaseCost.add(amount),
      });
    }
    // If the token is an ERC20, use the default ERC20 bridge. We might need to use custom ERC20 bridges for other
    // tokens in the future but for now, all supported tokens including USDT, USDC and WBTC use this bridge.
    else {
      const tokenInfo = Object.values(TOKEN_SYMBOLS_MAP).find(({ addresses }) => {
        return addresses[1] === l1Token;
      });
      if (!isDefined(tokenInfo)) {
        throw new Error(`Cannot find L1 token ${l1Token} in TOKEN_SYMBOLS_MAP`);
      }
      const isTokenSupported = this.supportedERC20s.includes(tokenInfo.symbol);
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

      multicallerClient.enqueueTransaction({
        contract: this.getL1ERC20BridgeContract(),
        chainId: 1,
        method: "deposit",
        args,
        message: `💌🪙 Sending ${tokenInfo.symbol} to ZkSync`,
        mrkdwn: `💌🪙 Sending ${fromWei(amount.toString(), tokenInfo.decimals)} ${tokenInfo.symbol} to ZkSync`,
        value: l2TransactionBaseCost,
      });
    }

    // TODO: For now, execute the multicaller client here because the BaseAdapter interface expects this function to
    // return a TransactionResponse object including a transaction hash. In the future, change all the other
    // L2 adapters to also use the multicaller client so that the downstream caller, i.e. the Relayer, can potentially
    // batch together several rebalance transactions.
    const hashes = await multicallerClient.executeTransactionQueue();
    // Send latest hash which should be the call to the ZkSync system contract.
    return { hash: hashes[hashes.length - 1] } as TransactionResponse;
  }

  async checkTokenApprovals(address: string, l1Tokens: string[]): Promise<void> {
    const associatedL1Bridges = l1Tokens
      // We unwrap WETH to send it over as ETH so it doesn't require an approval.
      .filter((token) => !this.isWeth(token) && !this.supportedERC20s.includes(token))
      .map(() => this.getL1ERC20BridgeContract().address);
    await this.checkAndSendTokenApprovals(address, l1Tokens, associatedL1Bridges);
  }

  private getMailboxContract(): Contract {
    const zkSyncMailboxContractData = CONTRACT_ADDRESSES[1]?.zkSyncMailbox;
    if (!zkSyncMailboxContractData) {
      throw new Error(`zkSyncMailboxContractData not found for chain ${1}`);
    }
    return new Contract(zkSyncMailboxContractData.address, zkSyncMailboxContractData.abi, this.getSigner(1));
  }

  private getL1ERC20BridgeContract(): Contract {
    const l1Erc20BridgeContractData = CONTRACT_ADDRESSES[1]?.zkSyncDefaultErc20Bridge;
    if (!l1Erc20BridgeContractData) {
      throw new Error(`l1Erc20BridgeContractData not found for chain ${1}`);
    }
    return new Contract(l1Erc20BridgeContractData.address, l1Erc20BridgeContractData.abi, this.getSigner(1));
  }
}
