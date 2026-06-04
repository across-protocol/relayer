import "../src/utils"; // Triggers side-effect import of extensions (BigInt.toJSON patch).
import { SolanaError, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE } from "@solana/kit";
import { expect } from "./utils";
import { describeSolanaError, stringifyThrownValue } from "../src/utils/LogUtils";

describe("describeSolanaError", function () {
  it("returns an empty object for non-Solana errors", function () {
    expect(describeSolanaError(new Error("nope"))).to.deep.equal({});
    expect(describeSolanaError("oops")).to.deep.equal({});
    expect(describeSolanaError(undefined)).to.deep.equal({});
  });

  it("extracts code and context from a SolanaError", function () {
    const preflightContext = {
      accounts: null,
      logs: ["Program log: refund leaf already executed"],
      returnData: null,
      unitsConsumed: 4321n,
    };
    const err = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
      ...preflightContext,
      cause: new Error("simulation failed"),
    });
    const result = describeSolanaError(err);
    expect(result.solanaError).to.exist;
    expect(result.solanaError?.code).to.equal(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE);
    expect(result.solanaError?.context).to.include({ logs: preflightContext.logs });
    expect(result.solanaError?.message).to.be.a("string");
  });

  // Regression: JsonTransport in @risk-labs/logger calls JSON.stringify on the log
  // payload. SolanaError contexts contain bigint `unitsConsumed` (typed by
  // @solana/rpc-api as `bigint`), which would throw "BigInt value can't be
  // serialized" without the global BigInt.prototype.toJSON patch in extensions.ts.
  // This test confirms the helper's output round-trips through JSON.stringify so
  // a refund-leaf failure doesn't crash the logger and skip the cleanup/rethrow.
  it("serializes cleanly via JSON.stringify when context contains bigint", function () {
    const err = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
      accounts: null,
      logs: ["Program log: refund leaf already executed"],
      returnData: null,
      unitsConsumed: 4321n,
    });
    const payload = { at: "test", ...describeSolanaError(err) };
    expect(() => JSON.stringify(payload)).to.not.throw();
    const round = JSON.parse(JSON.stringify(payload));
    expect(round.solanaError.context.unitsConsumed).to.equal("4321");
  });
});

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
