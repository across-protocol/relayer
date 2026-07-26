import { expect } from "./utils";
import {
  AckMessage,
  FinalMessage,
  ResponseMessage,
  SubmissionRequest,
  decodeAck,
  decodeFinal,
  decodeRequest,
  decodeResponse,
  encodeAck,
  encodeFinal,
  encodeRequest,
} from "../src/transactionManager/wire";

const baseRequest: SubmissionRequest = {
  id: "req-1",
  chainId: 1,
  to: "0x0000000000000000000000000000000000000001",
  abi: [],
  method: "transfer",
  args: ["0xRecipient", "0x1"],
  value: "0x0",
  gasLimit: "0x5208",
  gasLimitMultiplier: 1.2,
  confirmations: 1,
  message: "test",
  mrkdwn: "test",
};

describe("TransactionManager wire", function () {
  describe("SubmissionRequest", function () {
    it("round-trips a populated request", function () {
      const decoded = decodeRequest(encodeRequest(baseRequest));
      expect(decoded).to.deep.equal(baseRequest);
    });

    it("accepts an ABI provided as a JSON string", function () {
      const req: SubmissionRequest = { ...baseRequest, abi: '[{"type":"function"}]' };
      const decoded = decodeRequest(encodeRequest(req));
      expect(decoded.abi).to.equal('[{"type":"function"}]');
    });

    it("rejects payload missing a required field", function () {
      const malformed = JSON.stringify({ ...baseRequest, id: undefined });
      expect(() => decodeRequest(malformed)).to.throw();
    });

    it("rejects payload with wrong field type", function () {
      const malformed = JSON.stringify({ ...baseRequest, chainId: "1" });
      expect(() => decodeRequest(malformed)).to.throw();
    });
  });

  describe("AckMessage", function () {
    it("round-trips a success ack", function () {
      const ack: AckMessage = { id: "req-1", phase: "ack", ok: true, hash: "0xabc", nonce: 42 };
      expect(decodeAck(encodeAck(ack))).to.deep.equal(ack);
    });

    it("round-trips a failure ack", function () {
      const ack: AckMessage = {
        id: "req-1",
        phase: "ack",
        ok: false,
        reason: "simulation",
        error: "execution reverted",
      };
      expect(decodeAck(encodeAck(ack))).to.deep.equal(ack);
    });

    it("rejects an unknown failure reason", function () {
      const malformed = JSON.stringify({
        id: "req-1",
        phase: "ack",
        ok: false,
        reason: "not-a-real-reason",
        error: "oops",
      });
      expect(() => decodeAck(malformed)).to.throw();
    });

    it("rejects ack with success shape but no hash", function () {
      const malformed = JSON.stringify({ id: "req-1", phase: "ack", ok: true, nonce: 1 });
      expect(() => decodeAck(malformed)).to.throw();
    });
  });

  describe("FinalMessage", function () {
    const successFinal: FinalMessage = {
      id: "req-1",
      phase: "final",
      ok: true,
      hash: "0xabc",
      receipt: {
        blockNumber: 100,
        blockHash: "0xblock",
        status: 1,
        gasUsed: "0x5208",
        effectiveGasPrice: "0x3b9aca00",
        logs: [{ address: "0xLog", topics: ["0xtopic"], data: "0xdata" }],
      },
    };

    it("round-trips a success final", function () {
      expect(decodeFinal(encodeFinal(successFinal))).to.deep.equal(successFinal);
    });

    it("round-trips a confirmation-timeout failure final", function () {
      const final: FinalMessage = {
        id: "req-1",
        phase: "final",
        ok: false,
        hash: "0xabc",
        reason: "confirmation",
        error: "timeout",
      };
      expect(decodeFinal(encodeFinal(final))).to.deep.equal(final);
    });

    it("round-trips a revert failure with no hash", function () {
      // hash is optional; verify a payload without it decodes cleanly.
      const raw = '{"id":"req-1","phase":"final","ok":false,"reason":"reverted","error":"status=0"}';
      const decoded = decodeFinal(raw);
      expect(decoded.id).to.equal("req-1");
      expect(decoded.ok).to.equal(false);
      if (decoded.ok === false) {
        expect(decoded.reason).to.equal("reverted");
        expect(decoded.hash).to.equal(undefined);
      }
    });

    it("rejects a receipt with status outside {0,1}", function () {
      const malformed = JSON.stringify({
        ...successFinal,
        receipt: { ...successFinal.receipt, status: 2 },
      });
      expect(() => decodeFinal(malformed)).to.throw();
    });
  });

  describe("decodeResponse", function () {
    it("decodes an ack payload", function () {
      const ack: ResponseMessage = { id: "x", phase: "ack", ok: true, hash: "0x1", nonce: 0 };
      expect(decodeResponse(JSON.stringify(ack))).to.deep.equal(ack);
    });

    it("decodes a final payload", function () {
      const raw = '{"id":"x","phase":"final","ok":false,"reason":"confirmation","error":"timeout"}';
      const decoded = decodeResponse(raw);
      expect(decoded.phase).to.equal("final");
      expect(decoded.ok).to.equal(false);
    });

    it("rejects a payload that matches neither variant", function () {
      const malformed = JSON.stringify({ id: "x", phase: "other" });
      expect(() => decodeResponse(malformed)).to.throw();
    });
  });
});
