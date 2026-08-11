import { AcrossApiHttpError } from "../clients/AcrossApiBaseClient";
import { AcrossSwapApiClient, DepositAddressExecuteResponse } from "../clients/AcrossSwapApiClient";
import { AugmentedTransaction, TransactionClient } from "../clients/TransactionClient";
import ERC20_ABI from "../common/abi/MinimalERC20.json";
import { DepositAddressMessageV3 } from "../interfaces/DepositAddress";
import {
  BigNumber,
  Contract,
  EvmAddress,
  Provider,
  Signer,
  blockExplorerLink,
  dispatchTransaction,
  getEthersCompatibleAddress,
  getNetworkName,
  getProvider as getProviderDefault,
  isNativeTokenSentinel,
  submitTransaction,
  toAddressType,
  toBN,
  winston,
} from "../utils";
import { isDefined } from "../utils/TypeGuards";
import { DepositAddressServiceConfig } from "./config";
import {
  BelowMinimumDepositError,
  InsufficientBalanceError,
  LockContentionError,
  NonCanonicalTransferError,
  TransientDependencyError,
  WithdrawRouteNotImplementedError,
} from "./errors";
import {
  assertIntegratorId,
  assertSupportedNamespace,
  assertSupportedOriginChain,
  assertValidExecuteResponse,
} from "./guards";
import { HandlerResult, MessageHandler, RequestContext, assertBeforeDeadline } from "./handler";
import { ParsedTransfer, parseTransfer } from "./message";
import { resolvePendingTransaction } from "./pendingTransaction";
import { BroadcastPendingState, TransferLock, TransferStore } from "./transferState";

/** The API's stable discriminator for an amount under the minimum deposit; a 422 with any other code is not this. */
const AMOUNT_BELOW_MINIMUM_ERROR_CODE = "AMOUNT_BELOW_MINIMUM";

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
    const existing = await deps.store.read(parsed.transferId);
    if (isDefined(existing) && existing.status !== "broadcast_pending") {
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

  const current = await store.read(transferId);
  if (isDefined(current)) {
    if (current.status !== "broadcast_pending") {
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
  // the action is not knowable here. `intent_refund` was already rejected by `parseTransfer`.
  if (transferClassification === "mis_route") {
    throw new WithdrawRouteNotImplementedError(
      `transfer ${transferId} is a ${transferClassification} and needs a refund withdraw, which is not ` +
        "implemented in this build"
    );
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
  assertValidExecuteResponse(response, message, originChainId, Math.floor(Date.now() / 1000));

  // The point of no return. The deadline check is what makes an un-renewed lock safe against a Cloud Run 504,
  // which does not stop handler code; the ownership check covers a lock that lapsed anyway.
  assertBeforeDeadline(context);
  if (!(await lock.isHeld())) {
    throw new LockContentionError(`lock for ${transferId} is no longer held; refusing to broadcast`);
  }

  const pending = await broadcast(deps, parsed, response, originChainId, provider);
  const result = await resolvePendingTransaction({ logger, store, provider }, transferId, pending);
  return { outcome: result.outcome, fields: { ...result.fields, quoteMs: Date.now() - quotedAtMs, integratorId } };
}

/**
 * Broadcasts the execute and returns the `broadcast_pending` record that was persisted for it.
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
  parsed: ParsedTransfer,
  response: DepositAddressExecuteResponse,
  originChainId: number,
  provider: Provider
): Promise<BroadcastPendingState> {
  const { store, transactionClient, config, logger } = deps;
  const { transferId, message } = parsed;
  const { executeTx } = response;
  const useDispatcher = deps.dispatcherSigners.length > 0;
  const destinationChainId = Number(message.routeParams.destinationChainId);

  // Assigned **before** the Redis write, not after. The hook's rejection is swallowed by
  // `TransactionClient`, so a write failure that also lost the hash would leave a confirmed transaction with
  // no record anywhere and a redelivery free to sweep again — the failure this service exists to close.
  // Holding the hash means the confirmed path still reaches `recordTerminal`, which supersedes this record.
  let pending: BroadcastPendingState | undefined;
  let persisted = false;
  const txn: AugmentedTransaction = {
    contract: executeContract(deps.baseSigner, provider, executeTx.to, originChainId, useDispatcher),
    method: "",
    args: [executeTx.data],
    value: toBN(executeTx.value),
    chainId: originChainId,
    ensureConfirmation: true,
    maxTries: config.confirmationTries,
    message: "Completed Deposit Execution Successfully 🎯",
    mrkdwn:
      `Completed execution of v3 Deposit on ${getNetworkName(originChainId)} to ` +
      `${getNetworkName(destinationChainId)}, using deposit address ` +
      `${blockExplorerLink(message.depositAddress, originChainId)}`,
    onBroadcast: async (tx) => {
      // Re-entered on every hash change, so the record always names the transaction `TransactionClient` is
      // currently tracking rather than one it replaced. `persisted` resets per entry: a hash that persisted
      // does not vouch for the replacement that followed it.
      pending = {
        status: "broadcast_pending",
        operation: "deposit",
        txHash: tx.hash,
        chainId: originChainId,
        submittedAtMs: Date.now(),
      };
      persisted = false;
      await store.recordBroadcast(transferId, pending);
      persisted = true;
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
        `execute submission for ${transferId} failed before any transaction was broadcast: ${
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
    throw new TransientDependencyError(`execute for ${transferId} produced no transaction hash`);
  }

  if (!persisted) {
    // The hook's write failed and `TransactionClient` swallowed it. Retry here, where it is not swallowed —
    // but **best-effort**: a failure must not stop us reaching `recordTerminal`, which supersedes this record
    // entirely. Throwing here when the transaction has already confirmed would leave it unrecorded, which is
    // the very outcome this retry exists to avoid. A persistent Redis outage surfaces from the terminal write.
    try {
      await store.recordBroadcast(transferId, pending);
    } catch (err) {
      logger.warn({
        at: "DepositAddressService#broadcast",
        message: "Could not persist broadcast_pending; resolving against the chain regardless.",
        transferId,
        txHash: pending.txHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return pending;
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
 */
async function requestExecuteTx(
  deps: DepositHandlerDeps,
  message: DepositAddressMessageV3,
  originChainId: number,
  integratorId: string
): Promise<DepositAddressExecuteResponse> {
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
    // Terminal at the API: the amount is whatever landed on the address, so no retry changes it. The correct
    // handling is a refund withdraw, which is not implemented yet, so NACK to preserve the transfer.
    if (err instanceof AcrossApiHttpError && err.code === AMOUNT_BELOW_MINIMUM_ERROR_CODE) {
      throw new BelowMinimumDepositError(
        `execute rejected amount ${erc20Transfer.amount} as below the minimum deposit: ${err.message}`
      );
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
