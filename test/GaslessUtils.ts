import { expect, sinon, winston } from "./utils";
import { Contract, ethers } from "ethers";
import { tagIntegratorId, restructureGaslessDeposits, buildGaslessDepositTx } from "../src/utils/GaslessUtils";
import { APIGaslessDepositResponse } from "../src/interfaces";
import SPOKE_POOL_PERIPHERY_ABI from "../src/common/abi/SpokePoolPeriphery.json";

// Minimal valid 65-byte signature (hex)
const DUMMY_SIGNATURE = "0x" + "ab".repeat(65);

const DUMMY_ADDRESS = "0x" + "11".repeat(20);
const DUMMY_BYTES32 = "0x" + "22".repeat(32);
const TEST_LOGGER = winston.createLogger({ silent: true });

function makeDepositMessage(overrides: Record<string, unknown> = {}) {
  return {
    originChainId: 1,
    depositId: "1",
    requestId: "req-1",
    signature: DUMMY_SIGNATURE,
    permitType: "erc3009",
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

function makeApiResponse(overrides: { integratorId?: string; type?: string } = {}): APIGaslessDepositResponse {
  const msg = makeDepositMessage();
  return {
    swapTx: {
      ecosystem: "evm",
      chainId: msg.originChainId,
      to: DUMMY_ADDRESS,
      data: {
        type: overrides.type ?? "erc3009",
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
      const [result] = restructureGaslessDeposits([apiResponse], TEST_LOGGER);
      expect(result.integratorId).to.equal("0xABCD");
    });

    it("sets integratorId to undefined when absent", function () {
      const apiResponse = makeApiResponse();
      const [result] = restructureGaslessDeposits([apiResponse], TEST_LOGGER);
      expect(result.integratorId).to.be.undefined;
    });

    it("maps swapAndBridge permit payloads with permitApproval fields", function () {
      const apiResponse = {
        swapTx: {
          ecosystem: "evm",
          chainId: 42161,
          to: DUMMY_ADDRESS,
          typedData: null,
          data: {
            type: "permit",
            depositId: "77",
            witness: {
              BridgeAndSwapWitness: {
                type: "BridgeAndSwapWitness",
                data: {
                  submissionFees: { amount: "0", recipient: DUMMY_ADDRESS },
                  depositData: {
                    inputToken: DUMMY_ADDRESS,
                    outputToken: DUMMY_BYTES32,
                    outputAmount: "100",
                    depositor: DUMMY_ADDRESS,
                    recipient: DUMMY_BYTES32,
                    destinationChainId: 8453,
                    exclusiveRelayer: DUMMY_BYTES32,
                    quoteTimestamp: 1,
                    fillDeadline: 2,
                    exclusivityParameter: 0,
                    exclusivityDeadline: 0,
                    message: "0x",
                  },
                  swapToken: DUMMY_ADDRESS,
                  exchange: DUMMY_ADDRESS,
                  transferType: { long: 0 },
                  swapTokenAmount: "123",
                  minExpectedInputTokenAmount: "120",
                  routerCalldata: "0x",
                  enableProportionalAdjustment: { boolean: true },
                  spokePool: DUMMY_ADDRESS,
                  nonce: "4",
                },
              },
            },
            permit: {
              types: { SwapAndDepositData: [] },
              domain: { name: "ACROSS-PERIPHERY", version: "1.0.0", chainId: 42161, verifyingContract: DUMMY_ADDRESS },
              primaryType: "SwapAndDepositData",
              message: {
                submissionFees: { amount: "0", recipient: DUMMY_ADDRESS },
                depositData: {
                  inputToken: DUMMY_ADDRESS,
                  outputToken: DUMMY_BYTES32,
                  outputAmount: "100",
                  depositor: DUMMY_ADDRESS,
                  recipient: DUMMY_BYTES32,
                  destinationChainId: 8453,
                  exclusiveRelayer: DUMMY_BYTES32,
                  quoteTimestamp: 1,
                  fillDeadline: 2,
                  exclusivityParameter: 0,
                  message: "0x",
                },
                swapToken: DUMMY_ADDRESS,
                exchange: DUMMY_ADDRESS,
                transferType: 0,
                swapTokenAmount: "123",
                minExpectedInputTokenAmount: "120",
                routerCalldata: "0x",
                enableProportionalAdjustment: true,
                spokePool: DUMMY_ADDRESS,
                nonce: "4",
              },
            } as unknown as APIGaslessDepositResponse["swapTx"]["data"]["permit"],
            domainSeparator: DUMMY_BYTES32,
          },
        },
        signature: DUMMY_SIGNATURE,
        submittedAt: "2024-01-01T00:00:00Z",
        requestId: "req-swap",
        messageId: "msg-swap",
        permitApprovalSignature: DUMMY_SIGNATURE,
        permitApprovalDeadline: 123456,
      } as unknown as APIGaslessDepositResponse;
      const [result] = restructureGaslessDeposits([apiResponse], TEST_LOGGER);
      expect(result.depositFlowType).to.equal("swapAndBridge");
      expect(result.permitType).to.equal("permit");
      if (result.depositFlowType !== "swapAndBridge") {
        throw new Error("expected swapAndBridge result");
      }
      expect(result.permitApprovalSignature).to.equal(DUMMY_SIGNATURE);
      expect(result.permitApprovalDeadline).to.equal(123456);
    });

    it("skips deposits with unsupported permit type and logs warning", function () {
      const invalidApiResponse = makeApiResponse({ type: "BridgeWitness" });
      const warn = sinon.spy();
      const logger = { warn } as unknown as winston.Logger;

      const result = restructureGaslessDeposits([invalidApiResponse], logger);

      expect(result).to.deep.equal([]);
      expect(warn.calledOnce).to.be.true;
      expect(warn.firstCall.args[0]).to.include({
        at: "GaslessUtils#restructureGaslessDeposits",
        message: "Skipping gasless deposit with unsupported permit type.",
        permitType: "BridgeWitness",
      });
    });
  });

  describe("buildGaslessDepositTx", function () {
    it("returns named method tx when no integratorId", function () {
      const msg = makeDepositMessage();
      const contract = makeSpokePoolPeripheryContract();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = buildGaslessDepositTx(msg as any, contract);
      expect(tx.method).to.equal("depositWithAuthorization");
      expect(tx.args.length).to.equal(5);
      expect(tx.ensureConfirmation).to.be.true;
    });

    it("returns raw tx with tagged calldata when integratorId is present", function () {
      const msg = makeDepositMessage({ integratorId: "0xABCD" });
      const contract = makeSpokePoolPeripheryContract();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = buildGaslessDepositTx(msg as any, contract);
      const calldata = tx.args[0] as string;
      // First 4 bytes = function selector for depositWithAuthorization
      const iface = new ethers.utils.Interface(SPOKE_POOL_PERIPHERY_ABI);
      const selector = iface.getSighash("depositWithAuthorization");
      expect(calldata.startsWith(selector)).to.be.true;
    });

    it("builds swapAndBridgeWithPermit tx for permit flow", function () {
      const msg = {
        depositFlowType: "swapAndBridge",
        originChainId: 42161,
        depositId: "7",
        requestId: "req",
        signature: DUMMY_SIGNATURE,
        permitType: "permit",
        permitApprovalSignature: DUMMY_SIGNATURE,
        permitApprovalDeadline: 99999999,
        permit: {
          types: { SwapAndDepositData: [] },
          domain: { name: "ACROSS-PERIPHERY", version: "1.0.0", chainId: 42161, verifyingContract: DUMMY_ADDRESS },
          primaryType: "SwapAndDepositData",
          message: {
            submissionFees: { amount: "0", recipient: DUMMY_ADDRESS },
            depositData: {
              inputToken: DUMMY_ADDRESS,
              outputToken: DUMMY_BYTES32,
              outputAmount: "100",
              depositor: DUMMY_ADDRESS,
              recipient: DUMMY_BYTES32,
              destinationChainId: 8453,
              exclusiveRelayer: DUMMY_BYTES32,
              quoteTimestamp: 1,
              fillDeadline: 2,
              exclusivityParameter: 0,
              message: "0x",
            },
            swapToken: DUMMY_ADDRESS,
            exchange: DUMMY_ADDRESS,
            transferType: 0,
            swapTokenAmount: "123",
            minExpectedInputTokenAmount: "120",
            routerCalldata: "0x",
            enableProportionalAdjustment: true,
            spokePool: DUMMY_ADDRESS,
            nonce: "4",
          },
        },
        depositData: {
          inputToken: DUMMY_ADDRESS,
          outputToken: DUMMY_BYTES32,
          outputAmount: "100",
          depositor: DUMMY_ADDRESS,
          recipient: DUMMY_BYTES32,
          destinationChainId: 8453,
          exclusiveRelayer: DUMMY_BYTES32,
          quoteTimestamp: 1,
          fillDeadline: 2,
          exclusivityParameter: 0,
          exclusivityDeadline: 0,
          message: "0x",
        },
        submissionFees: { amount: "0", recipient: DUMMY_ADDRESS },
        swapToken: DUMMY_ADDRESS,
        exchange: DUMMY_ADDRESS,
        transferType: 0,
        swapTokenAmount: "123",
        minExpectedInputTokenAmount: "120",
        routerCalldata: "0x",
        enableProportionalAdjustment: true,
        spokePool: DUMMY_ADDRESS,
        nonce: "4",
      };
      const contract = makeSpokePoolPeripheryContract();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = buildGaslessDepositTx(msg as any, contract);
      expect(tx.method).to.equal("swapAndBridgeWithPermit");
      expect(tx.args.length).to.equal(5);
      expect(tx.ensureConfirmation).to.be.true;
    });
  });
});
