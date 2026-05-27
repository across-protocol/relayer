import {
  SolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SLOT_SKIPPED,
} from "@solana/kit";
import { expect } from "./utils";
import { describeSolanaError, isSvmLeafAlreadyClaimedError } from "../src/utils/LogUtils";

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
