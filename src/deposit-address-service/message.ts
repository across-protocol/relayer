import {
  StructError,
  array,
  boolean,
  create,
  enums,
  integer,
  literal,
  min,
  nullable,
  optional,
  string,
  type,
} from "superstruct";
import { DepositAddressMessageV3, Erc20Transfer } from "../interfaces/DepositAddress";
import { MessageValidationError, UnsupportedMessageError } from "./errors";

/**
 * `type()` rather than `object()` throughout: unknown keys are allowed, so the indexer adding a field
 * cannot break this service. Matches the indexer's own webhook envelope, which uses `s.type` for the
 * same reason. v3 messages get **no** structural validation in the polling bot — it checks `version`
 * and casts the rest — so this is new coverage, not a port.
 */
const Erc20TransferStruct = type({
  chainId: string(),
  blockNumber: min(integer(), 0),
  logIndex: min(integer(), 0),
  from: string(),
  to: string(),
  amount: string(),
  contractAddress: string(),
  transactionHash: string(),
  transferClassification: enums(["correct_transfer", "mis_route", "intent_refund"]),
});

const NamespacedAccountStruct = type({ namespace: string(), address: string() });

const V3MessageStruct = type({
  depositAddress: string(),
  version: literal(3),
  salt: string(),
  initialRoot: string(),
  counterfactualBeaconContractAddress: string(),
  counterfactualFactoryContractAddress: string(),
  adminWithdrawManagerContractAddress: string(),
  shouldSponsorAccountCreation: boolean(),
  counterfactualMaterials: array(
    type({
      kind: string(),
      implementationAddress: string(),
      encodedParams: string(),
      leafHash: string(),
      merkleProof: array(string()),
    })
  ),
  routeParams: type({
    outputToken: string(),
    destinationChainId: string(),
    recipient: NamespacedAccountStruct,
  }),
  refundAddress: NamespacedAccountStruct,
  depositAddressNamespace: string(),
  erc20Transfer: Erc20TransferStruct,
  integrator: optional(nullable(type({ name: string(), integratorId: nullable(string()) }))),
});

/**
 * Deliberately carries no deposit-vs-withdraw decision.
 *
 * Naming one here would be both a rename and a lie. A rename because `correct_transfer` ⇒ "deposit" and
 * `mis_route` ⇒ "withdraw" is a second vocabulary for a fact the indexer already stated, with no rules
 * folded in. A lie because the decision is not knowable yet: a `correct_transfer` the execute endpoint
 * rejects as below the minimum becomes a refund withdraw, and that is only known after the API answers.
 *
 * The honest place for that word is `BroadcastPendingState.operation`, which records what the transaction
 * being broadcast actually does, at the point it is known.
 */
export interface ParsedTransfer {
  readonly transferId: string;
  readonly message: DepositAddressMessageV3;
}

/**
 * The indexer row's durable identity, and the tuple `DepositAddressExecutionConsumer` already keys
 * lookups on. Deliberately finer than the polling bot's `getDepositKey`, which is
 * `depositAddress:transactionHash` and so collides when one transaction makes two transfers to the same
 * address.
 *
 * Normalised, because the same transfer must always produce the same id: `chainId` arrives as a string,
 * and hash casing varies. No prefix normalisation — format is consistent per chain (EVM `0x`, Tron
 * bare), and `chainId` is part of the id, so the two can never collide.
 */
export function transferId(transfer: Erc20Transfer): string {
  return `${Number(transfer.chainId)}:${transfer.transactionHash.toLowerCase()}:${transfer.logIndex}`;
}

/**
 * Validates a decoded payload and derives its identity. Pure: no I/O, no clients, no config.
 *
 * Throws `MessageValidationError` (ACK — the same bytes fail identically on every redelivery) for bad
 * JSON or a shape that breaks the contract, and `UnsupportedMessageError` (ACK) for a non-v3 version.
 *
 * Every v3 classification is actionable — `correct_transfer` sweeps, `mis_route` and `intent_refund` both
 * refund — so there is nothing to drop here, and the struct's `enums` already rejects an unknown one as a
 * validation failure. Note what this does **not** decide — see {@link ParsedTransfer}.
 *
 * v1 is intentionally unsupported here; the polling bot still serves it until a later PR ports it.
 */
export function parseTransfer(payload: string): ParsedTransfer {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch (err) {
    throw new MessageValidationError(`payload is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const version = (decoded as { version?: unknown })?.version;
  if (version !== 3) {
    throw new UnsupportedMessageError(`unsupported message version ${JSON.stringify(version)}`);
  }

  let message: DepositAddressMessageV3;
  try {
    message = create(decoded, V3MessageStruct);
  } catch (err) {
    // StructError names the offending path, which is the only useful thing in the log line.
    const detail = err instanceof StructError ? `${err.path.join(".")}: ${err.message}` : String(err);
    throw new MessageValidationError(`v3 message failed validation at ${detail}`);
  }

  return { transferId: transferId(message.erc20Transfer), message };
}
