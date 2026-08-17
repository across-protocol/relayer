import { buildWithdrawExecutedPayload } from "../deposit-address/withdrawPayload";
import { DepositAddressMessageV3 } from "../interfaces/DepositAddress";
import { GcpPubSubPublisher } from "../messaging/gcp";
import { Provider, TransactionReceipt, winston } from "../utils";
import { isDefined } from "../utils/TypeGuards";
import { TransientDependencyError, WithdrawPublicationError } from "./errors";
import { receiptLookupHash } from "./pendingTransaction";
import { TransferState, TransferStore, WithdrawExecutedState, classifyReceipt } from "./transferState";

export interface WithdrawLifecycleDeps {
  logger: winston.Logger;
  store: TransferStore;
  publisher: GcpPubSubPublisher;
  topic: string;
}

/**
 * Whether this transfer still owes the indexer a `withdraw_executed` announcement.
 *
 * A deposit never does — the indexer ingests its on-chain provenance event, so the service publishes none. A
 * withdrawal has no such event, which is why the announcement is durable state rather than a step of the
 * request that made it: a publish that failed leaves `withdraw_executed` in place with no timestamp, and the
 * next delivery finishes the job. A withdrawal settled while the publisher gate was off is likewise unstamped,
 * so turning the gate on lets a later delivery announce it after the fact.
 *
 * Deliberately a statement about the **state**, never about the message's classification: a `correct_transfer`
 * the execute endpoint rejected as below the minimum was refunded too, and owes the same announcement.
 */
export function awaitsWithdrawPublication(state: TransferState | undefined): state is WithdrawExecutedState {
  return isDefined(state) && state.status === "withdraw_executed" && !isDefined(state.withdrawLifecyclePublishedAt);
}

/**
 * Announces a settled withdrawal, then records that it was announced.
 *
 * Called from two places with the same meaning, and deliberately the same code in both: by a fresh withdrawal
 * once its terminal state is durable, and by a redelivery that found a `withdraw_executed` carrying no
 * timestamp. The recovery path is the one that cannot be exercised in production, so it is the path the happy
 * path runs every time rather than a second implementation of it.
 *
 * **Publish before stamping.** Stamping first and publishing after would lose the announcement for good on
 * any failure between the two; this order can at worst announce twice, which at-least-once delivery already
 * implies. Nothing here re-executes the withdrawal — the funds have moved, and only the announcement is owed.
 *
 * @returns fields for the outcome line. Not `messageId`: the app spreads delivery identity last, so a handler
 * field of that name would be silently overwritten by the Pub/Sub one.
 */
export async function publishWithdrawExecuted(
  deps: WithdrawLifecycleDeps,
  provider: Provider,
  transferId: string,
  message: DepositAddressMessageV3,
  state: WithdrawExecutedState
): Promise<Record<string, unknown>> {
  const { logger, store, publisher, topic } = deps;

  // The receipt is re-fetched rather than carried over from whoever confirmed the transaction: the payload's
  // `logIndex` comes from scanning `receipt.logs` for the settlement log, so it cannot be rebuilt from the
  // state record, which holds only the hash, chain and block.
  const receipt = await fetchReceipt(provider, state);
  const payload = buildWithdrawExecutedPayload(receipt, message);
  if (!isDefined(payload)) {
    // The withdrawal happened; no redelivery can conjure a settlement log that is not in the receipt. So this
    // acknowledges and leaves `withdraw_executed` **unstamped** — the timestamp means "announced", and
    // recording one here would claim something untrue rather than merely repeat this warning.
    logger.warn({
      at: "DepositAddressService#publishWithdrawExecuted",
      message: "Withdrawal settled but its receipt carries no settlement log; the indexer will not be told.",
      transferId,
      txHash: state.txHash,
      chainId: state.chainId,
      depositAddress: message.depositAddress,
      refundAddress: message.refundAddress.address,
      token: message.erc20Transfer.contractAddress,
    });
    return { withdrawLifecyclePublished: false };
  }

  let lifecycleMessageId: string;
  try {
    lifecycleMessageId = await publisher.publishJson(topic, payload);
  } catch (err) {
    throw new WithdrawPublicationError(
      `failed to publish withdraw_executed for ${transferId} to ${topic}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  await store.recordTerminal(transferId, { ...state, withdrawLifecyclePublishedAt: Date.now() });
  return { withdrawLifecyclePublished: true, lifecycleMessageId };
}

/**
 * A receipt the payload can be built from, or a retriable failure.
 *
 * The record says this transaction confirmed, so a missing receipt now is our provider disagreeing with what
 * we already observed — transient, and a later delivery looks again. A receipt that reads as reverted is not
 * treated separately: it carries no settlement log either, so it falls through to the warn above.
 */
async function fetchReceipt(provider: Provider, state: WithdrawExecutedState): Promise<TransactionReceipt> {
  let receipt: TransactionReceipt;
  try {
    receipt = await provider.getTransactionReceipt(receiptLookupHash(state.txHash));
  } catch (err) {
    throw new TransientDependencyError(
      `failed to fetch receipt for ${state.txHash}: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }

  if (classifyReceipt(receipt) === "unresolved") {
    throw new TransientDependencyError(
      `receipt for ${state.txHash} on chain ${state.chainId} is no longer visible; cannot announce the withdrawal`
    );
  }
  return receipt;
}
