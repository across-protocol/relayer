import { expect } from "./utils";
import { stringifyThrownValue } from "../src/utils/LogUtils";

describe("stringifyThrownValue", function () {
  it("returns the stack for a plain Error (backwards compatible)", function () {
    const err = new Error("plain failure");
    const out = stringifyThrownValue(err);
    expect(out).to.include("plain failure");
    expect(out).to.include(err.stack ?? "");
  });

  it("captures `context` on Error instances (SolanaError shape)", function () {
    // Shape mirrors `@solana/errors` SolanaError, which the @solana/kit RPC
    // layer throws with `__code` plus the RPC response's `value.err` and
    // program `logs` attached on `context`.
    class FakeSolanaError extends Error {
      readonly context: { __code: number; value?: { err?: unknown; logs?: string[] } };
      constructor(message: string, context: FakeSolanaError["context"]) {
        super(message);
        this.context = context;
      }
    }
    const err = new FakeSolanaError("Transaction simulation failed", {
      __code: 4615012,
      value: {
        err: { InstructionError: [0, { Custom: 6011 }] },
        logs: ["Program log: AnchorError caused by account: instruction_params"],
      },
    });

    const out = stringifyThrownValue(err);
    expect(out).to.include("Transaction simulation failed");
    expect(out).to.include("__code");
    expect(out).to.include("4615012");
    expect(out).to.include("InstructionError");
    expect(out).to.include("instruction_params");
  });

  it("captures `cause` on Error instances and recurses for nested Errors", function () {
    const innerSolanaShape = Object.assign(new Error("inner simulation failed"), {
      context: { __code: 4615012 },
    });
    const wrapper = new Error("wrapper failed");
    (wrapper as Error & { cause: unknown }).cause = innerSolanaShape;

    const out = stringifyThrownValue(wrapper);
    expect(out).to.include("wrapper failed");
    expect(out).to.include("inner simulation failed");
    expect(out).to.include("4615012");
  });

  it("ignores absent context/cause and returns the stack", function () {
    const err = new Error("nothing extra");
    const out = stringifyThrownValue(err);
    expect(out).to.equal(err.stack ?? err.toString());
  });

  it("handles non-Error objects via JSON.stringify", function () {
    expect(stringifyThrownValue({ a: 1, b: "two" })).to.equal('{"a":1,"b":"two"}');
  });

  it("handles primitive thrown values", function () {
    expect(stringifyThrownValue("oops")).to.equal("ThrownValue: oops");
    expect(stringifyThrownValue(42)).to.equal("ThrownValue: 42");
  });
});
