import { DepositAddressMessage } from "../interfaces";
import { TransactionReceipt, utils } from "../utils";

export const ERC20_TRANSFER_TOPIC = utils.id("Transfer(address,address,uint256)");

export type WithdrawExecutedPayload = {
  type: "withdraw_executed";
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

/**
 * Builds the `withdraw_executed` payload published to GCP Pub/Sub. Returns `undefined` when
 * the receipt contains no ERC20 `Transfer` event with the expected
 * `(address=token, from=depositAddress)` — caller should warn and skip.
 *
 * When the receipt contains multiple matching Transfer logs (e.g. a Multicall3-bundled
 * withdraw that emits intermediate transfers), the **last** match is used. The final
 * Transfer out of the deposit address is the one that settles funds to the user, so its
 * logIndex is the canonical reference for the indexer row.
 *
 * The payload shape is locked by the indexer consumer
 * (`indexer/packages/indexer/src/pubsub/DepositAddressWithdrawConsumer.ts`).
 */
export function buildWithdrawExecutedPayload(
  receipt: TransactionReceipt,
  depositMessage: DepositAddressMessage
): WithdrawExecutedPayload | undefined {
  const { erc20Transfer, depositAddress } = depositMessage;
  const token = erc20Transfer.contractAddress;

  const paddedFrom = utils.hexZeroPad(depositAddress.toLowerCase(), 32);
  const transferLogs = receipt.logs.filter(
    (log) =>
      log.address.toLowerCase() === token.toLowerCase() &&
      log.topics[0] === ERC20_TRANSFER_TOPIC &&
      log.topics[1]?.toLowerCase() === paddedFrom
  );
  if (transferLogs.length === 0) {
    return undefined;
  }
  const transferLog = transferLogs[transferLogs.length - 1];

  return {
    type: "withdraw_executed",
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
  };
}
