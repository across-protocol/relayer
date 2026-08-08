import { expect } from "chai";
import { ethers } from "ethers";
import { shouldUseEmergencyReceiveMessage } from "../src/cctp-finalizer/utils/evmUtils";

/**
 * Build a minimal CCTP V2 message whose hookData starts at byte 376 and
 * encodes a SponsoredCCTP-style quote deadline.
 */
function messageWithHookDeadline(deadlineSeconds: number): string {
  const prefix = Buffer.alloc(376, 0);
  const recipient = ethers.utils.hexZeroPad("0x1111111111111111111111111111111111111111", 32);
  const token = ethers.utils.hexZeroPad("0x2222222222222222222222222222222222222222", 32);
  const hookData = ethers.utils.defaultAbiCoder.encode(
    ["bytes32", "uint256", "uint256", "uint256", "bytes32", "bytes32", "uint32", "uint8", "uint8", "bytes"],
    [
      ethers.constants.HashZero,
      deadlineSeconds,
      0,
      0,
      recipient,
      token,
      0,
      0,
      0,
      "0x",
    ]
  );
  return ethers.utils.hexlify(Buffer.concat([prefix, Buffer.from(ethers.utils.arrayify(hookData))]));
}

describe("CCTP finalizer emergencyReceiveMessage selection", function () {
  const now = 1_700_000_000;

  it("does not emergency-receive when on-message deadline is still in the future", function () {
    const message = messageWithHookDeadline(now + 3600);
    expect(shouldUseEmergencyReceiveMessage(message, true, now)).to.equal(false);
  });

  it("emergency-receives only when on-message deadline is expired", function () {
    const message = messageWithHookDeadline(now - 1);
    expect(shouldUseEmergencyReceiveMessage(message, true, now)).to.equal(true);
  });

  it("never emergency-receives when no signature path (standard transmitter)", function () {
    const message = messageWithHookDeadline(now - 1);
    expect(shouldUseEmergencyReceiveMessage(message, false, now)).to.equal(false);
  });

  it("does not emergency-receive when hookData cannot be decoded", function () {
    const shortMessage = ethers.utils.hexlify(Buffer.alloc(100, 1));
    expect(shouldUseEmergencyReceiveMessage(shortMessage, true, now)).to.equal(false);
  });
});
