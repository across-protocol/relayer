// @ts-nocheck
/* eslint-env jest */
import { cmpAPIToEventMessageBytesV2 } from "../../src/utils/CCTPUtils";

describe("cmpAPIToEventMessageBytesV2", () => {
  const repeat = (hex: string, times: number) => Array(times).fill(hex).join("");

  // Build a canonical base message
  //  ┌────────────┬──────────┬──────────┬─────────────────────────┬──────────┬─────────┐
  //  │ segment 1  │  nonce   │ segment2 │ finalityThresholdExec. │ segment3 │  ...    │
  //  └────────────┴──────────┴──────────┴─────────────────────────┴──────────┴─────────┘
  const segment1 = repeat("11", 12); // 12 bytes (24 hex chars)
  const nonce = repeat("aa", 32); // 32 bytes (64 hex chars)
  const segment2 = repeat("22", 100); // 100 bytes (200 hex chars)
  const finality = repeat("ff", 4); // 4 bytes (8 hex chars)
  const segment3 = repeat("33", 20); // 20 bytes (40 hex chars)
  const baseMsg = `0x${segment1}${nonce}${segment2}${finality}${segment3}`;

  // Variant where only the nonce differs (should match)
  const nonceVariant = `0x${segment1}${repeat("bb", 32)}${segment2}${finality}${segment3}`;

  // Variant where only finalityThresholdExecuted differs (should match)
  const finalityVariant = `0x${segment1}${nonce}${segment2}${repeat("ee", 4)}${segment3}`;

  // Variant with different segment1 (should not match)
  const seg1Variant = `0x${repeat("44", 12)}${nonce}${segment2}${finality}${segment3}`;

  // Variant with different segment2 (should not match)
  const seg2Variant = `0x${segment1}${nonce}${repeat("55", 100)}${finality}${segment3}`;

  it("returns true for identical messages", () => {
    expect(cmpAPIToEventMessageBytesV2(baseMsg, baseMsg)).toBe(true);
  });

  it("returns true when only nonce differs", () => {
    expect(cmpAPIToEventMessageBytesV2(nonceVariant, baseMsg)).toBe(true);
  });

  it("returns true when only finalityThresholdExecuted differs", () => {
    expect(cmpAPIToEventMessageBytesV2(finalityVariant, baseMsg)).toBe(true);
  });

  it("returns false when segment1 differs", () => {
    expect(cmpAPIToEventMessageBytesV2(seg1Variant, baseMsg)).toBe(false);
  });

  it("returns false when segment2 differs", () => {
    expect(cmpAPIToEventMessageBytesV2(seg2Variant, baseMsg)).toBe(false);
  });
});