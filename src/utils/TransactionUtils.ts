import { gasPriceOracle, typeguards, utils as sdkUtils } from "@across-protocol/sdk";
import dotenv from "dotenv";
import { AugmentedTransaction, TransactionClient } from "../clients";
import {
  BigNumber,
  Contract,
  isDefined,
  TransactionResponse,
  TransactionReceipt,
  ethers,
  getContractInfoFromAddress,
  Signer,
  SolanaTransaction,
  toBNWei,
  SVMProvider,
  parseUnits,
  ZERO_ADDRESS,
} from "../utils";
import {
  getBase64EncodedWireTransaction,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type MicroLamports,
} from "@solana/kit";
import { updateOrAppendSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";

dotenv.config();

export type TransactionSimulationResult = {
  transaction: AugmentedTransaction;
  succeed: boolean;
  reason?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
};

export type Multicall2Call = {
  callData: ethers.utils.BytesLike;
  target: string;
};

export function getMultisender(chainId: number, baseSigner: Signer): Contract | undefined {
  return sdkUtils.getMulticall3(chainId, baseSigner);
}

// Solana blockhashes expire after ~60s; refresh per tx.
type SolanaUnsignedTransaction = Omit<SolanaTransaction, "lifetimeConstraint">;
export async function withFreshBlockhash<T extends SolanaUnsignedTransaction>(provider: SVMProvider, tx: T) {
  const { value: blockhash } = await provider.getLatestBlockhash().send();
  return setTransactionMessageLifetimeUsingBlockhash(blockhash, tx);
}

// Options for the SVM submit path. `minContextSlot` pins the receiving RPC's
// preflight simulation to a slot >= the value supplied, so that a node which
// hasn't yet ingested a prior dependency tx returns the explicit
// `MinContextSlotNotReached` error (which the SDK's retry layer recovers
// transparently) instead of running preflight against stale state. See
// https://solana.com/docs/rpc/http/sendtransaction.
export type SolanaSendOptions = { minContextSlot?: bigint };

export async function signAndSendTransaction(
  provider: SVMProvider,
  _unsignedTxn: SolanaUnsignedTransaction,
  opts: SolanaSendOptions = {}
) {
  const priorityFeeOverride = process.env["SVM_PRIORITY_FEE_OVERRIDE"];
  const unsignedTxn = isDefined(priorityFeeOverride)
    ? updateOrAppendSetComputeUnitPriceInstruction(BigInt(priorityFeeOverride) as MicroLamports, _unsignedTxn)
    : _unsignedTxn;
  const txWithFreshBlockhash = await withFreshBlockhash(provider, unsignedTxn);
  const signedTransaction = await signTransactionMessageWithSigners(txWithFreshBlockhash);
  const serializedTx = getBase64EncodedWireTransaction(signedTransaction);
  return provider
    .sendTransaction(serializedTx, {
      preflightCommitment: "confirmed",
      skipPreflight: false,
      encoding: "base64",
      ...(isDefined(opts.minContextSlot) ? { minContextSlot: opts.minContextSlot } : {}),
    })
    .send();
}

// Internal helper: send + poll. Returns the signature and (when reached) the
// slot at which confirmation was observed so callers can chain
// `minContextSlot` into subsequent dependent sends.
async function _sendAndPoll(
  unsignedTransaction: SolanaUnsignedTransaction,
  provider: SVMProvider,
  cycles: number,
  pollingDelay: number,
  opts: SolanaSendOptions
): Promise<{ signature: string; confirmedSlot: bigint | undefined }> {
  const delay = (ms: number) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
  };
  const txSignature = await signAndSendTransaction(provider, unsignedTransaction, opts);
  let confirmed = false;
  let confirmedSlot: bigint | undefined;
  let _cycles = 0;
  while (!confirmed && _cycles < cycles) {
    const txStatus = await provider.getSignatureStatuses([txSignature]).send();
    // Index 0 since we are only sending a single transaction in this method.
    const entry = txStatus?.value?.[0];
    confirmed = entry?.confirmationStatus === "confirmed" || entry?.confirmationStatus === "finalized";
    if (confirmed && isDefined(entry?.slot)) {
      confirmedSlot = entry.slot;
    }
    // If the transaction wasn't confirmed, wait `pollingInterval` and retry.
    if (!confirmed) {
      await delay(pollingDelay);
      _cycles++;
    }
  }
  return { signature: txSignature, confirmedSlot };
}

export async function sendAndConfirmSolanaTransaction(
  unsignedTransaction: SolanaUnsignedTransaction,
  provider: SVMProvider,
  cycles = 25,
  pollingDelay = 600, // 1.5 slots on Solana.
  opts: SolanaSendOptions = {}
): Promise<string> {
  const { signature } = await _sendAndPoll(unsignedTransaction, provider, cycles, pollingDelay, opts);
  return signature;
}

// Variant of `sendAndConfirmSolanaTransaction` that additionally returns the
// slot at which the tx was confirmed (extracted from `getSignatureStatuses`).
// Use this when the next send depends on this tx's on-chain effects, then
// pass `confirmedSlot` as `opts.minContextSlot` to the dependent send so an
// RPC that hasn't yet ingested this tx fails with `MinContextSlotNotReached`
// (which the SDK's `RetrySolanaRpcFactory` retries) instead of running
// preflight against stale state.
export async function sendAndConfirmSolanaTransactionWithSlot(
  unsignedTransaction: SolanaUnsignedTransaction,
  provider: SVMProvider,
  cycles = 25,
  pollingDelay = 600,
  opts: SolanaSendOptions = {}
): Promise<{ signature: string; confirmedSlot: bigint | undefined }> {
  return _sendAndPoll(unsignedTransaction, provider, cycles, pollingDelay, opts);
}

export async function simulateSolanaTransaction(unsignedTransaction: SolanaUnsignedTransaction, provider: SVMProvider) {
  const txWithFreshBlockhash = await withFreshBlockhash(provider, unsignedTransaction);
  const signedTx = await signTransactionMessageWithSigners(txWithFreshBlockhash);
  const serializedTx = getBase64EncodedWireTransaction(signedTx);
  return provider.simulateTransaction(serializedTx, { sigVerify: false, encoding: "base64" }).send();
}

export async function getGasPrice(
  provider: ethers.providers.Provider,
  priorityScaler = 1.2,
  maxFeePerGasScaler = 3,
  transactionObject?: ethers.PopulatedTransaction
): Promise<{ maxFeePerGas: BigNumber; maxPriorityFeePerGas: BigNumber }> {
  const { chainId } = await provider.getNetwork();

  const maxFee = process.env[`MAX_FEE_PER_GAS_OVERRIDE_${chainId}`];
  const priorityFee = process.env[`MAX_PRIORITY_FEE_PER_GAS_OVERRIDE_${chainId}`];
  if (isDefined(maxFee) && isDefined(priorityFee)) {
    return {
      maxFeePerGas: parseUnits(maxFee, 9),
      maxPriorityFeePerGas: parseUnits(priorityFee, 9),
    };
  }

  const rawFeeHistoryConfig = process.env[`FEE_HISTORY_OPTIONS_${chainId}`] ?? process.env["FEE_HISTORY_OPTIONS"];
  const feeHistoryOptions = isDefined(rawFeeHistoryConfig) ? JSON.parse(rawFeeHistoryConfig) : undefined;

  // Floor scalers at 1.0 as we'll rarely want to submit too low of a gas price. We mostly
  // just want to submit with as close to prevailing fees as possible.
  maxFeePerGasScaler = Math.max(1, maxFeePerGasScaler);
  priorityScaler = Math.max(1, priorityScaler);

  // Linea gas price estimation requires transaction simulation so supply the unsigned transaction.
  const feeData = await gasPriceOracle.getGasPriceEstimate(provider, {
    chainId,
    baseFeeMultiplier: toBNWei(maxFeePerGasScaler),
    priorityFeeMultiplier: toBNWei(priorityScaler),
    unsignedTx: transactionObject,
    feeHistoryOptions,
  });

  // Default to EIP-1559 (type 2) pricing. If gasPriceOracle is using a legacy adapter for this chain then
  // the priority fee will be 0.
  return {
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  };
}

export async function willSucceed(transaction: AugmentedTransaction): Promise<TransactionSimulationResult> {
  // If the transaction already has a gasLimit, it should have been simulated in advance.
  if (transaction.canFailInSimulation || isDefined(transaction.gasLimit)) {
    return { transaction, succeed: true };
  }

  const { contract, method } = transaction;
  const rawTxn = method === "";

  // First callStatic, which will surface a custom error if the transaction would fail.
  // This is useful for surfacing custom error revert reasons like RelayFilled in the SpokePool but
  // it does incur an extra RPC call. We do this because estimateGas is a provider function that doesn't
  // relay custom errors well: https://github.com/ethers-io/ethers.js/discussions/3291#discussion-4314795
  let data;
  try {
    if (rawTxn) {
      const from = (await contract.signer?.getAddress()) ?? ZERO_ADDRESS;
      data = await contract.provider.call({ ...transaction, to: contract.address, data: transaction.args[0], from });
    } else {
      const args = transaction.value ? [...transaction.args, { value: transaction.value }] : transaction.args;
      data = await contract.callStatic[method](...args);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (err.errorName) {
      return {
        transaction,
        succeed: false,
        reason: err.errorName,
      };
    }
  }

  try {
    const from = (await contract.signer?.getAddress()) ?? ZERO_ADDRESS;
    const input = rawTxn ? transaction.args[0] : (await contract.populateTransaction[method](...transaction.args)).data;
    const gasLimit = await contract.provider.estimateGas({
      ...transaction,
      to: contract.address,
      data: input,
      from,
    });
    return { transaction: { ...transaction, gasLimit }, succeed: true, data };
  } catch (error) {
    const reason = typeguards.isEthersError(error) ? error.reason : "unknown error";
    return { transaction, succeed: false, reason };
  }
}

export function getTarget(targetAddress: string):
  | {
      chainId: number;
      contractName: string;
      targetAddress: string;
    }
  | {
      targetAddress: string;
    } {
  try {
    return { targetAddress, ...getContractInfoFromAddress(targetAddress) };
  } catch {
    return { targetAddress };
  }
}

// Thrown by submitTransaction / dispatchTransaction when the pre-flight simulation fails.
// Distinguished from on-chain submission failure so callers (notably the gasless relayer's
// stuck-queue reporting) can branch on cause without resorting to error-message matching.
export class TransactionSimulationFailedError extends Error {
  readonly kind = "simulation_failed" as const;
  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "TransactionSimulationFailedError";
  }
}

// Thrown when simulation passed but the underlying TransactionClient could not place the
// transaction on-chain (e.g. replacement-underpriced / nonce-collision retries exhausted).
export class TransactionSubmissionFailedError extends Error {
  readonly kind = "submission_failed" as const;
  constructor(message: string) {
    super(message);
    this.name = "TransactionSubmissionFailedError";
  }
}

// Discriminated outcome surfaced by sendAndConfirmTransaction. Callers switch on `status`;
// adding/removing a variant intentionally breaks every consumer's exhaustive switch.
export type TransactionOutcome =
  | { status: "confirmed"; receipt: TransactionReceipt }
  | { status: "skipped" }
  | { status: "simulation_failed"; reason: string }
  | { status: "submission_failed"; error: TransactionSubmissionFailedError };

export async function submitTransaction(
  transaction: AugmentedTransaction,
  transactionClient: TransactionClient
): Promise<TransactionResponse> {
  const { reason, succeed, transaction: txnRequest } = (await transactionClient.simulate([transaction]))[0];
  const { contract: targetContract, method, ...txnRequestData } = txnRequest;
  if (!succeed) {
    const message = `Failed to simulate ${targetContract.address}.${method}(${txnRequestData.args.join(", ")}) on ${
      txnRequest.chainId
    }`;
    throw new TransactionSimulationFailedError(reason ?? "unknown", `${message} (${reason})`);
  }

  const response = await transactionClient.submit(transaction.chainId, [transaction]);
  if (response.length === 0) {
    throw new TransactionSubmissionFailedError(
      `Transaction succeeded simulation but failed to submit onchain to ${
        targetContract.address
      }.${method}(${txnRequestData.args.join(", ")}) on ${txnRequest.chainId}`
    );
  }
  return response[0];
}

export async function dispatchTransaction(
  transaction: AugmentedTransaction,
  dispatcher: TransactionClient
): Promise<TransactionResponse> {
  const { reason, succeed, transaction: txnRequest } = (await dispatcher.simulate([transaction]))[0];
  const { contract: targetContract, method, ...txnRequestData } = txnRequest;
  if (!succeed) {
    const message = `Failed to simulate ${targetContract.address}.${method}(${txnRequestData.args.join(", ")}) on ${
      txnRequest.chainId
    }`;
    throw new TransactionSimulationFailedError(reason ?? "unknown", `${message} (${reason})`);
  }

  // `dispatcher.dispatch()` returns `(await submit(...))[0]`; when `submit()` exhausts its retries
  // after simulation passed it returns an empty array, so we get `undefined` here. Surface that as
  // a typed submission failure so the gasless stuck-queue counter increments instead of treating
  // it as a benign skip.
  const response = await dispatcher.dispatch(transaction, transaction.contract, transaction.contract.provider);
  if (!response) {
    throw new TransactionSubmissionFailedError(
      `Transaction succeeded simulation but dispatcher failed to submit onchain to ${
        targetContract.address
      }.${method}(${txnRequestData.args.join(", ")}) on ${txnRequest.chainId}`
    );
  }
  return response;
}

/**
 * Submits a transaction (via submitTransaction or dispatchTransaction), awaits the receipt, and
 * returns a tagged outcome. Simulation failures, on-chain submission failures, and skipped
 * sends are distinguished by `status` so callers can branch with type-checked exhaustiveness.
 * Unexpected errors (anything not modelled by the typed error classes above) are re-thrown.
 */
export async function sendAndConfirmTransaction(
  tx: AugmentedTransaction,
  transactionClient: TransactionClient,
  useDispatcher = false
): Promise<TransactionOutcome> {
  const txWithConfirmation: AugmentedTransaction = { ...tx, ensureConfirmation: true };
  let txResponse: TransactionResponse;
  try {
    txResponse = useDispatcher
      ? await dispatchTransaction(txWithConfirmation, transactionClient)
      : await submitTransaction(txWithConfirmation, transactionClient);
  } catch (err) {
    if (err instanceof TransactionSimulationFailedError) {
      return { status: "simulation_failed", reason: err.reason };
    }
    if (err instanceof TransactionSubmissionFailedError) {
      return { status: "submission_failed", error: err };
    }
    throw err;
  }
  if (!txResponse) {
    return { status: "skipped" };
  }
  try {
    const receipt = await txResponse.wait();
    return isDefined(receipt) ? { status: "confirmed", receipt } : { status: "skipped" };
  } catch {
    // `TransactionClient._submit()` may exhaust its internal confirmation loop and still return
    // the `TransactionResponse`, so this outer `wait()` can reject with transient provider errors
    // (SERVER_ERROR / TIMEOUT) after the tx was actually placed. Preserve the legacy "no receipt →
    // caller retries / clears locks" path instead of aborting the run.
    return { status: "skipped" };
  }
}
