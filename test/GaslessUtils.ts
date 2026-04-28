import { expect } from "./utils";
import { Contract, ethers } from "ethers";
import {
  appendCalldataSegments,
  restructureGaslessDeposits,
  buildGaslessDepositTx,
  buildSwapAndBridgeDepositTx,
} from "../src/utils/GaslessUtils";
import {
  APIGaslessDepositResponse,
  type GaslessDepositMessage,
  type SwapAndBridgeGaslessDepositMessage,
} from "../src/interfaces";
import SPOKE_POOL_PERIPHERY_ABI from "../src/common/abi/SpokePoolPeriphery.json";

// Minimal valid 65-byte signature (hex)
const DUMMY_SIGNATURE = "0x" + "ab".repeat(65);

const DUMMY_ADDRESS = "0x" + "11".repeat(20);
const DUMMY_BYTES32 = "0x" + "22".repeat(32);

function makeDepositMessage(overrides: Record<string, unknown> = {}): GaslessDepositMessage {
  return {
    depositFlowType: "bridge",
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
  describe("appendCalldataSegments", function () {
    it("concatenates base calldata with hex segments in order", function () {
      const result = appendCalldataSegments("0xdeadbeef", ["0x1dc0de", "0xABCD"]);
      expect(result).to.equal("0xdeadbeef1dc0deabcd");
    });

    it("accepts segments without 0x prefix", function () {
      const result = appendCalldataSegments("0xaa", ["1dc0de", "FFEE"]);
      expect(result).to.equal("0xaa1dc0deffee");
    });

    it("throws for invalid hex segment", function () {
      expect(() => appendCalldataSegments("0xaa", ["0xZZ"])).to.throw("invalid hex segment");
    });

    it("throws for empty segment", function () {
      expect(() => appendCalldataSegments("0xaa", ["0xabcd", ""])).to.throw("empty segment");
    });
  });

  describe("integrator deposit calldata (invalid integratorId)", function () {
    it("throws when integratorId is not exactly 2 bytes", function () {
      const msg = makeDepositMessage({ integratorId: "0xAB" });
      const contract = makeSpokePoolPeripheryContract();
      expect(() => buildGaslessDepositTx(msg, contract)).to.throw("2 bytes");
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = buildGaslessDepositTx(msg, contract);
      expect(tx.method).to.equal("depositWithAuthorization");
      expect(tx.args.length).to.equal(5);
      expect(tx.ensureConfirmation).to.be.true;
    });

    it("returns raw tx with tagged calldata when integratorId is present", function () {
      const msg = makeDepositMessage({ integratorId: "0xABCD" });
      const contract = makeSpokePoolPeripheryContract();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = buildGaslessDepositTx(msg, contract);
      expect(tx.method).to.equal("");
      expect(tx.args.length).to.equal(1);
      const calldata = tx.args[0] as string;
      // Calldata should end with delimiter + integratorId + swap API marker
      expect(calldata.toLowerCase()).to.match(/1dc0deabcd73c0de$/);
      expect(tx.ensureConfirmation).to.be.true;
    });

    it("swap-and-bridge + integratorId returns raw tx with integrator + swap API suffix", function () {
      const depositData = {
        inputToken: DUMMY_ADDRESS,
        outputToken: DUMMY_BYTES32,
        outputAmount: "900000",
        depositor: DUMMY_ADDRESS,
        recipient: DUMMY_BYTES32,
        destinationChainId: 10,
        exclusiveRelayer: DUMMY_BYTES32,
        quoteTimestamp: 1700000000,
        fillDeadline: 1700003600,
        exclusivityDeadline: 0,
        exclusivityParameter: 0,
        message: "0x",
      };
      const msg: SwapAndBridgeGaslessDepositMessage = {
        depositFlowType: "swapAndBridge",
        originChainId: 1,
        depositId: "1",
        requestId: "req-1",
        signature: DUMMY_SIGNATURE,
        permitType: "permit2",
        permit: {
          types: { PermitWitnessTransferFrom: [] },
          domain: { name: "Permit2", chainId: 1, verifyingContract: DUMMY_ADDRESS },
          primaryType: "PermitWitnessTransferFrom",
          message: {
            permitted: { token: DUMMY_ADDRESS, amount: "1000000" },
            spender: DUMMY_ADDRESS,
            nonce: "0",
            deadline: 999999999999,
            witness: {
              submissionFees: { amount: "100", recipient: DUMMY_ADDRESS },
              depositData,
              swapToken: DUMMY_ADDRESS,
              exchange: DUMMY_ADDRESS,
              transferType: 0,
              swapTokenAmount: "1000000",
              minExpectedInputTokenAmount: "1000000",
              routerCalldata: "0x",
              enableProportionalAdjustment: false,
              spokePool: DUMMY_ADDRESS,
              nonce: "1",
            },
          },
        },
        depositData,
        submissionFees: { amount: "100", recipient: DUMMY_ADDRESS },
        swapToken: DUMMY_ADDRESS,
        exchange: DUMMY_ADDRESS,
        transferType: 0,
        swapTokenAmount: "1000000",
        minExpectedInputTokenAmount: "1000000",
        routerCalldata: "0x",
        enableProportionalAdjustment: false,
        spokePool: DUMMY_ADDRESS,
        nonce: "1",
        integratorId: "0xABCD",
      };
      const contract = makeSpokePoolPeripheryContract();
      const tx = buildSwapAndBridgeDepositTx(msg, contract);
      expect(tx.method).to.equal("");
      const calldata = tx.args[0] as string;
      expect(calldata.toLowerCase()).to.match(/1dc0deabcd73c0de$/);
    });

    it("raw tx calldata starts with the depositWithAuthorization selector", function () {
      const msg = makeDepositMessage({ integratorId: "0x0001" });
      const contract = makeSpokePoolPeripheryContract();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = buildGaslessDepositTx(msg, contract);
      const calldata = tx.args[0] as string;
      // First 4 bytes = function selector for depositWithAuthorization
      const iface = new ethers.utils.Interface(SPOKE_POOL_PERIPHERY_ABI);
      const selector = iface.getSighash("depositWithAuthorization");
      expect(calldata.startsWith(selector)).to.be.true;
    });
  });
});
