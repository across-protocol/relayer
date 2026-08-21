import { BigNumber, providers } from "ethers";
import {
  MULTICALL3_BATCH_GAS_CEILING,
  MULTICALL3_BATCH_GAS_MULTIPLIER,
  MULTICALL3_BATCH_GAS_OVERHEAD,
} from "../common/Constants";
import { bnZero } from "./SDKUtils";
import { Multicall2Call } from "./TransactionUtils";

export type Multicall3BatchPlan = {
  /** Indices of calls to submit, in input order. */
  included: number[];
  /** Summed estimates of the included calls, plus wrapper overhead the estimates don't price. */
  gasLimit: BigNumber;
  /** Calls dropped because estimation failed; a call with no size must not be submitted. */
  failed: { index: number; error: Error }[];
  /** Calls deferred because they would push the batch over the per-transaction gas budget. */
  deferred: number[];
};

/**
 * Estimates a single Multicall3 inner call.
 * @param from The Multicall3 address — each call executes from the batcher, not from the signer.
 * @returns The estimate, or the estimation Error (a failing call must be dropped, not submitted).
 */
export async function estimateMulticall3Call(
  provider: providers.Provider,
  from: string,
  { target, callData }: Multicall2Call
): Promise<BigNumber | Error> {
  try {
    return await provider.estimateGas({ from, to: target, data: callData });
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Plans a Multicall3.tryAggregate(false) batch: estimates every call, drops calls that fail
 * estimation, defers calls that would exceed the per-transaction gas budget, and sizes the rest.
 * tryAggregate(false) must never be sized by estimating itself — it catches inner failures, so a
 * batch estimate can price a transaction that executes nothing (see src/clients/README.md).
 * Estimation is per-call against pre-batch state; cross-call interactions are not caught here and
 * must be absorbed by requireSuccess=false at execution.
 * @param estimateCall Estimates one call (e.g. {@link estimateMulticall3Call} bound to the chain's
 * provider and Multicall3 address), resolving to the estimation Error on failure.
 * @param calls Calls in submission order.
 */
export async function planMulticall3Batch(
  estimateCall: (call: Multicall2Call) => Promise<BigNumber | Error>,
  calls: Multicall2Call[]
): Promise<Multicall3BatchPlan> {
  const estimates = await Promise.all(calls.map((call) => estimateCall(call)));

  // Budget under the per-transaction ceiling for the padding applied at submission and the wrapper
  // allowance added below.
  const budget = BigNumber.from(
    Math.floor(MULTICALL3_BATCH_GAS_CEILING / MULTICALL3_BATCH_GAS_MULTIPLIER) - MULTICALL3_BATCH_GAS_OVERHEAD
  );

  let callGas = bnZero;
  const included: number[] = [];
  const failed: { index: number; error: Error }[] = [];
  const deferred: number[] = [];
  estimates.forEach((estimate, index) => {
    if (estimate instanceof Error) {
      failed.push({ index, error: estimate });
    } else if (callGas.add(estimate).gt(budget)) {
      deferred.push(index);
    } else {
      callGas = callGas.add(estimate);
      included.push(index);
    }
  });

  return { included, gasLimit: callGas.add(MULTICALL3_BATCH_GAS_OVERHEAD), failed, deferred };
}
