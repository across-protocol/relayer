import { DepositAddressExecuteResponse, DepositAddressSignWithdrawResponse } from "../clients/AcrossSwapApiClient";
import { CounterfactualMaterialV3, DepositAddressMessageV3 } from "../interfaces/DepositAddress";
import { chainIsEvm, chainIsTvm, getEthersCompatibleAddress } from "../utils";
import { isDefined } from "../utils/TypeGuards";
import {
  InvalidExecuteResponseError,
  InvalidIntegratorIdError,
  InvalidWithdrawResponseError,
  MissingWithdrawMaterialsError,
  OriginChainDisabledError,
  UnsupportedChainFamilyError,
  UnsupportedNamespaceError,
} from "./errors";

/**
 * Pure execute-path guards, ported guard-for-guard from `initiateDepositV3` and `_validateExecuteResponse`.
 *
 * The three constants and `expectedNamespaceForChain` below are re-declared rather than imported: they are
 * module-private in `DepositAddressHandler.ts`, which this service does not modify. The duplication is
 * ~10 lines and disappears when the polling bot is removed.
 *
 * Nothing here does I/O. The two guards that need a provider — canonicality and balance — live with the
 * orchestration that already holds a lock and a deadline, because their dispositions depend on retry policy
 * rather than on the message alone. Each guard throws its typed error, so the ACK/NACK decision travels with
 * the failure instead of being re-derived from a boolean at the call site.
 */

/** 2-byte hex. The execute endpoint folds this into the CREATE2 salt, so a wrong one derives a wrong address. */
const INTEGRATOR_ID_REGEX = /^0x[0-9a-fA-F]{4}$/;

/**
 * Seconds of headroom required on the response's signature deadline, covering simulation, broadcast and the
 * confirmation wait. A stale response is dropped and re-requested on the next delivery.
 */
const SIGNATURE_DEADLINE_BUFFER_SECONDS = 60;

/**
 * Account namespace expected for addresses living on `chainId`; `undefined` means a chain family the v3
 * execute path does not support. Note zkSync-family chains are EVM here, so a `zksync`-namespaced message is
 * rejected — the same outcome as the polling bot.
 */
function expectedNamespaceForChain(chainId: number): "evm" | "tron" | undefined {
  return chainIsTvm(chainId) ? "tron" : chainIsEvm(chainId) ? "evm" : undefined;
}

/**
 * The origin chain must belong to a family with a v3 execute path, *and* be enabled.
 *
 * Two conditions with **opposite dispositions**, which is why they raise different errors. An unsupported
 * family is a property of the code and can never pass on redelivery, so it ACKs. A chain missing from
 * `RELAYER_ORIGIN_CHAINS` is an operator switch that may be flipped back, so it NACKs — the funds are still on
 * the deposit address, and ACKing would destroy the only delivery that could ever sweep them.
 *
 * **Family is checked first, deliberately.** A chain that is both unsupported *and* absent from config must
 * ACK; checking config first would NACK it every 60s for the whole retention period over a condition no
 * operator action can resolve.
 */
export function assertSupportedOriginChain(originChains: number[], originChainId: number): void {
  if (!isDefined(expectedNamespaceForChain(originChainId))) {
    throw new UnsupportedChainFamilyError(`origin chain ${originChainId} belongs to an unsupported chain family`);
  }
  if (!originChains.includes(originChainId)) {
    throw new OriginChainDisabledError(`origin chain ${originChainId} is not in RELAYER_ORIGIN_CHAINS`);
  }
}

/**
 * The execute endpoint's identity (`userAddress`) must be native to the origin chain's family — EVM ⇒ 0x-hex,
 * Tron ⇒ base58. A cross-family namespace is a data anomaly rather than something to translate.
 */
export function assertSupportedNamespace(message: DepositAddressMessageV3, originChainId: number): void {
  const { depositAddressNamespace, refundAddress } = message;
  const expected = expectedNamespaceForChain(originChainId);
  if (depositAddressNamespace !== expected || refundAddress.namespace !== expected) {
    throw new UnsupportedNamespaceError(
      `expected namespace ${expected ?? "unsupported chain family"} on chain ${originChainId}, got ` +
        `depositAddress=${depositAddressNamespace} refundAddress=${refundAddress.namespace}`
    );
  }
}

/**
 * Returns the validated `integratorId`, narrowing it to a string for the request builder.
 *
 * Absent or malformed is terminal: the value is part of the salt the funded address was derived with, so
 * substituting one would execute against a different, unfunded address.
 */
export function assertIntegratorId(message: DepositAddressMessageV3): string {
  const integratorId = message.integrator?.integratorId;
  if (!isDefined(integratorId) || !INTEGRATOR_ID_REGEX.test(integratorId)) {
    throw new InvalidIntegratorIdError(`missing or malformed integratorId: ${integratorId ?? "absent"}`);
  }
  return integratorId;
}

/**
 * Sanity-checks an execute response before submission.
 *
 * The first check is the important one: the API re-derives the deposit address from the request, so a
 * mismatch means it would deploy and execute at a different address than the one holding the user's funds.
 * Addresses are compared through the 0x-hex form because base58 is case-sensitive — which also accepts a
 * hex-encoded response for a base58-funded address, and degrades to a lowercase compare on EVM.
 *
 * @param nowSeconds Unix seconds, passed in so this stays pure and the deadline check is testable.
 */
export function assertValidExecuteResponse(
  response: DepositAddressExecuteResponse,
  message: DepositAddressMessageV3,
  originChainId: number,
  nowSeconds: number
): void {
  const { executeTx, isPlaceholder, signatureDeadline } = response;
  const canonical = (address: string) => getEthersCompatibleAddress(originChainId, address).toLowerCase();

  if (canonical(response.depositAddress) !== canonical(message.depositAddress)) {
    throw new InvalidExecuteResponseError(
      `API-derived deposit address ${response.depositAddress} does not match funded address ${message.depositAddress}`
    );
  }
  if (executeTx.chainId !== originChainId) {
    throw new InvalidExecuteResponseError(
      `execute tx chainId ${executeTx.chainId} does not match origin chain ${originChainId}`
    );
  }
  const expectedEcosystem = chainIsTvm(originChainId) ? "tvm" : "evm";
  if (executeTx.ecosystem !== expectedEcosystem) {
    throw new InvalidExecuteResponseError(
      `execute tx ecosystem ${executeTx.ecosystem} does not match origin chain family ${expectedEcosystem}`
    );
  }
  if (isPlaceholder) {
    throw new InvalidExecuteResponseError("API derivation used placeholder creation code");
  }
  if (signatureDeadline < nowSeconds + SIGNATURE_DEADLINE_BUFFER_SECONDS) {
    throw new InvalidExecuteResponseError(
      `signature deadline ${signatureDeadline} is within ${SIGNATURE_DEADLINE_BUFFER_SECONDS}s of expiry`
    );
  }
}

/**
 * v3 withdrawals are **EVM-only — stricter than the deposit path**, which accepts any namespace native to
 * the chain family. The polling bot requires both namespaces to be exactly `evm`, and the sign-withdraw
 * response's `ecosystem` is the type-level literal `"evm"`, so a Tron-native message that the deposit path
 * would execute still has no withdraw route. Deterministic, so ACK.
 */
export function assertEvmWithdrawNamespaces(message: DepositAddressMessageV3): void {
  const { depositAddressNamespace, refundAddress } = message;
  if (depositAddressNamespace !== "evm" || refundAddress.namespace !== "evm") {
    throw new UnsupportedNamespaceError(
      `v3 withdrawals are EVM-only; got depositAddress=${depositAddressNamespace} ` +
        `refundAddress=${refundAddress.namespace}`
    );
  }
}

/**
 * Returns the withdraw leaf the sign-withdraw request is built from. The `merkleProof` and
 * `implementationAddress` checks are subsumed by the message schema today; they stay because the polling
 * bot checks them and a schema loosening must not silently reach the request builder.
 */
export function assertWithdrawMaterials(message: DepositAddressMessageV3): CounterfactualMaterialV3 {
  const withdrawLeaf = message.counterfactualMaterials.find((leaf) => leaf.kind === "withdraw");
  if (
    !isDefined(withdrawLeaf) ||
    !isDefined(withdrawLeaf.merkleProof) ||
    !isDefined(withdrawLeaf.implementationAddress)
  ) {
    throw new MissingWithdrawMaterialsError(
      `message for ${message.depositAddress} carries no usable withdraw leaf in counterfactualMaterials`
    );
  }
  return withdrawLeaf;
}

/**
 * Sanity-checks a sign-withdraw response before submission. Deliberately **not** `assertValidExecuteResponse`
 * with a different verb: there is no `isPlaceholder`, no API-re-derived address to compare (the request
 * *supplies* the address), and `ecosystem` is a type-level literal — only the chain and deadline checks apply.
 *
 * The chain to match is the **refund** chain, `erc20Transfer.chainId` — where the funds landed. For a
 * `mis_route` that differs from the route's origin chain, which is exactly the case this path exists for.
 *
 * @param nowSeconds Unix seconds, passed in so this stays pure and the deadline check is testable.
 */
export function assertValidWithdrawResponse(
  response: DepositAddressSignWithdrawResponse,
  refundChainId: number,
  nowSeconds: number
): void {
  if (response.signedWithdrawTx.chainId !== refundChainId) {
    throw new InvalidWithdrawResponseError(
      `signed withdraw chainId ${response.signedWithdrawTx.chainId} does not match refund chain ${refundChainId}`
    );
  }
  if (response.deadline < nowSeconds + SIGNATURE_DEADLINE_BUFFER_SECONDS) {
    throw new InvalidWithdrawResponseError(
      `signature deadline ${response.deadline} is within ${SIGNATURE_DEADLINE_BUFFER_SECONDS}s of expiry`
    );
  }
}
