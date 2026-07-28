import { AnyDepositAddressMessage, DepositAddressMessageV3, isDepositAddressMessageV3 } from "../interfaces";
import { isDefined, isNativeTokenSentinel, TransactionReceipt, utils } from "../utils";

export const ERC20_TRANSFER_TOPIC = utils.id("Transfer(address,address,uint256)");

/**
 * `Withdraw(address indexed token, address indexed to, uint256 amount)` emitted by
 * `WithdrawImplementation` (via delegatecall, so `log.address` is the deposit address). Native
 * withdraws emit no ERC20 `Transfer`, so this event is the only on-chain trace of the settlement.
 */
export const WITHDRAW_TOPIC = utils.id("Withdraw(address,address,uint256)");

/**
 * Body of a deposit-address execution lifecycle event (`withdraw_executed` / `deposit_executed`).
 * Carried in the `data` field of the outer envelope so future message types can attach their own
 * `data` shape under the same `{ type, data }` skeleton. Both event types share this shape; only
 * the `type` discriminator differs.
 */
export type WithdrawExecutedData = {
  chainId: number;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  erc20Transfer: {
    chainId: number;
    blockNumber: number;
    txHash: string;
    logIndex: number;
  };
};

export type WithdrawExecutedPayload = {
  type: "withdraw_executed";
  data: WithdrawExecutedData;
};

/** Shares `WithdrawExecutedData`'s shape; emitted for successful v3 deposit (correct-transfer) executions. */
export type DepositExecutedData = WithdrawExecutedData;

export type DepositExecutedPayload = {
  type: "deposit_executed";
  data: DepositExecutedData;
};

/**
 * Returns the last log in `receipt` recording `token` leaving `depositAddress`. When `to` is
 * provided, the recipient topic must match as well — used by the withdraw path to disambiguate
 * fee-on-transfer / tax / burn tokens that emit several Transfer events from the deposit address
 * in one tx. The deposit-execute path omits `to`: funds leave the deposit address to the
 * SpokePool / CCTP (no fixed recipient), so any outgoing transfer of the input token qualifies.
 * The **last** match is returned in both cases — the final settlement out of the deposit address
 * (handles Multicall3-bundled txs with intermediate hops). Returns `undefined` when no log matches.
 *
 * For ERC-20 tokens the log is the `Transfer(address,address,uint256)` emitted by the token
 * contract (`from` topic = deposit address). For the native-token sentinel there is no Transfer
 * event; the log is the `Withdraw(address,address,uint256)` emitted by the deposit address itself
 * (delegatecalled `WithdrawImplementation`), with the sentinel in the `token` topic.
 */
function findLastTransferFromDepositAddress(
  receipt: TransactionReceipt,
  token: string,
  depositAddress: string,
  to?: string
): TransactionReceipt["logs"][number] | undefined {
  const paddedTo = isDefined(to) ? utils.hexZeroPad(to.toLowerCase(), 32) : undefined;
  const matchingLogs = isNativeTokenSentinel(token)
    ? receipt.logs.filter(
        (log) =>
          log.address.toLowerCase() === depositAddress.toLowerCase() &&
          log.topics[0] === WITHDRAW_TOPIC &&
          log.topics[1]?.toLowerCase() === utils.hexZeroPad(token.toLowerCase(), 32) &&
          (!isDefined(paddedTo) || log.topics[2]?.toLowerCase() === paddedTo)
      )
    : receipt.logs.filter(
        (log) =>
          log.address.toLowerCase() === token.toLowerCase() &&
          log.topics[0] === ERC20_TRANSFER_TOPIC &&
          log.topics[1]?.toLowerCase() === utils.hexZeroPad(depositAddress.toLowerCase(), 32) &&
          (!isDefined(paddedTo) || log.topics[2]?.toLowerCase() === paddedTo)
      );
  return matchingLogs.length === 0 ? undefined : matchingLogs[matchingLogs.length - 1];
}

/**
 * Builds the `withdraw_executed` payload published to GCP Pub/Sub. Returns `undefined` when
 * the receipt contains no ERC20 `Transfer` event matching the expected
 * `(address=token, from=depositAddress, to=refundAddress)` — caller should warn and skip.
 *
 * The `to=refundAddress` constraint disambiguates fee-on-transfer / tax / burn tokens that
 * emit several `Transfer` events from the deposit address in one tx (one to the user, one
 * to a fee recipient, etc.). If multiple Transfer logs still match all three filters (e.g.
 * a Multicall3-bundled withdraw with intermediate hops to the same refund address), the
 * **last** match is used — that is the final settlement out of the deposit address.
 *
 * The envelope shape `{ type, data }` is shared by every Pub/Sub message the bot publishes;
 * `data`'s shape varies per `type`. The consumer at
 * `indexer/packages/indexer/src/pubsub/DepositAddressWithdrawConsumer.ts` keys on `type`
 * and validates `data` against the matching schema.
 */
export function buildWithdrawExecutedPayload(
  receipt: TransactionReceipt,
  depositMessage: AnyDepositAddressMessage
): WithdrawExecutedPayload | undefined {
  const { erc20Transfer, depositAddress } = depositMessage;
  const token = erc20Transfer.contractAddress;
  // v3 carries the refund recipient as a namespaced account; v1 carries it on routeParams.
  const refundAddress = isDepositAddressMessageV3(depositMessage)
    ? depositMessage.refundAddress.address
    : depositMessage.routeParams.refundAddress;

  const transferLog = findLastTransferFromDepositAddress(receipt, token, depositAddress, refundAddress);
  if (!isDefined(transferLog)) {
    return undefined;
  }

  return {
    type: "withdraw_executed",
    data: {
      chainId: Number(erc20Transfer.chainId),
      blockNumber: receipt.blockNumber,
      txHash: receipt.transactionHash.toLowerCase(),
      logIndex: transferLog.logIndex,
      erc20Transfer: {
        chainId: Number(erc20Transfer.chainId),
        blockNumber: erc20Transfer.blockNumber,
        txHash: erc20Transfer.transactionHash.toLowerCase(),
        logIndex: erc20Transfer.logIndex,
      },
    },
  };
}

/**
 * Builds the `deposit_executed` payload published to GCP Pub/Sub after a successful v3 deposit
 * (correct-transfer) execution. Returns `undefined` when the receipt contains no ERC20 `Transfer`
 * of the input token leaving the deposit address — caller should warn and skip.
 *
 * Unlike the withdraw path there is no fixed recipient to match on: the execute moves the input
 * token out of the deposit address into the SpokePool / CCTP, so any outgoing transfer of the
 * input token qualifies and the **last** match is used (final settlement out of the deposit
 * address). The inner `data.erc20Transfer` block is the inbound funding transfer from the indexer
 * (the consumer's row-lookup key); the sibling fields identify the execute transaction.
 *
 * The envelope shape `{ type, data }` is shared with `withdraw_executed`; only the `type` differs.
 */
export function buildDepositExecutedPayload(
  receipt: TransactionReceipt,
  depositMessage: DepositAddressMessageV3
): DepositExecutedPayload | undefined {
  const { erc20Transfer, depositAddress } = depositMessage;
  const token = erc20Transfer.contractAddress;

  const transferLog = findLastTransferFromDepositAddress(receipt, token, depositAddress);
  if (!isDefined(transferLog)) {
    return undefined;
  }

  return {
    type: "deposit_executed",
    data: {
      chainId: Number(erc20Transfer.chainId),
      blockNumber: receipt.blockNumber,
      txHash: receipt.transactionHash.toLowerCase(),
      logIndex: transferLog.logIndex,
      erc20Transfer: {
        chainId: Number(erc20Transfer.chainId),
        blockNumber: erc20Transfer.blockNumber,
        txHash: erc20Transfer.transactionHash.toLowerCase(),
        logIndex: erc20Transfer.logIndex,
      },
    },
  };
}
