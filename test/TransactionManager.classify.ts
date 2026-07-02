import { ethers } from "ethers";
import { expect } from "./utils";
import { classifyAckFailure } from "../src/transactionManager/TransactionManager";

function ethersError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error("test error"), { code, ...extra });
}

describe("TransactionManager classifyAckFailure", function () {
  it("classifies INSUFFICIENT_FUNDS", function () {
    const result = classifyAckFailure(ethersError(ethers.errors.INSUFFICIENT_FUNDS));
    expect(result.reason).to.equal("insufficient_funds");
  });

  it("classifies INVALID_ARGUMENT as validation", function () {
    const result = classifyAckFailure(ethersError(ethers.errors.INVALID_ARGUMENT));
    expect(result.reason).to.equal("validation");
  });

  it("classifies MISSING_ARGUMENT as validation", function () {
    const result = classifyAckFailure(ethersError(ethers.errors.MISSING_ARGUMENT));
    expect(result.reason).to.equal("validation");
  });

  it("classifies UNEXPECTED_ARGUMENT as validation", function () {
    const result = classifyAckFailure(ethersError(ethers.errors.UNEXPECTED_ARGUMENT));
    expect(result.reason).to.equal("validation");
  });

  it("classifies UNPREDICTABLE_GAS_LIMIT with revert reason as simulation", function () {
    const result = classifyAckFailure(
      ethersError(ethers.errors.UNPREDICTABLE_GAS_LIMIT, { reason: "execution reverted: foo" })
    );
    expect(result.reason).to.equal("simulation");
  });

  it("classifies UNPREDICTABLE_GAS_LIMIT without revert reason as unknown", function () {
    const result = classifyAckFailure(ethersError(ethers.errors.UNPREDICTABLE_GAS_LIMIT, { reason: "out of gas" }));
    expect(result.reason).to.equal("unknown");
  });

  it("classifies REPLACEMENT_UNDERPRICED as unknown (TransactionClient retries internally)", function () {
    const result = classifyAckFailure(ethersError(ethers.errors.REPLACEMENT_UNDERPRICED));
    expect(result.reason).to.equal("unknown");
  });

  it("classifies a non-ethers error as unknown", function () {
    const result = classifyAckFailure(new Error("network glitch"));
    expect(result.reason).to.equal("unknown");
    expect(result.message).to.equal("network glitch");
  });

  it("classifies a non-Error throw as unknown", function () {
    const result = classifyAckFailure("string thrown");
    expect(result.reason).to.equal("unknown");
    expect(result.message).to.equal("string thrown");
  });
});
