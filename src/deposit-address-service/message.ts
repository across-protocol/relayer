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

/** Which path a message takes. `drop` is not represented: those throw {@link UnsupportedMessageError}. */
export type TransferRoute = "deposit" | "withdraw";

export interface ParsedTransfer {
  readonly transferId: string;
  readonly route: TransferRoute;
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
 * Validates a decoded payload and decides its route. Pure: no I/O, no clients, no config.
 *
 * Throws `MessageValidationError` (ACK — the same bytes fail identically on every redelivery) for bad
 * JSON or a shape that breaks the contract, and `UnsupportedMessageError` (ACK) for anything this
 * service does not act on: a non-v3 version, or a classification with no route.
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

  return { transferId: transferId(message.erc20Transfer), route: route(message), message };
}

/**
 * Mirrors `processExecution` in the polling bot, minus the refund-only marker: that state is gone, so a
 * below-minimum transfer re-asks the execute endpoint on redelivery and falls back to withdraw again.
 */
function route(message: DepositAddressMessageV3): TransferRoute {
  const { transferClassification } = message.erc20Transfer;
  switch (transferClassification) {
    case "correct_transfer":
      return "deposit";
    // An expired intent refunds to the deposit address itself (the SpokePool depositor), so it needs
    // the same second hop out to the committed refund address as a mis_route.
    case "mis_route":
    case "intent_refund":
      return "withdraw";
    default:
      throw new UnsupportedMessageError(`no v3 route for classification ${transferClassification}`);
  }
}
