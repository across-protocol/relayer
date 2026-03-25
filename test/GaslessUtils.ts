import { expect } from "./utils";
import { Contract, ethers } from "ethers";
import { tagIntegratorId, restructureGaslessDeposits, buildGaslessDepositTx } from "../src/utils/GaslessUtils";
import { APIGaslessDepositResponse } from "../src/interfaces";
import SPOKE_POOL_PERIPHERY_ABI from "../src/common/abi/SpokePoolPeriphery.json";

// Minimal valid 65-byte signature (hex)
const DUMMY_SIGNATURE = "0x" + "ab".repeat(65);

const DUMMY_ADDRESS = "0x" + "11".repeat(20);
const DUMMY_BYTES32 = "0x" + "22".repeat(32);

function makeDepositMessage(overrides: Record<string, unknown> = {}) {
  return {
    originChainId: 1,
    depositId: "1",
    requestId: "req-1",
    signature: DUMMY_SIGNATURE,
    permitType: "receiveWithAuthorization",
    permit: {
      types: { ReceiveWithAuthorization: [] },
      domain: { name: "USDC", version: "2", chainId: 1, verifyingContract: DUMMY_ADDRESS },
      primaryType: "ReceiveWithAuthorization",
      message: {
        from: DUMMY_ADDRESS,
        to: DUMMY_ADDRESS,
        value: "1000000",
        validAfter: 0,
        validBefore: 999999999999,
        nonce: "0x" + "00".repeat(32),
      },
    },
    inputAmount: "1000000",
    baseDepositData: {
      inputToken: DUMMY_ADDRESS,
      outputToken: DUMMY_ADDRESS,
      inputAmount: "1000000",
      outputAmount: "900000",
      depositor: DUMMY_ADDRESS,
      recipient: DUMMY_ADDRESS,
      destinationChainId: 10,
      exclusiveRelayer: DUMMY_ADDRESS,
      quoteTimestamp: 1700000000,
      fillDeadline: 1700003600,
      exclusivityDeadline: 0,
      exclusivityParameter: 0,
      message: "0x",
    },
    submissionFees: { amount: "100", recipient: DUMMY_ADDRESS },
    spokePool: DUMMY_ADDRESS,
    nonce: "1",
    ...overrides,
  };
}

function makeApiResponse(overrides: { integratorId?: string } = {}): APIGaslessDepositResponse {
  const msg = makeDepositMessage();
  return {
    swapTx: {
      ecosystem: "evm",
      chainId: msg.originChainId,
      to: DUMMY_ADDRESS,
      data: {
        type: "BridgeWitness",
        depositId: msg.depositId,
        witness: {
          BridgeWitness: {
            type: "BridgeWitness",
            data: {
              inputAmount: msg.inputAmount,
              baseDepositData: msg.baseDepositData,
              submissionFees: msg.submissionFees,
              spokePool: msg.spokePool,
              nonce: msg.nonce,
            },
          },
        },
        permit: msg.permit,
        domainSeparator: DUMMY_BYTES32,
        integratorId: overrides.integratorId,
      },
    },
    signature: msg.signature,
    submittedAt: "2024-01-01T00:00:00Z",
    requestId: msg.requestId,
    messageId: "msg-1",
  };
}

function makeSpokePoolPeripheryContract(): Contract {
  return new Contract(DUMMY_ADDRESS, SPOKE_POOL_PERIPHERY_ABI);
}

describe("GaslessUtils", function () {
  describe("tagIntegratorId", function () {
    it("appends delimiter and integratorId to calldata", function () {
      const txData = "0xdeadbeef";
      const integratorId = "0xABCD";
      const result = tagIntegratorId(txData, integratorId);
      // Expected: [txData][0x1dc0de][0xABCD]
      expect(result).to.equal("0xdeadbeef1dc0deabcd");
    });

    it("handles integratorId without 0x prefix", function () {
      const result = tagIntegratorId("0xaa", "FFEE");
      expect(result).to.equal("0xaa1dc0deffee");
    });

    it("throws for integratorId that is not exactly 2 bytes", function () {
      expect(() => tagIntegratorId("0xaa", "0xAB")).to.throw("2 bytes");
      expect(() => tagIntegratorId("0xaa", "0xABCDEF")).to.throw("2 bytes");
      expect(() => tagIntegratorId("0xaa", "")).to.throw("2 bytes");
    });

    it("throws for non-hex integratorId", function () {
      expect(() => tagIntegratorId("0xaa", "0xGGHH")).to.throw("2 bytes");
    });
  });

  describe("restructureGaslessDeposits", function () {
    it("propagates integratorId when present", function () {
      const apiResponse = makeApiResponse({ integratorId: "0xABCD" });
      const [result] = restructureGaslessDeposits([apiResponse]);
      expect(result.integratorId).to.equal("0xABCD");
    });

    it("sets integratorId to undefined when absent", function () {
      const apiResponse = makeApiResponse();
      const [result] = restructureGaslessDeposits([apiResponse]);
      expect(result.integratorId).to.be.undefined;
    });
  });

  describe("buildGaslessDepositTx", function () {
    it("returns named method tx when no integratorId", function () {
      const msg = makeDepositMessage();
      const contract = makeSpokePoolPeripheryContract();
      const tx = buildGaslessDepositTx(msg as any, contract);
      expect(tx.method).to.equal("depositWithAuthorization");
      expect(tx.args.length).to.equal(5);
      expect(tx.ensureConfirmation).to.be.true;
    });

    it("returns raw tx with tagged calldata when integratorId is present", function () {
      const msg = makeDepositMessage({ integratorId: "0xABCD" });
      const contract = makeSpokePoolPeripheryContract();
      const tx = buildGaslessDepositTx(msg as any, contract);
      expect(tx.method).to.equal("");
      expect(tx.args.length).to.equal(1);
      const calldata = tx.args[0] as string;
      // Calldata should end with delimiter + integratorId
      expect(calldata.toLowerCase()).to.match(/1dc0deabcd$/);
      expect(tx.ensureConfirmation).to.be.true;
    });

    it("raw tx calldata starts with the depositWithAuthorization selector", function () {
      const msg = makeDepositMessage({ integratorId: "0x0001" });
      const contract = makeSpokePoolPeripheryContract();
      const tx = buildGaslessDepositTx(msg as any, contract);
      const calldata = tx.args[0] as string;
      // First 4 bytes = function selector for depositWithAuthorization
      const iface = new ethers.utils.Interface(SPOKE_POOL_PERIPHERY_ABI);
      const selector = iface.getSighash("depositWithAuthorization");
      expect(calldata.startsWith(selector)).to.be.true;
    });
  });
});
