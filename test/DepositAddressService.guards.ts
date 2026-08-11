import { expect } from "./utils";
import { CHAIN_IDs } from "../src/utils";
import { DepositAddressExecuteResponse } from "../src/clients/AcrossSwapApiClient";
import { DepositAddressMessageV3 } from "../src/interfaces/DepositAddress";
import {
  assertIntegratorId,
  assertSupportedNamespace,
  assertSupportedOriginChain,
  assertValidExecuteResponse,
} from "../src/deposit-address-service/guards";
import {
  InvalidExecuteResponseError,
  InvalidIntegratorIdError,
  UnsupportedNamespaceError,
  UnsupportedOriginChainError,
} from "../src/deposit-address-service/errors";

/**
 * Guard-for-guard parity with `initiateDepositV3` and `_validateExecuteResponse`, tested with no Express, no
 * Redis and no provider — which is the point of keeping these pure.
 */
const ARBITRUM = CHAIN_IDs.ARBITRUM;
const DEPOSIT_ADDRESS = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
const NOW_SECONDS = 1_800_000_000;

function message(over: Partial<DepositAddressMessageV3> = {}): DepositAddressMessageV3 {
  return {
    depositAddress: DEPOSIT_ADDRESS,
    version: 3,
    depositAddressNamespace: "evm",
    refundAddress: { namespace: "evm", address: "0x9A6e5F1B8C7D0E3a2b4c5D6e7F8A9b0c1D2E3f40" },
    routeParams: {
      outputToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      destinationChainId: "8453",
      recipient: { namespace: "evm", address: "0x9A6e5F1B8C7D0E3a2b4c5D6e7F8A9b0c1D2E3f40" },
    },
    erc20Transfer: {
      chainId: String(ARBITRUM),
      blockNumber: 312884201,
      logIndex: 7,
      from: "0x9A6e5F1B8C7D0E3a2b4c5D6e7F8A9b0c1D2E3f40",
      to: DEPOSIT_ADDRESS,
      amount: "10000000",
      contractAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      transactionHash: "0xa3f1c7d40e9b6852f1ad0c3b7e94f628a1d5c09e3b7a2d8f4c6e1b0a9d8c7f6e5",
      transferClassification: "correct_transfer",
    },
    integrator: { name: "test", integratorId: "0x1dc0" },
    ...over,
  } as DepositAddressMessageV3;
}

function response(over: Partial<DepositAddressExecuteResponse> = {}): DepositAddressExecuteResponse {
  return {
    depositAddress: DEPOSIT_ADDRESS,
    executeTx: {
      ecosystem: "evm",
      chainId: ARBITRUM,
      to: "0x0000000000000000000000000000000000000ca1",
      data: "0xdeadbeef",
      value: "0",
    },
    signer: "0x9A6e5F1B8C7D0E3a2b4c5D6e7F8A9b0c1D2E3f40",
    signatureDeadline: NOW_SECONDS + 600,
    isPlaceholder: false,
    ...over,
  };
}

describe("DepositAddressService guards", function () {
  describe("assertSupportedOriginChain", function () {
    it("passes an enabled EVM chain", function () {
      expect(() => assertSupportedOriginChain([ARBITRUM, CHAIN_IDs.BASE], ARBITRUM)).to.not.throw();
    });

    it("rejects a chain that is not enabled", function () {
      expect(() => assertSupportedOriginChain([CHAIN_IDs.BASE], ARBITRUM)).to.throw(UnsupportedOriginChainError);
    });

    it("rejects a chain whose family has no v3 execute path", function () {
      // Solana is neither EVM nor TVM, so `expectedNamespaceForChain` has nothing to offer even if enabled.
      expect(() => assertSupportedOriginChain([CHAIN_IDs.SOLANA], CHAIN_IDs.SOLANA)).to.throw(
        UnsupportedOriginChainError
      );
    });
  });

  describe("assertSupportedNamespace", function () {
    it("passes matching evm namespaces on an EVM chain", function () {
      expect(() => assertSupportedNamespace(message(), ARBITRUM)).to.not.throw();
    });

    it("rejects a cross-family deposit-address namespace", function () {
      expect(() => assertSupportedNamespace(message({ depositAddressNamespace: "tron" }), ARBITRUM)).to.throw(
        UnsupportedNamespaceError
      );
    });

    // Both are checked, not just the first: the refund address is the execute endpoint's `userAddress`.
    it("rejects a cross-family refund-address namespace", function () {
      const mismatched = message({
        refundAddress: { namespace: "tron", address: "TQ5NMqJjW8sSjhWkrGheJHnWvpJPMdKMzn" },
      } as Partial<DepositAddressMessageV3>);
      expect(() => assertSupportedNamespace(mismatched, ARBITRUM)).to.throw(UnsupportedNamespaceError);
    });

    it("rejects a zksync namespace on a zkSync-family chain, matching the polling bot", function () {
      const zk = message({ depositAddressNamespace: "zksync" });
      expect(() => assertSupportedNamespace(zk, CHAIN_IDs.ZK_SYNC)).to.throw(UnsupportedNamespaceError);
    });
  });

  describe("assertIntegratorId", function () {
    it("returns a well-formed 2-byte id", function () {
      expect(assertIntegratorId(message())).to.equal("0x1dc0");
    });

    it("rejects an absent integrator projection", function () {
      expect(() => assertIntegratorId(message({ integrator: undefined }))).to.throw(InvalidIntegratorIdError);
    });

    it("rejects a null integratorId", function () {
      const noId = message({ integrator: { name: "test", integratorId: null } });
      expect(() => assertIntegratorId(noId)).to.throw(InvalidIntegratorIdError);
    });

    it("rejects a malformed integratorId", function () {
      // Wrong width is the dangerous case: it would derive a different, unfunded address rather than fail loudly.
      for (const integratorId of ["0x1dc", "0x1dc00", "1dc0", "0xzzzz"]) {
        const bad = message({ integrator: { name: "test", integratorId } });
        expect(() => assertIntegratorId(bad), integratorId).to.throw(InvalidIntegratorIdError);
      }
    });
  });

  describe("assertValidExecuteResponse", function () {
    it("passes a well-formed response", function () {
      expect(() => assertValidExecuteResponse(response(), message(), ARBITRUM, NOW_SECONDS)).to.not.throw();
    });

    it("rejects an API-derived deposit address that is not the funded one", function () {
      const other = response({ depositAddress: "0x00000000000000000000000000000000000000ff" });
      expect(() => assertValidExecuteResponse(other, message(), ARBITRUM, NOW_SECONDS)).to.throw(
        InvalidExecuteResponseError
      );
    });

    it("accepts a differently-cased address for the same funded address", function () {
      const lowered = response({ depositAddress: DEPOSIT_ADDRESS.toLowerCase() });
      expect(() => assertValidExecuteResponse(lowered, message(), ARBITRUM, NOW_SECONDS)).to.not.throw();
    });

    it("rejects an execute tx for a different chain", function () {
      const wrongChain = response({ executeTx: { ...response().executeTx, chainId: CHAIN_IDs.BASE } });
      expect(() => assertValidExecuteResponse(wrongChain, message(), ARBITRUM, NOW_SECONDS)).to.throw(
        InvalidExecuteResponseError
      );
    });

    it("rejects an ecosystem that does not match the origin chain family", function () {
      const tvm = response({ executeTx: { ...response().executeTx, ecosystem: "tvm" } });
      expect(() => assertValidExecuteResponse(tvm, message(), ARBITRUM, NOW_SECONDS)).to.throw(
        InvalidExecuteResponseError
      );
    });

    it("rejects a placeholder derivation", function () {
      expect(() => assertValidExecuteResponse(response({ isPlaceholder: true }), message(), ARBITRUM, NOW_SECONDS))
        .to.throw(InvalidExecuteResponseError)
        .with.property("code", "INVALID_EXECUTE_RESPONSE");
    });

    it("rejects a signature deadline inside the buffer", function () {
      const nearlyExpired = response({ signatureDeadline: NOW_SECONDS + 59 });
      expect(() => assertValidExecuteResponse(nearlyExpired, message(), ARBITRUM, NOW_SECONDS)).to.throw(
        InvalidExecuteResponseError
      );
    });

    it("accepts a signature deadline exactly at the buffer", function () {
      const atBoundary = response({ signatureDeadline: NOW_SECONDS + 60 });
      expect(() => assertValidExecuteResponse(atBoundary, message(), ARBITRUM, NOW_SECONDS)).to.not.throw();
    });

    // A perishable response must NACK, not ACK: a fresh one next delivery may well pass.
    it("makes execute-response failures retriable", function () {
      expect(new InvalidExecuteResponseError("x").retriable).to.equal(true);
    });
  });

  describe("disposition of the deterministic guards", function () {
    it("ACKs every guard whose outcome a retry cannot change", function () {
      expect(new UnsupportedOriginChainError("x").retriable).to.equal(false);
      expect(new UnsupportedNamespaceError("x").retriable).to.equal(false);
      expect(new InvalidIntegratorIdError("x").retriable).to.equal(false);
    });
  });
});
