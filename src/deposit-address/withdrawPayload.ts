import { AnyDepositAddressMessage, isDepositAddressMessageV3 } from "../interfaces";
import { TransactionReceipt, utils } from "../utils";

export const ERC20_TRANSFER_TOPIC = utils.id("Transfer(address,address,uint256)");

/**
 * Body of a `withdraw_executed` lifecycle event. Carried in the `data` field of the
 * outer envelope so future message types can attach their own `data` shape under the
 * same `{ type, data }` skeleton.
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

  const paddedFrom = utils.hexZeroPad(depositAddress.toLowerCase(), 32);
  const paddedTo = utils.hexZeroPad(refundAddress.toLowerCase(), 32);
  const transferLogs = receipt.logs.filter(
    (log) =>
      log.address.toLowerCase() === token.toLowerCase() &&
      log.topics[0] === ERC20_TRANSFER_TOPIC &&
      log.topics[1]?.toLowerCase() === paddedFrom &&
      log.topics[2]?.toLowerCase() === paddedTo
  );
  if (transferLogs.length === 0) {
    return undefined;
  }
  const transferLog = transferLogs[transferLogs.length - 1];

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
