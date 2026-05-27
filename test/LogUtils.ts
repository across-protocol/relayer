import { SolanaError, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE } from "@solana/kit";
import { expect } from "./utils";
import { describeSolanaError } from "../src/utils/LogUtils";

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
