import { AcrossApiHttpError } from "../clients/AcrossApiBaseClient";
import {
  AcrossSwapApiClient,
  DepositAddressExecuteResponse,
  DepositAddressSignWithdrawResponse,
} from "../clients/AcrossSwapApiClient";
import { AugmentedTransaction, TransactionClient } from "../clients/TransactionClient";
import ERC20_ABI from "../common/abi/MinimalERC20.json";
import { DepositAddressMessageV3 } from "../interfaces/DepositAddress";
import { GcpPubSubPublisher } from "../messaging/gcp";
import {
  BigNumber,
  Contract,
  EvmAddress,
  Provider,
  Signer,
  blockExplorerLink,
  delay,
  dispatchTransaction,
  getEthersCompatibleAddress,
  getNetworkName,
  getProvider as getProviderDefault,
  isHttpError,
  isNativeTokenSentinel,
  submitTransaction,
  toAddressType,
  toBN,
  winston,
} from "../utils";
import { isDefined } from "../utils/TypeGuards";
import { DepositAddressServiceConfig } from "./config";
import {
  InsufficientBalanceError,
  LockContentionError,
  NonCanonicalTransferError,
  TransientDependencyError,
  WithdrawalsDisabledError,
} from "./errors";
import {
  assertEvmWithdrawNamespaces,
  assertIntegratorId,
  assertSupportedNamespace,
  assertSupportedOriginChain,
  assertValidExecuteResponse,
  assertValidWithdrawResponse,
  assertWithdrawMaterials,
} from "./guards";
import { HandlerResult, MessageHandler, RequestContext, assertBeforeDeadline } from "./handler";
import { ParsedTransfer, parseTransfer } from "./message";
import { resolvePendingTransaction } from "./pendingTransaction";
import { BroadcastPendingState, TerminalState, TransferLock, TransferStore } from "./transferState";
import { WithdrawLifecycleDeps, awaitsWithdrawPublication, publishWithdrawExecuted } from "./withdrawLifecycle";

/** The API's stable discriminator for an amount under the minimum deposit; a 422 with any other code is not this. */
const AMOUNT_BELOW_MINIMUM_ERROR_CODE = "AMOUNT_BELOW_MINIMUM";

/**
 * Backoff for re-persisting `broadcast_pending` after the hook's write failed. First entry is 0, so the first
 * retry is immediate. ~1.25s total, deliberately small: it is sized for a **blip**, and a Redis that has been
 * unreachable for seconds is an outage, where waiting longer buys almost nothing and the accepted residual
 * applies anyway. The request also still owes the chain a receipt lookup and a terminal write afterwards.
 */
const PENDING_WRITE_BACKOFF_MS = [0, 250, 1_000];

/**
 * Everything the handler closes over. Injected rather than constructed here so tests can supply fakes —
 * `getRedisCache` and `getGcpPubSubPublisher` both answer `undefined` under `RELAYER_TEST`, and `getProvider`
 * would try to build a real provider from env RPC URLs.
 *
 * Constructed **once** per process, not per request: the nonce cache lives on `TransactionClient`, so a
 * per-request client would turn the accepted nonce race into a guaranteed one.
 */
export interface DepositHandlerDeps {
  logger: winston.Logger;
  config: DepositAddressServiceConfig;
  store: TransferStore;
  api: AcrossSwapApiClient;
  transactionClient: TransactionClient;
  baseSigner: Signer;
  signerAddress: EvmAddress;
  /** Non-empty enables `dispatch()`'s signer rotation, matching the polling bot's `depositAddressSigners`. */
  dispatcherSigners: Signer[];
  /**
   * Announces settled withdrawals. Absent when the publisher gate is off — and under `RELAYER_TEST`, which is
   * why it is injected. Deposits are never published: the indexer ingests their on-chain provenance event.
   */
  publisher?: GcpPubSubPublisher;
  /** Defaults to the repo's memoized `getProvider`, so nothing is built per request or at startup. */
  getProvider?: (chainId: number) => Promise<Provider>;
}

/**
 * v3 deposit execution.
 *
 * Lifecycle: read state → acquire lock → **re-read** state → classification → guards → quote → deadline
 * and lock-ownership recheck → broadcast → resolve against the chain → release. The second read is what
 * closes the race between the first read and lock acquisition; the lock is what stops two live consumers
 * both passing the guards, since `broadcast_pending` is only written after a broadcast and so cannot do
 * that job.
 */
export function createDepositHandler(deps: DepositHandlerDeps): MessageHandler {
  return async (context: RequestContext): Promise<HandlerResult> => {
    const parsed = parseTransfer(context.delivery.payload);

    // A cheap short-circuit before taking a lock: a transfer that is already done needs no exclusion. Only
    // terminal states qualify — resolving a pending record may clear it, so that needs the lock.
    //
    // A withdrawal that settled but was never announced is **not** done, however cheap acknowledging it would
    // be: the indexer still has to be told, and this is the only delivery that can do it. So it falls through
    // and takes the lock. Piercing here is half the job — `processUnderLock` re-reads and would acknowledge
    // it there instead.
    const lifecycle = withdrawLifecycleDeps(deps);
    const existing = await deps.store.read(parsed.transferId);
    if (
      isDefined(existing) &&
      existing.status !== "broadcast_pending" &&
      !(isDefined(lifecycle) && awaitsWithdrawPublication(existing))
    ) {
      return { outcome: `already_${existing.status}`, fields: { transferId: parsed.transferId, ...existing } };
    }

    const lock = await deps.store.acquireLock(parsed.transferId);
    if (!isDefined(lock)) {
      throw new LockContentionError(`another consumer holds the lock for ${parsed.transferId}`);
    }

    try {
      return await processUnderLock(deps, context, parsed, lock);
    } finally {
      // Every path releases, including the throwing ones. The TTL exists for a consumer that dies, not for one
      // that merely failed — leaving the lock held would block the transfer for the whole TTL for no reason.
      await lock.release();
    }
  };
}

async function processUnderLock(
  deps: DepositHandlerDeps,
  context: RequestContext,
  parsed: ParsedTransfer,
  lock: TransferLock
): Promise<HandlerResult> {
  const { config, store } = deps;
  const { transferId, message } = parsed;
  const { chainId, transferClassification } = message.erc20Transfer;
  const originChainId = Number(chainId);
  const getProvider = deps.getProvider ?? getProviderDefault;

  const lifecycle = withdrawLifecycleDeps(deps);
  const current = await store.read(transferId);
  if (isDefined(current)) {
    if (current.status !== "broadcast_pending") {
      // The other half of piercing the terminal short-circuit. A withdrawal that settled but was never
      // announced takes the lock — this is where the retry actually happens, and acknowledging here would
      // make the pre-lock pierce pointless.
      //
      // The provider is built from the **record's** chain, which is where the transaction we are looking up
      // is (the same chain the message names, since a refund settles where the funds landed). Built before
      // the chain guards, as the pending branch below is, and for the same reason: a settled withdrawal on a
      // since-disabled chain still owes its announcement.
      if (isDefined(lifecycle) && awaitsWithdrawPublication(current)) {
        const published = await publishWithdrawExecuted(
          lifecycle,
          await getProvider(current.chainId),
          transferId,
          message,
          current
        );
        return { outcome: `already_${current.status}`, fields: { transferId, ...current, ...published } };
      }
      return { outcome: `already_${current.status}`, fields: { transferId, ...current } };
    }
    // A transaction may still land, so never re-execute: resolve the recorded one instead. The chain guards
    // below deliberately do **not** gate this — a transfer on a since-disabled chain still has a transaction
    // on the wire, and abandoning it unresolved is the one unrecoverable direction.
    const deps_ = { logger: deps.logger, store, provider: await getProvider(originChainId) };
    return resolvePendingTransaction(deps_, transferId, current);
  }

  // Both guards run **before** the provider is built. `getProvider` throws a bare `No RPC providers defined`
  // for a chain with no configuration, and the app cannot tell that from a transient fault — so it would
  // alert and redeliver forever, instead of the ACK an unsupported family is supposed to get. Ordering, not
  // logic, is what makes those dispositions reachable.
  assertSupportedOriginChain(config.originChains, originChainId);

  // Switched on the indexer's own classification rather than a deposit/withdraw label decided at parse time:
  // a `correct_transfer` the execute endpoint rejects as below the minimum becomes a refund withdraw too, so
  // the action is not knowable here.
  //
  // Both `mis_route` and `intent_refund` refund. An expired intent refunds to the deposit address itself —
  // the SpokePool depositor of record — so it needs the same second hop out to the committed refund address
  // as a mis_route does. Tested by exclusion rather than by listing them, so a future classification cannot
  // silently fall through to the deposit path.
  //
  // Note `originChainId` is `erc20Transfer.chainId` — where the funds landed — which is the refund chain the
  // withdraw path needs. For a `mis_route` that is *not* the route's origin chain, which is the whole point.
  if (transferClassification !== "correct_transfer") {
    return executeWithdraw(deps, context, parsed, lock, await getProvider(originChainId), originChainId);
  }

  return executeDeposit(deps, context, parsed, lock, await getProvider(originChainId), originChainId);
}

async function executeDeposit(
  deps: DepositHandlerDeps,
  context: RequestContext,
  parsed: ParsedTransfer,
  lock: TransferLock,
  provider: Provider,
  originChainId: number
): Promise<HandlerResult> {
  const { store, logger } = deps;
  const { transferId, message } = parsed;
  const { depositAddress, erc20Transfer } = message;

  // `assertSupportedOriginChain` already ran in `processUnderLock`, before the provider was built.
  assertSupportedNamespace(message, originChainId);
  const integratorId = assertIntegratorId(message);

  // Canonicality **before** balance, deliberately. Both would reject a reorged transfer, but only this one can
  // tell "the funding transfer is real" from "there happens to be money at this address" — a deposit address is
  // a shared pot, so the balance check alone is unsound. Ordering it first also means an RPC node lagging the
  // indexer fails here with a NACK instead of reaching the balance guard, whose short read ACKs and drops.
  await assertCanonicalFundingTransfer(provider, message, originChainId);
  const onchainBalance = await readDepositAddressBalance(
    provider,
    originChainId,
    erc20Transfer.contractAddress,
    depositAddress
  );
  if (onchainBalance.lt(toBN(erc20Transfer.amount))) {
    throw new InsufficientBalanceError(
      `deposit address ${depositAddress} holds ${onchainBalance.toString()} of ${erc20Transfer.contractAddress}, ` +
        `below the transfer amount ${erc20Transfer.amount}`
    );
  }

  const quotedAtMs = Date.now();
  const response = await requestExecuteTx(deps, message, originChainId, integratorId);
  if (response === "below_minimum") {
    // Terminal at the API — the amount is whatever landed on the address, so no retry changes it. The
    // correct handling is a refund withdraw, run under the **same lock**, exactly as the polling bot holds
    // its in-flight lock across `initiateWithdrawV3`. No `refund_only` marker is recorded: a redelivery
    // re-calls `/execute`, gets the same rejection, and falls through here again.
    return executeWithdraw(deps, context, parsed, lock, provider, originChainId);
  }
  assertValidExecuteResponse(response, message, originChainId, Math.floor(Date.now() / 1000));

  // The point of no return. The deadline check is what makes an un-renewed lock safe against a Cloud Run 504,
  // which does not stop handler code; the ownership check covers a lock that lapsed anyway.
  assertBeforeDeadline(context);
  if (!(await lock.isHeld())) {
    throw new LockContentionError(`lock for ${transferId} is no longer held; refusing to broadcast`);
  }

  const destinationChainId = Number(message.routeParams.destinationChainId);
  const pending = await broadcast(deps, context, transferId, originChainId, provider, {
    operation: "deposit",
    to: response.executeTx.to,
    data: response.executeTx.data,
    value: response.executeTx.value,
    message: "Completed Deposit Execution Successfully 🎯",
    mrkdwn:
      `Completed execution of v3 Deposit on ${getNetworkName(originChainId)} to ` +
      `${getNetworkName(destinationChainId)}, using deposit address ` +
      `${blockExplorerLink(message.depositAddress, originChainId)}`,
  });
  const result = await resolvePendingTransaction({ logger, store, provider }, transferId, pending);
  return { outcome: result.outcome, fields: { ...result.fields, quoteMs: Date.now() - quotedAtMs, integratorId } };
}

/**
 * v3 refund withdrawal — the path for a `mis_route` or `intent_refund`, and for a `correct_transfer` the
 * execute endpoint rejected as below the minimum. Both callers already hold the transfer's lock, and it is
 * held across the whole withdraw, so the two actions can never interleave with another consumer.
 *
 * Not the deposit path with a different verb. Withdrawals are **EVM-only** (stricter than the deposit
 * path's chain-native namespaces), they need the message's withdraw leaf materials, and a terminal
 * sign-withdraw rejection is *recorded* as `withdraw_failed` and ACKed rather than retried. The refund is
 * gas-deducted (`deductGasFromRefund: true`) — deliberate, and different from v1's full-amount refund.
 *
 * A settled withdrawal is then announced over Pub/Sub, since it leaves no on-chain provenance event for the
 * indexer to read. See {@link publishWithdrawExecuted}.
 */
async function executeWithdraw(
  deps: DepositHandlerDeps,
  context: RequestContext,
  parsed: ParsedTransfer,
  lock: TransferLock,
  provider: Provider,
  refundChainId: number
): Promise<HandlerResult> {
  const { config, store, logger } = deps;
  const { transferId, message } = parsed;
  const { depositAddress, erc20Transfer } = message;

  if (!config.v3WithdrawalsEnabled) {
    throw new WithdrawalsDisabledError(`refund withdraw for ${transferId} refused: ENABLE_V3_WITHDRAWALS is not set`);
  }

  assertEvmWithdrawNamespaces(message);
  const withdrawLeaf = assertWithdrawMaterials(message);

  // Canonicality before balance, for the deposit path's reason: only this ordering lets the balance guard's
  // ACK mean "the funds genuinely left" rather than "possibly our node is behind". Re-run even when the
  // below-minimum fallback already passed both — the guards are cheap reads, and the polling bot's withdraw
  // path re-checks its balance too.
  await assertCanonicalFundingTransfer(provider, message, refundChainId);
  const onchainBalance = await readDepositAddressBalance(
    provider,
    refundChainId,
    erc20Transfer.contractAddress,
    depositAddress
  );
  if (onchainBalance.lt(toBN(erc20Transfer.amount))) {
    throw new InsufficientBalanceError(
      `deposit address ${depositAddress} holds ${onchainBalance.toString()} of ${erc20Transfer.contractAddress}, ` +
        `below the transfer amount ${erc20Transfer.amount}`
    );
  }

  const quotedAtMs = Date.now();
  let signed: DepositAddressSignWithdrawResponse;
  try {
    signed = await deps.api.signWithdrawDepositAddressV3({
      chainId: refundChainId,
      depositAddress,
      initialRoot: message.initialRoot,
      salt: message.salt,
      token: erc20Transfer.contractAddress,
      amount: erc20Transfer.amount,
      user: message.refundAddress.address,
      proof: withdrawLeaf.merkleProof,
      counterfactualDepositFactory: message.counterfactualFactoryContractAddress,
      counterfactualBeacon: message.counterfactualBeaconContractAddress,
      adminWithdrawManager: message.adminWithdrawManagerContractAddress,
      withdrawImplementation: withdrawLeaf.implementationAddress,
      // Deliberate, and different from v1: the v3 refund is net of execution gas, and the response reports
      // requestedAmount / appliedGasFee / netAmount. Do not unify with v1's full-amount refund.
      deductGasFromRefund: true,
    });
  } catch (err) {
    // Terminal per product decision — gas exceeds the refund, or the refund token is unpriceable — and
    // classified on the HTTP status alone, exactly as the polling bot does. The client posts through
    // `_postOrThrow`, which discards the API's error code, so none is recorded.
    if (isHttpError(err) && err.status === 422) {
      const failed: TerminalState = { status: "withdraw_failed", reason: err.message, recordedAtMs: Date.now() };
      await store.recordTerminal(transferId, failed);
      return { outcome: "withdraw_failed", fields: { transferId, chainId: refundChainId, reason: err.message } };
    }
    throw new TransientDependencyError(
      `sign-withdraw request failed for ${depositAddress} on chain ${refundChainId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err
    );
  }
  assertValidWithdrawResponse(signed, refundChainId, Math.floor(Date.now() / 1000));

  // The point of no return, same as the deposit path: deadline first, then lock ownership.
  assertBeforeDeadline(context);
  if (!(await lock.isHeld())) {
    throw new LockContentionError(`lock for ${transferId} is no longer held; refusing to broadcast`);
  }

  const pending = await broadcast(deps, context, transferId, refundChainId, provider, {
    operation: "withdraw",
    to: signed.signedWithdrawTx.to,
    data: signed.signedWithdrawTx.data,
    value: signed.signedWithdrawTx.value,
    message: "Completed Refund Withdraw 💸",
    mrkdwn:
      `v3 refund withdraw on ${getNetworkName(refundChainId)} for deposit address ` +
      `${blockExplorerLink(depositAddress, refundChainId)} (requestedAmount: ${signed.requestedAmount}, ` +
      `appliedGasFee: ${signed.appliedGasFee}, netAmount: ${signed.netAmount}, ` +
      `bundledDeploy: ${signed.bundledDeploy})`,
  });
  const result = await resolvePendingTransaction({ logger, store, provider }, transferId, pending);

  // Announced from what Redis durably holds, not from what this request believes it just did — so a
  // withdrawal is never announced unless its terminal state landed, and this path is the same code a
  // redelivery runs to finish an announcement that failed. A publish failure throws, leaving
  // `withdraw_executed` in place for that redelivery to retry; nothing here re-signs or re-broadcasts.
  const lifecycle = withdrawLifecycleDeps(deps);
  const recorded = await store.read(transferId);
  const published =
    isDefined(lifecycle) && awaitsWithdrawPublication(recorded)
      ? await publishWithdrawExecuted(lifecycle, provider, transferId, message, recorded)
      : {};

  return {
    outcome: result.outcome,
    fields: {
      ...result.fields,
      ...published,
      quoteMs: Date.now() - quotedAtMs,
      requestedAmount: signed.requestedAmount,
      appliedGasFee: signed.appliedGasFee,
      netAmount: signed.netAmount,
    },
  };
}

/** The publication dependencies, or `undefined` when the publisher gate is off and nothing is announced. */
function withdrawLifecycleDeps(deps: DepositHandlerDeps): WithdrawLifecycleDeps | undefined {
  const { logger, store, config, publisher } = deps;
  return isDefined(publisher) ? { logger, store, publisher, topic: config.pubSubWithdrawTopic } : undefined;
}

/** Raw calldata for one broadcast, plus the Slack-facing lines the shared client logs on success. */
interface BroadcastRequest {
  operation: BroadcastPendingState["operation"];
  to: string;
  data: string;
  value: string;
  message: string;
  mrkdwn: string;
}

/**
 * Broadcasts a transaction and returns the `broadcast_pending` record that was persisted for it. Shared by
 * the execute and refund-withdraw paths — the record-keeping is identical, only the calldata and the
 * `operation` it records differ.
 *
 * `sendAndConfirmTransaction` is deliberately not used: it submits *and* confirms in one call and returns
 * `undefined` with no hash on every failure path, so the earliest a caller could see a hash is *after* the wait
 * that `broadcast_pending` exists to survive. The `onBroadcast` hook is the seam instead — it fires before the
 * confirmation wait, and again on every hash change, so the record always names the live transaction rather
 * than one the client replaced at the same nonce.
 *
 * `maxTries` bounds that wait. The default 10 is `M(M+1)/2` = 55 waits, ~22 minutes on mainnet, which would
 * outlive both the deadline and the lock.
 */
async function broadcast(
  deps: DepositHandlerDeps,
  context: RequestContext,
  transferId: string,
  chainId: number,
  provider: Provider,
  request: BroadcastRequest
): Promise<BroadcastPendingState> {
  const { store, transactionClient, config, logger } = deps;
  const useDispatcher = deps.dispatcherSigners.length > 0;

  // Assigned **before** the Redis write, not after. The hook's rejection is swallowed by
  // `TransactionClient`, so a write failure that also lost the hash would leave a confirmed transaction with
  // no record anywhere and a redelivery free to sweep again — the failure this service exists to close.
  // Holding the hash means the confirmed path still reaches `recordTerminal`, which supersedes this record.
  let pending: BroadcastPendingState | undefined;
  // The hash Redis is known to hold. Tracked rather than a boolean so a **stale** record (an earlier hash
  // landed, the current one did not) is distinguishable from an absent one — they fail differently, and only
  // the stale variant makes the terminal write unacceptable to `canReplace`.
  let recordedTxHash: string | undefined;
  const txn: AugmentedTransaction = {
    contract: executeContract(deps.baseSigner, provider, request.to, chainId, useDispatcher),
    method: "",
    args: [request.data],
    value: toBN(request.value),
    chainId,
    ensureConfirmation: true,
    maxTries: config.confirmationTries,
    message: request.message,
    mrkdwn: request.mrkdwn,
    onBroadcast: async (tx) => {
      // Re-entered on every hash change, so the record always names the transaction `TransactionClient` is
      // currently tracking rather than one it replaced. `persisted` resets per entry: a hash that persisted
      // does not vouch for the replacement that followed it.
      pending = {
        status: "broadcast_pending",
        operation: request.operation,
        txHash: tx.hash,
        chainId,
        submittedAtMs: Date.now(),
      };
      await store.recordBroadcast(transferId, pending);
      recordedTxHash = tx.hash;
    },
  };

  try {
    await (useDispatcher ? dispatchTransaction(txn, transactionClient) : submitTransaction(txn, transactionClient));
  } catch (err) {
    // Revert, exhausted resubmission and RPC failure all arrive here as one untyped Error: `submit()` catches
    // `_submit`'s throw and returns an empty array, which `submitTransaction` turns into a generic message. So
    // there is nothing to classify — if a hash exists the chain is asked, and if not, nothing was broadcast.
    if (!isDefined(pending)) {
      throw new TransientDependencyError(
        `${request.operation} submission for ${transferId} failed before any transaction was broadcast: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err
      );
    }
    logger.debug({
      at: "DepositAddressService#broadcast",
      message: "Execute submission threw with a transaction already on the wire; resolving against the chain.",
      transferId,
      txHash: pending.txHash,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!isDefined(pending)) {
    // A hash-less success should be impossible — `submitTransaction` throws on an empty response — but the
    // record is what makes a broadcast recoverable, so treat its absence as "did not happen" rather than assume.
    throw new TransientDependencyError(`${request.operation} for ${transferId} produced no transaction hash`);
  }

  if (recordedTxHash !== pending.txHash) {
    await persistPendingWithRetry(deps, context, transferId, pending, recordedTxHash);
  }
  return pending;
}

/**
 * Retries the `broadcast_pending` write the hook could not land, here where the failure is not swallowed.
 *
 * **Best-effort by design.** Throwing would skip `recordTerminal`, which supersedes this record entirely — so
 * a failure here must never stop a confirmed transaction from being recorded. That is the whole point of
 * holding the hash rather than the write result.
 *
 * The retries exist for a sharper case than a merely absent record. If an *earlier* hash landed and the
 * current one did not — `TransactionClient` repriced or resubmitted, and that write failed — Redis names a
 * transaction that will never mine while `pending` names the live one. `canReplace` then refuses the terminal
 * write, because it requires the terminal hash to match the pending record, and every later delivery resolves
 * the dead hash instead. A few seconds of backoff turns that from "one failed write" into "Redis unavailable
 * across a replacement", which is the difference between plausible and unlikely.
 *
 * It is a probability reduction, not a proof: see the issue's Scope. Bounded by the request deadline so it
 * cannot eat the budget the resolution that follows it needs.
 */
async function persistPendingWithRetry(
  deps: DepositHandlerDeps,
  context: RequestContext,
  transferId: string,
  pending: BroadcastPendingState,
  recordedTxHash: string | undefined
): Promise<void> {
  const { store, logger } = deps;
  let lastError: unknown;

  for (const backoffMs of PENDING_WRITE_BACKOFF_MS) {
    // Never sleep past the deadline: the receipt lookup and terminal write still have to happen.
    if (backoffMs > 0 && Date.now() + backoffMs >= context.deadlineAtMs) {
      break;
    }
    if (backoffMs > 0) {
      await delay(backoffMs / 1000);
    }

    try {
      await store.recordBroadcast(transferId, pending);
      return;
    } catch (err) {
      lastError = err;
    }
  }

  logger.warn({
    at: "DepositAddressService#broadcast",
    message: isDefined(recordedTxHash)
      ? "broadcast_pending still names a replaced transaction; the terminal write will be refused."
      : "Could not persist broadcast_pending; resolving against the chain regardless.",
    transferId,
    txHash: pending.txHash,
    recordedTxHash,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
}

/**
 * The funding transfer must still be canonical at the block the message names.
 *
 * Three outcomes, not two. A receipt at a different block is unambiguously non-canonical and deterministic, so
 * it ACKs. An **absent** receipt cannot be told apart from our RPC lagging the indexer, and re-reading a
 * receipt is harmless — unlike re-reading a shared-pot balance, where a later read may be an unrelated
 * transfer's money — so it is treated as transient and retried.
 */
async function assertCanonicalFundingTransfer(
  provider: Provider,
  message: DepositAddressMessageV3,
  originChainId: number
): Promise<void> {
  const { transactionHash, blockNumber } = message.erc20Transfer;
  const lookupHash = transactionHash.startsWith("0x") ? transactionHash : `0x${transactionHash}`;

  let receipt: Awaited<ReturnType<Provider["getTransactionReceipt"]>>;
  try {
    receipt = await provider.getTransactionReceipt(lookupHash);
  } catch (err) {
    throw new TransientDependencyError(
      `failed to fetch funding receipt ${transactionHash} on chain ${originChainId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err
    );
  }

  if (!isDefined(receipt) || !isDefined(receipt.blockNumber)) {
    throw new TransientDependencyError(
      `funding transaction ${transactionHash} on chain ${originChainId} is not yet visible to our provider`
    );
  }
  if (receipt.blockNumber !== blockNumber) {
    throw new NonCanonicalTransferError(
      `funding transaction ${transactionHash} is mined at block ${receipt.blockNumber}, not ${blockNumber}`
    );
  }
}

/**
 * The deposit address's balance of `token`.
 *
 * Native transfers are indexed with the sentinel address, which has no contract, so `balanceOf` would revert —
 * read those with `getBalance`. Tron providers speak eth-JSON-RPC, so base58 inputs are converted first; hex
 * passes through unchanged.
 */
async function readDepositAddressBalance(
  provider: Provider,
  chainId: number,
  token: string,
  depositAddress: string
): Promise<BigNumber> {
  const depositAddressHex = getEthersCompatibleAddress(chainId, depositAddress);
  try {
    if (isNativeTokenSentinel(token)) {
      return await provider.getBalance(depositAddressHex);
    }
    const erc20 = new Contract(getEthersCompatibleAddress(chainId, token), ERC20_ABI, provider);
    return await erc20.balanceOf(depositAddressHex);
  } catch (err) {
    // Unlike the polling bot, which logs and skips, an unreadable balance is not evidence of anything: NACK.
    throw new TransientDependencyError(
      `failed to read balance of ${token} for ${depositAddress} on chain ${chainId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err
    );
  }
}

/**
 * Asks the execute endpoint for calldata.
 *
 * The API re-derives the deposit address and merkle materials from this identity; the bot relays funding
 * context plus the `integratorId` the address was derived with, and does not build calldata itself.
 * `executionFee` is omitted, so the API defaults it to 0.
 *
 * `erc20Transfer` is **always** sent. The service relies on the resulting on-chain provenance event — it never
 * publishes `deposit_executed` itself, the indexer ingests the event — so this is a service requirement, not
 * the optional flag it is in the polling bot. An API without the schema change would reject the whole request.
 *
 * Answers `"below_minimum"` rather than throwing for an `AMOUNT_BELOW_MINIMUM` rejection: that outcome is not
 * a failure to propagate but the signal to fall through to the refund withdraw, under the lock the caller
 * already holds. Matched on the error **code**, not the bare 422 — `executeDepositAddress` posts through
 * `_postOrThrowWithErrorCode` precisely so several 422s stay distinguishable.
 */
async function requestExecuteTx(
  deps: DepositHandlerDeps,
  message: DepositAddressMessageV3,
  originChainId: number,
  integratorId: string
): Promise<DepositAddressExecuteResponse | "below_minimum"> {
  const { routeParams, refundAddress, erc20Transfer, depositAddress } = message;

  try {
    return await deps.api.executeDepositAddress({
      destination: {
        token: { chainId: Number(routeParams.destinationChainId), address: routeParams.outputToken },
        recipient: routeParams.recipient.address,
      },
      originChainId,
      // Origin fields are relayed verbatim from the indexer, which serves origin-chain-native encodings
      // (base58 on Tron) — exactly what the endpoint expects.
      depositAddress,
      inputToken: { chainId: originChainId, address: erc20Transfer.contractAddress },
      userAddress: refundAddress.address,
      amount: erc20Transfer.amount,
      // The Tron account is the same key re-encoded (TVM submission reuses the EVM private key), so
      // re-encoding per origin chain keeps the fee recipient the service itself on every family.
      executionFeeRecipient: toAddressType(deps.signerAddress.toNative(), originChainId).toNative(),
      integratorId,
      erc20Transfer: {
        chainId: originChainId,
        blockNumber: erc20Transfer.blockNumber,
        transactionHash: erc20Transfer.transactionHash,
        logIndex: erc20Transfer.logIndex,
      },
    });
  } catch (err) {
    if (err instanceof AcrossApiHttpError && err.code === AMOUNT_BELOW_MINIMUM_ERROR_CODE) {
      return "below_minimum";
    }
    throw new TransientDependencyError(
      `execute request failed for ${depositAddress} on chain ${originChainId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err
    );
  }
}

/**
 * The contract to send raw calldata to.
 *
 * The API returns a 0x-hex `to` on both ecosystems today; convert defensively in case a TVM response ever
 * carries base58. The dispatcher case connects the provider only — simulation and TVM submission read
 * `contract.provider`, while `dispatch()` attaches its own rotated signer at submission time.
 */
function executeContract(
  baseSigner: Signer,
  provider: Provider,
  to: string,
  chainId: number,
  useDispatcher: boolean
): Contract {
  const contract = new Contract(getEthersCompatibleAddress(chainId, to), []);
  return useDispatcher ? contract.connect(provider) : contract.connect(baseSigner.connect(provider));
}
