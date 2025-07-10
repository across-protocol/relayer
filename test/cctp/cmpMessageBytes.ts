import { expect } from "chai";
import { cmpAPIToEventMessageBytesV2 } from "../../src/utils/CCTPUtils";

describe("utils/CCTPUtils.cmpAPIToEventMessageBytesV2", function () {
  const repeat = (hex: string, times: number): string => Array(times).fill(hex).join("");

  /*
    Build a canonical message layout (hex-encoded):
       ┌──────────────┬──────────────────┬──────────────────┬─────────────────────────────┬──────────────────┐
       │   header     │      nonce       │    segment2      │ finalityThresholdExecuted  │     segment3     │
       └──────────────┴──────────────────┴──────────────────┴─────────────────────────────┴──────────────────┘
       bytes:        [0..12)      [12..44)         [44..143)                [144..148)           148..end
  */
  const segment1 = repeat("11", 12); // 12 bytes (24 hex chars)
  const nonce = repeat("aa", 32); // 32 bytes (64 hex chars)
  const segment2 = repeat("22", 100); // 100 bytes (200 hex chars)

  const finality = repeat("ff", 4); // 4 bytes (8 hex chars)
  const segment3 = repeat("33", 20); // 20 bytes (40 hex chars)

  const baseMsg = `0x${segment1}${nonce}${segment2}${finality}${segment3}`;

  // Variants
  const nonceVariant = `0x${segment1}${repeat("bb", 32)}${segment2}${finality}${segment3}`;
  const finalityVariant = `0x${segment1}${nonce}${segment2}${repeat("ee", 4)}${segment3}`;
  const seg1Variant = `0x${repeat("44", 12)}${nonce}${segment2}${finality}${segment3}`;
  const seg2Variant = `0x${segment1}${nonce}${repeat("55", 100)}${finality}${segment3}`;

  it("returns true for identical messages", function () {
    expect(cmpAPIToEventMessageBytesV2(baseMsg, baseMsg)).to.be.true;
  });

  it("returns true when only nonce differs", function () {
    expect(cmpAPIToEventMessageBytesV2(nonceVariant, baseMsg)).to.be.true;
  });

  it("returns true when only finalityThresholdExecuted differs", function () {
    expect(cmpAPIToEventMessageBytesV2(finalityVariant, baseMsg)).to.be.true;
  });

  it("returns false when segment1 differs", function () {
    expect(cmpAPIToEventMessageBytesV2(seg1Variant, baseMsg)).to.be.false;
  });

  it("returns false when segment2 differs", function () {
    expect(cmpAPIToEventMessageBytesV2(seg2Variant, baseMsg)).to.be.false;
  });

});