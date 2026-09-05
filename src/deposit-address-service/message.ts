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
  pattern,
  refine,
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

/**
 * A chain id the indexer sends as a **string**, constrained to something `Number()` turns into a usable chain
 * id. Validated here rather than at the first use because the damage is not limited to one call site:
 * `Number("bogus")` is `NaN`, which flows into `transferId()` and produces the key
 * `deposit-address:lock:NaN:<txHash>:<logIndex>` — so two malformed messages sharing a hash and log index
 * would collide on one lock and one state record. Identity corruption, not just a bad RPC call.
 *
 * Downstream it would also reach `getProvider(NaN)`, whose ordinary `Error` is *unrecognised* by the app and
 * therefore treated as retriable **and** alerting — so a deterministically malformed message would page and
 * then redeliver every 60s for the whole retention period. Failing validation instead makes it an ACK.
 *
 * Refined on the converted value rather than pattern-matched on the string, so a legitimate non-decimal
 * encoding is not rejected for cosmetic reasons.
 */
const NumericChainId = refine(string(), "numeric chain id", (value) => {
  const chainId = Number(value);
  return Number.isInteger(chainId) && chainId > 0;
});

/**
 * The transfer amount: a plain non-negative integer, decimal or `0x`-hex — the two encodings the execute
 * endpoint documents.
 *
 * Three separate defects hid behind one unvalidated string, and only the first is the loud kind.
 * `toBN("bogus")` throws an untyped ethers error the app cannot tell from a transient fault, so a
 * deterministically malformed message pages and then redelivers for the whole retention period. `toBN("-1")`
 * does **not** throw — it yields −1, and `onchainBalance.lt(-1)` is `false`, so a negative amount sails
 * straight through the balance guard, the only check between the message and the execute call. And
 * `toBN("1.5")` silently **truncates** to 1, so the guard would check a different number than the one sent.
 *
 * Pinned by shape rather than by attempting the conversion, precisely because of that last case: unlike
 * `chainId`, the raw string is *also* forwarded to the API verbatim, so the value the guard checks and the
 * value we ask for have to be the same one.
 */
const AmountString = pattern(string(), /^(0x[0-9a-fA-F]+|\d+)$/);

const Erc20TransferStruct = type({
  chainId: NumericChainId,
  blockNumber: min(integer(), 0),
  logIndex: min(integer(), 0),
  from: string(),
  to: string(),
  amount: AmountString,
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
    // Same treatment: a NaN here reaches the execute endpoint, which rejects it as a client error that this
    // service cannot distinguish from a transient one, so it would also redeliver forever.
    destinationChainId: NumericChainId,
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
