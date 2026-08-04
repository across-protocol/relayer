import { ethers } from "ethers";

/**
 * CCTP V2 Message Structure Constants
 */
export const MESSAGE_HEADER_LENGTH = 148;
export const MESSAGE_BODY_VERSION_LENGTH = 4;
export const MESSAGE_BODY_BURN_TOKEN_LENGTH = 32;
export const MINT_RECIPIENT_LENGTH = 32;
export const NONCE_LENGTH = 32;
export const NONCE_OFFSET = 12;

/**
 * Mint recipient offset in CCTP V2 message
 * Located at: Header (148) + Body Version (4) + Burn Token (32) = 184
 */
export const MINT_RECIPIENT_OFFSET =
  MESSAGE_HEADER_LENGTH + MESSAGE_BODY_VERSION_LENGTH + MESSAGE_BODY_BURN_TOKEN_LENGTH;

export type ParsedCctpV2Message = {
  buffer: Buffer;
  mintRecipientBytes32: Uint8Array;
  nonceSeed: Uint8Array;
};

/**
 * Parses a CCTP V2 message and extracts key fields
 * @param message - The CCTP message (hex string, with or without 0x prefix)
 * @returns Parsed message with buffer, mint recipient bytes, and nonce seed
 */
export function parseCctpV2Message(message: string): ParsedCctpV2Message {
  const normalized = message.startsWith("0x") ? message.slice(2) : message;
  const buffer = Buffer.from(normalized, "hex");
  const mintRecipientBytes32 = buffer.slice(MINT_RECIPIENT_OFFSET, MINT_RECIPIENT_OFFSET + MINT_RECIPIENT_LENGTH);
  const nonceSeed = buffer.slice(NONCE_OFFSET, NONCE_OFFSET + NONCE_LENGTH);

  return {
    buffer,
    mintRecipientBytes32: new Uint8Array(mintRecipientBytes32),
    nonceSeed: new Uint8Array(nonceSeed),
  };
}

/**
 * Extracts the mint recipient address from a CCTP V2 message for EVM chains
 * The mint recipient is stored as bytes32 in the message body, we extract the last 20 bytes as an EVM address
 * @param message - The CCTP message (hex string, with or without 0x prefix)
 * @returns The mint recipient address (0x-prefixed 20-byte address)
 */
export function extractMintRecipientAddress(message: string): string {
  const parsed = parseCctpV2Message(message);
  const mintRecipientBytes32 = ethers.utils.hexlify(parsed.mintRecipientBytes32);
  // Convert bytes32 to address by taking the last 20 bytes (40 hex chars)
  const address = "0x" + mintRecipientBytes32.slice(-40);
  return address;
}
