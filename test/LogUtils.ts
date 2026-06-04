import "../src/utils"; // Triggers side-effect import of extensions (BigInt.toJSON patch).
import {
  SolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED,
} from "@solana/kit";
import { expect } from "./utils";
import { describeSolanaError, isSvmLeafAlreadyClaimedError, stringifyThrownValue } from "../src/utils/LogUtils";

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

describe("isSvmLeafAlreadyClaimedError", function () {
  const claimedLogLine =
    "Program log: AnchorError caused by account: state. Error Code: ClaimedMerkleLeaf. Error Number: 6010. Error Message: Leaf already claimed!.";

  it("returns false for non-Solana errors", function () {
    expect(isSvmLeafAlreadyClaimedError(new Error("nope"))).to.be.false;
    expect(isSvmLeafAlreadyClaimedError("string")).to.be.false;
    expect(isSvmLeafAlreadyClaimedError(undefined)).to.be.false;
  });

  it("returns false when the SolanaError isn't a preflight failure", function () {
    // SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED requires a `slot` field in context.
    const err = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED, { slot: 12345 });
    expect(isSvmLeafAlreadyClaimedError(err)).to.be.false;
  });

  it("returns false when the preflight logs don't mention ClaimedMerkleLeaf", function () {
    const err = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
      accounts: null,
      logs: [
        "Program log: Instruction: ExecuteRelayerRefundLeaf",
        "Program log: AnchorError caused by account: vault. Error Code: InsufficientSpokePoolBalanceToExecuteLeaf. Error Number: 6013. Error Message: Insufficient spoke pool balance to execute leaf.",
      ],
      returnData: null,
      unitsConsumed: 1234n,
    });
    expect(isSvmLeafAlreadyClaimedError(err)).to.be.false;
  });

  it("returns true when the preflight logs contain the ClaimedMerkleLeaf error code line", function () {
    const err = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
      accounts: null,
      logs: ["Program log: Instruction: ExecuteRelayerRefundLeaf", claimedLogLine],
      returnData: null,
      unitsConsumed: 1234n,
    });
    expect(isSvmLeafAlreadyClaimedError(err)).to.be.true;
  });

  it("works on a structurally-cloned SolanaError (JSON round-trip)", function () {
    const cloned = JSON.parse(
      JSON.stringify({
        name: "SolanaError",
        context: {
          __code: SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
          logs: [claimedLogLine],
        },
      })
    );
    expect(isSvmLeafAlreadyClaimedError(cloned)).to.be.true;
  });

  it("returns false when the preflight context has no logs array", function () {
    const err = {
      name: "SolanaError",
      context: { __code: SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE },
    };
    expect(isSvmLeafAlreadyClaimedError(err)).to.be.false;
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
