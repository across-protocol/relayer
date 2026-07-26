// Wire shapes for the TransactionManager protocol. Library-neutral: numeric
// fields cross the wire as hex strings, failure reasons use module enums (no
// ethers/viem error codes), and receipt fields use a primitive subset.

import { any, array, create, enums, Infer, literal, number, object, optional, string, union } from "superstruct";

const HexString = string();
const Address = string();

const AckFailureS = enums(["validation", "simulation", "insufficient_funds", "unknown"] as const);

const FinalFailureS = enums(["confirmation", "reverted"] as const);

const TransactionReceiptLiteS = object({
  blockNumber: number(),
  blockHash: string(),
  status: union([literal(0), literal(1)]),
  gasUsed: HexString,
  effectiveGasPrice: HexString,
  logs: array(
    object({
      address: Address,
      topics: array(string()),
      data: HexString,
    })
  ),
});

const SubmissionRequestS = object({
  id: string(),
  chainId: number(),
  to: Address,
  // Method-scoped fragment array or JSON-encoded ABI string; inner shape not validated here.
  abi: union([array(any()), string()]),
  method: string(),
  args: array(any()),
  value: optional(HexString),
  gasLimit: optional(HexString),
  gasLimitMultiplier: optional(number()),
  confirmations: optional(number()),
  message: optional(string()),
  mrkdwn: optional(string()),
});

const AckSuccessS = object({
  id: string(),
  phase: literal("ack"),
  ok: literal(true),
  hash: HexString,
  nonce: number(),
});

const AckFailureMessageS = object({
  id: string(),
  phase: literal("ack"),
  ok: literal(false),
  reason: AckFailureS,
  error: string(),
});

const AckMessageS = union([AckSuccessS, AckFailureMessageS]);

const FinalSuccessS = object({
  id: string(),
  phase: literal("final"),
  ok: literal(true),
  hash: HexString,
  receipt: TransactionReceiptLiteS,
});

const FinalFailureMessageS = object({
  id: string(),
  phase: literal("final"),
  ok: literal(false),
  hash: optional(HexString),
  reason: FinalFailureS,
  error: string(),
});

const FinalMessageS = union([FinalSuccessS, FinalFailureMessageS]);

const ResponseMessageS = union([AckSuccessS, AckFailureMessageS, FinalSuccessS, FinalFailureMessageS]);

export type AckFailure = Infer<typeof AckFailureS>;
export type FinalFailure = Infer<typeof FinalFailureS>;
export type TransactionReceiptLite = Infer<typeof TransactionReceiptLiteS>;
export type SubmissionRequest = Infer<typeof SubmissionRequestS>;
export type AckMessage = Infer<typeof AckMessageS>;
export type FinalMessage = Infer<typeof FinalMessageS>;
export type ResponseMessage = Infer<typeof ResponseMessageS>;

export function encodeRequest(req: SubmissionRequest): string {
  return JSON.stringify(req);
}

export function decodeRequest(payload: string): SubmissionRequest {
  return create(JSON.parse(payload), SubmissionRequestS);
}

export function encodeAck(msg: AckMessage): string {
  return JSON.stringify(msg);
}

export function decodeAck(payload: string): AckMessage {
  return create(JSON.parse(payload), AckMessageS);
}

export function encodeFinal(msg: FinalMessage): string {
  return JSON.stringify(msg);
}

export function decodeFinal(payload: string): FinalMessage {
  return create(JSON.parse(payload), FinalMessageS);
}

// Decodes either ACK or final; use when phase is unknown in advance.
export function decodeResponse(payload: string): ResponseMessage {
  return create(JSON.parse(payload), ResponseMessageS);
}
