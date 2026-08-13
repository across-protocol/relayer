import { expect, sinon, winston, smock, ethers } from "./utils";
import { Contract } from "ethers";
import {
  tagIntegratorId,
  normalizeIntegratorId,
  restructureGaslessDeposits,
  buildGaslessDepositTx,
  findGaslessSubmitBlocker,
  getGaslessAuthorizationWindow,
  getLegacySpokePoolPeripheryAddresses,
  isErc2612PermitNonceConsumed,
  isErc3009AuthorizationUsed,
  resolveTokenInfoForLog,
} from "../src/utils/GaslessUtils";
import { CHAIN_IDs, toAddressType, getTokenInfo } from "../src/utils";
import { APIGaslessDepositResponse } from "../src/interfaces";
import SPOKE_POOL_PERIPHERY_ABI from "../src/common/abi/SpokePoolPeriphery.json";

// Minimal valid 65-byte signature (hex)
const DUMMY_SIGNATURE = "0x" + "ab".repeat(65);
// >65 bytes — smart-wallet (EIP-1271 / ERC-6492) shape, routed to the *Bytes periphery methods.
const SMART_WALLET_SIGNATURE = "0x" + "ab".repeat(65) + "cd".repeat(32);

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

function makeSwapAndBridgeErc3009Message(signature: string) {
  const bridge = makeDepositMessage({ signature });
  return {
    ...bridge,
    depositFlowType: "swapAndBridge",
    depositData: bridge.baseDepositData,
    swapToken: DUMMY_ADDRESS,
    exchange: DUMMY_ADDRESS,
    transferType: 0,
    swapTokenAmount: "123",
    minExpectedInputTokenAmount: "120",
    routerCalldata: "0x",
    enableProportionalAdjustment: true,
  };
}

describe("GaslessUtils", function () {
  describe("normalizeIntegratorId", function () {
    it("normalizes prefixed and unprefixed IDs to lowercase 0x form", function () {
      expect(normalizeIntegratorId("0xABCD")).to.equal("0xabcd");
      expect(normalizeIntegratorId("abcd")).to.equal("0xabcd");
      expect(normalizeIntegratorId("DEAD")).to.equal("0xdead");
      expect(normalizeIntegratorId("0XDeAd")).to.equal("0xdead");
    });

    it("returns undefined for invalid IDs", function () {
      expect(normalizeIntegratorId("0xAB")).to.equal(undefined);
      expect(normalizeIntegratorId("0xABCDEF")).to.equal(undefined);
      expect(normalizeIntegratorId("0xGGHH")).to.equal(undefined);
      expect(normalizeIntegratorId("")).to.equal(undefined);
    });
  });

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

    it("carries the periphery target (swapTx.to) through to the flattened message", function () {
      const apiResponse = makeApiResponse();
      const [result] = restructureGaslessDeposits([apiResponse], TEST_LOGGER);
      expect(result.targetAddress).to.equal(DUMMY_ADDRESS);
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
      expect(result.targetAddress).to.equal(DUMMY_ADDRESS);
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

  describe("getLegacySpokePoolPeripheryAddresses", function () {
    it("returns the shared previous-generation deploy for standard EVM chains", function () {
      for (const chainId of [CHAIN_IDs.MAINNET, CHAIN_IDs.BASE, CHAIN_IDs.ARBITRUM, CHAIN_IDs.POLYGON]) {
        expect(getLegacySpokePoolPeripheryAddresses(chainId)).to.deep.equal([
          "0x10D8b8DaA26d307489803e10477De69C0492B610",
        ]);
      }
    });

    it("returns the per-cohort deploys for exception chains", function () {
      for (const chainId of [CHAIN_IDs.AVALANCHE, CHAIN_IDs.ROBINHOOD]) {
        expect(getLegacySpokePoolPeripheryAddresses(chainId)).to.deep.equal([
          "0xe05E3798Ce2ae9afCb637fb53BF5a51253BBe2af",
        ]);
      }
      for (const chainId of [CHAIN_IDs.LENS, CHAIN_IDs.ZK_SYNC]) {
        expect(getLegacySpokePoolPeripheryAddresses(chainId)).to.deep.equal([
          "0x5a148a9260c1f670429361c34d40b477280f01a9",
        ]);
      }
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

    it("routes a smart-wallet (>65-byte) signature to depositWithAuthorizationBytes", function () {
      const msg = makeDepositMessage({ signature: SMART_WALLET_SIGNATURE });
      const contract = makeSpokePoolPeripheryContract();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = buildGaslessDepositTx(msg as any, contract);
      expect(tx.method).to.equal("depositWithAuthorizationBytes");
      expect(tx.args.length).to.equal(5);
      expect(tx.args[4]).to.equal(SMART_WALLET_SIGNATURE);
    });

    it("tagged calldata uses the depositWithAuthorizationBytes selector for smart-wallet signatures", function () {
      const msg = makeDepositMessage({ signature: SMART_WALLET_SIGNATURE, integratorId: "0x0001" });
      const contract = makeSpokePoolPeripheryContract();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = buildGaslessDepositTx(msg as any, contract);
      const calldata = tx.args[0] as string;
      const iface = new ethers.utils.Interface(SPOKE_POOL_PERIPHERY_ABI);
      expect(calldata.startsWith(iface.getSighash("depositWithAuthorizationBytes"))).to.be.true;
    });

    it("routes swapAndBridge erc3009 with a smart-wallet signature to swapAndBridgeWithAuthorizationBytes", function () {
      const msg = makeSwapAndBridgeErc3009Message(SMART_WALLET_SIGNATURE);
      const contract = makeSpokePoolPeripheryContract();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = buildGaslessDepositTx(msg as any, contract);
      expect(tx.method).to.equal("swapAndBridgeWithAuthorizationBytes");
      expect(tx.args.length).to.equal(5);
    });

    it("keeps swapAndBridge erc3009 with a 65-byte signature on swapAndBridgeWithAuthorization", function () {
      const msg = makeSwapAndBridgeErc3009Message(DUMMY_SIGNATURE);
      const contract = makeSpokePoolPeripheryContract();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = buildGaslessDepositTx(msg as any, contract);
      expect(tx.method).to.equal("swapAndBridgeWithAuthorization");
    });

    it("throws for a signature shorter than 65 bytes", function () {
      const msg = makeDepositMessage({ signature: "0x" + "ab".repeat(64) });
      const contract = makeSpokePoolPeripheryContract();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => buildGaslessDepositTx(msg as any, contract)).to.throw(/at least 65 bytes/);
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

  describe("isErc2612PermitNonceConsumed (SpokePoolPeriphery.permitNonces)", function () {
    it("returns false when permitNonces equals signed nonce", async function () {
      const fake = await smock.fake(["function permitNonces(address user) view returns (uint256)"]);
      fake.permitNonces.returns(ethers.BigNumber.from(3));
      expect(
        await isErc2612PermitNonceConsumed({
          spokePoolPeriphery: fake as unknown as Contract,
          owner: DUMMY_ADDRESS,
          signedNonce: "3",
        })
      ).to.be.false;
    });

    it("returns true when permitNonces exceeds signed nonce", async function () {
      const fake = await smock.fake(["function permitNonces(address user) view returns (uint256)"]);
      fake.permitNonces.returns(ethers.BigNumber.from(4));
      expect(
        await isErc2612PermitNonceConsumed({
          spokePoolPeriphery: fake as unknown as Contract,
          owner: DUMMY_ADDRESS,
          signedNonce: "3",
        })
      ).to.be.true;
    });
  });
});

describe("GaslessUtils#resolveTokenInfoForLog", function () {
  const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const LONG_TAIL_TOKEN = DUMMY_ADDRESS; // not present in the static TOKEN_SYMBOLS_MAP

  it("returns static token info without probing when the token is in the map", async function () {
    const token = toAddressType(USDC_MAINNET, 1);
    // Throws loudly here if the hardcoded address ever drifts from the SDK map.
    const expected = getTokenInfo(token, 1);
    let probed = false;

    const info = await resolveTokenInfoForLog(token, 1, TEST_LOGGER, {
      probeOnChain: async () => {
        probed = true;
        return { symbol: "SHOULD_NOT_BE_USED", decimals: 0 };
      },
    });

    expect(info).to.deep.equal({ symbol: expected.symbol, decimals: expected.decimals });
    expect(probed).to.equal(false);
  });

  it("probes on-chain and caches the result when the token is missing from the static map (ACB-552)", async function () {
    const token = toAddressType(LONG_TAIL_TOKEN, 1);
    const address = token.toNative();
    const setCalls: Array<[string, string]> = [];
    const cache = {
      get: async () => null,
      set: async (key: string, val: unknown) => {
        setCalls.push([key, String(val)]);
        return undefined;
      },
    };
    let probeCalls = 0;

    const info = await resolveTokenInfoForLog(token, 1, TEST_LOGGER, {
      redisCache: cache,
      probeOnChain: async () => {
        probeCalls++;
        return { symbol: "PEPE", decimals: 18 };
      },
    });

    expect(info).to.deep.equal({ symbol: "PEPE", decimals: 18 });
    expect(probeCalls).to.equal(1);
    expect(setCalls).to.have.length(1);
    expect(setCalls[0][0]).to.equal(`gasless:tokenInfo:1:${address}`);
    expect(JSON.parse(setCalls[0][1])).to.deep.equal({ symbol: "PEPE", decimals: 18 });
  });

  it("returns a cached entry without probing on a cache hit", async function () {
    const token = toAddressType(LONG_TAIL_TOKEN, 1);
    const cache = {
      get: async () => JSON.stringify({ symbol: "CACHED", decimals: 8 }),
      set: async () => undefined,
    };
    let probed = false;

    const info = await resolveTokenInfoForLog(token, 1, TEST_LOGGER, {
      redisCache: cache,
      probeOnChain: async () => {
        probed = true;
        return { symbol: "SHOULD_NOT_BE_USED", decimals: 0 };
      },
    });

    expect(info).to.deep.equal({ symbol: "CACHED", decimals: 8 });
    expect(probed).to.equal(false);
  });

  it("re-probes when a cached entry has decimals outside the ERC-20 uint8 range", async function () {
    const token = toAddressType(LONG_TAIL_TOKEN, 1);
    const address = token.toNative();
    const malformedEntries = [
      { symbol: "X", decimals: -1 },
      { symbol: "X", decimals: 1.5 },
      { symbol: "X", decimals: 256 },
      { symbol: "X", decimals: Number.POSITIVE_INFINITY },
      { symbol: "X", decimals: Number.NaN },
    ];

    for (const malformed of malformedEntries) {
      let probeCalls = 0;
      const setCalls: Array<[string, string]> = [];
      const cache = {
        get: async () => JSON.stringify(malformed),
        set: async (key: string, val: unknown) => {
          setCalls.push([key, String(val)]);
          return undefined;
        },
      };

      const info = await resolveTokenInfoForLog(token, 1, TEST_LOGGER, {
        redisCache: cache,
        probeOnChain: async () => {
          probeCalls++;
          return { symbol: "PEPE", decimals: 18 };
        },
      });

      expect(info).to.deep.equal({ symbol: "PEPE", decimals: 18 }, `malformed=${JSON.stringify(malformed)}`);
      expect(probeCalls).to.equal(1, `malformed=${JSON.stringify(malformed)}`);
      expect(setCalls).to.have.length(1);
      expect(setCalls[0][0]).to.equal(`gasless:tokenInfo:1:${address}`);
    }
  });

  it("falls back to a neutral placeholder and never throws when the on-chain probe fails", async function () {
    const token = toAddressType(LONG_TAIL_TOKEN, 1);
    const cache = { get: async () => null, set: async () => undefined };

    const info = await resolveTokenInfoForLog(token, 1, TEST_LOGGER, {
      redisCache: cache,
      probeOnChain: async () => {
        throw new Error("rpc down");
      },
    });

    expect(info).to.deep.equal({ symbol: "UNKNOWN", decimals: 18 });
  });
});

describe("GaslessUtils#getGaslessAuthorizationWindow", function () {
  it("reads validAfter/validBefore from an EIP-3009 authorization", function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = makeDepositMessage() as any;
    msg.permit.message.validAfter = 100;
    msg.permit.message.validBefore = 200;
    expect(getGaslessAuthorizationWindow(msg)).to.deep.equal({ validAfter: 100, validBefore: 200 });
  });

  it("maps the Permit2 deadline onto validBefore", function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = makeDepositMessage({ permitType: "permit2" }) as any;
    msg.permit.message = { nonce: DUMMY_BYTES32, deadline: 4242 };
    expect(getGaslessAuthorizationWindow(msg)).to.deep.equal({ validBefore: 4242 });
  });

  it("uses permitApprovalDeadline for the EIP-2612 swap-and-bridge flow", function () {
    const msg = {
      ...makeSwapAndBridgeErc3009Message(DUMMY_SIGNATURE),
      permitType: "permit",
      permitApprovalDeadline: 777,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getGaslessAuthorizationWindow(msg as any)).to.deep.equal({ validBefore: 777 });
  });

  it("returns an undefined window when the EIP-2612 flow carries no deadline", function () {
    const msg = { ...makeSwapAndBridgeErc3009Message(DUMMY_SIGNATURE), permitType: "permit" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getGaslessAuthorizationWindow(msg as any)).to.deep.equal({ validBefore: undefined });
  });
});

describe("GaslessUtils#isErc3009AuthorizationUsed", function () {
  const AUTH_STATE_ABI = ["function authorizationState(address,bytes32) view returns (bool)"];

  it("returns the on-chain authorizationState", async function () {
    for (const used of [true, false]) {
      const fake = await smock.fake(AUTH_STATE_ABI);
      fake.authorizationState.returns(used);
      expect(await isErc3009AuthorizationUsed(fake as unknown as Contract, DUMMY_ADDRESS, DUMMY_BYTES32)).to.equal(
        used
      );
    }
  });
});

describe("GaslessUtils#findGaslessSubmitBlocker", function () {
  const BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];
  const AUTH_STATE_ABI = ["function authorizationState(address,bytes32) view returns (bool)"];
  // makeDepositMessage signs over inputAmount = 1000000.
  const REQUIRED = 1000000;
  const NOW = 1000;

  // Valid window, unspent nonce: the checks fall through to the balance read.
  async function makeFakes(opts: { balance?: number; authUsed?: boolean } = {}) {
    const amountToken = await smock.fake(BALANCE_ABI);
    amountToken.balanceOf.returns(ethers.BigNumber.from(opts.balance ?? REQUIRED));
    const authToken = await smock.fake(AUTH_STATE_ABI);
    authToken.authorizationState.returns(opts.authUsed ?? false);
    return { amountToken: amountToken as unknown as Contract, authToken: authToken as unknown as Contract };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function inWindowMessage(overrides: Record<string, unknown> = {}): any {
    const msg = makeDepositMessage(overrides);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (msg as any).permit.message.validAfter = NOW - 100;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (msg as any).permit.message.validBefore = NOW + 100;
    return msg;
  }

  it("returns undefined when the deposit is fully submittable", async function () {
    const blocker = await findGaslessSubmitBlocker({
      depositMessage: inWindowMessage(),
      currentTime: NOW,
      ...(await makeFakes()),
    });
    expect(blocker).to.be.undefined;
  });

  it("reports insufficient-balance with the shortfall when the depositor is underfunded", async function () {
    const blocker = await findGaslessSubmitBlocker({
      depositMessage: inWindowMessage(),
      currentTime: NOW,
      ...(await makeFakes({ balance: 350000 })),
    });

    expect(blocker?.code).to.equal("insufficient-balance");
    // Recoverable: a top-up inside the authorization window still lands the deposit.
    expect(blocker?.permanent).to.be.false;
    expect(blocker?.context.balance).to.equal("350000");
    expect(blocker?.context.required).to.equal(String(REQUIRED));
    expect(blocker?.context.shortfall).to.equal("650000");
  });

  it("treats a balance exactly equal to the required amount as submittable", async function () {
    const blocker = await findGaslessSubmitBlocker({
      depositMessage: inWindowMessage(),
      currentTime: NOW,
      ...(await makeFakes({ balance: REQUIRED })),
    });
    expect(blocker).to.be.undefined;
  });

  it("reports authorization-expired as permanent, without reading balance", async function () {
    const fakes = await makeFakes();
    const msg = inWindowMessage();
    msg.permit.message.validBefore = NOW;

    const blocker = await findGaslessSubmitBlocker({ depositMessage: msg, currentTime: NOW, ...fakes });

    expect(blocker?.code).to.equal("authorization-expired");
    expect(blocker?.permanent).to.be.true;
    // Window check is free and conclusive, so no RPC is spent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((fakes.amountToken as any).balanceOf).to.have.callCount(0);
  });

  it("reports authorization-not-yet-valid as recoverable", async function () {
    const msg = inWindowMessage();
    msg.permit.message.validAfter = NOW + 1;

    const blocker = await findGaslessSubmitBlocker({
      depositMessage: msg,
      currentTime: NOW,
      ...(await makeFakes()),
    });

    expect(blocker?.code).to.equal("authorization-not-yet-valid");
    expect(blocker?.permanent).to.be.false;
  });

  it("reports authorization-consumed as permanent when the EIP-3009 nonce is already spent", async function () {
    const blocker = await findGaslessSubmitBlocker({
      depositMessage: inWindowMessage(),
      currentTime: NOW,
      ...(await makeFakes({ authUsed: true })),
    });

    expect(blocker?.code).to.equal("authorization-consumed");
    expect(blocker?.permanent).to.be.true;
  });

  it("reports authorization-consumed for a used Permit2 nonce", async function () {
    const msg = inWindowMessage({ permitType: "permit2" });
    msg.permit.message = { nonce: "0", deadline: NOW + 100 };
    const permit2 = await smock.fake(["function nonceBitmap(address,uint256) view returns (uint256)"]);
    permit2.nonceBitmap.returns(ethers.BigNumber.from(1)); // bit 0 set => nonce 0 used

    const blocker = await findGaslessSubmitBlocker({
      depositMessage: msg,
      currentTime: NOW,
      permit2: permit2 as unknown as Contract,
      ...(await makeFakes()),
    });

    expect(blocker?.code).to.equal("authorization-consumed");
    expect(blocker?.context.permitType).to.equal("permit2");
  });

  it("requires the signed permit value, which covers submission fees above the bridged amount", async function () {
    // inputAmount is 1000000 but the depositor signed over 1000100 to cover a 100-unit fee: a balance of
    // exactly inputAmount is still short, and comparing against inputAmount alone would miss it.
    const msg = inWindowMessage();
    msg.permit.message.value = "1000100";

    const blocker = await findGaslessSubmitBlocker({
      depositMessage: msg,
      currentTime: NOW,
      ...(await makeFakes({ balance: REQUIRED })),
    });

    expect(blocker?.code).to.equal("insufficient-balance");
    expect(blocker?.context.required).to.equal("1000100");
    expect(blocker?.context.shortfall).to.equal("100");
  });

  it("falls back to the witness swap amount for the EIP-2612 swap-and-bridge flow", async function () {
    // permitType "permit" carries no permit value, so swapTokenAmount (123) governs.
    const msg = { ...makeSwapAndBridgeErc3009Message(DUMMY_SIGNATURE), permitType: "permit" };
    const periphery = await smock.fake(["function permitNonces(address) view returns (uint256)"]);
    periphery.permitNonces.returns(ethers.BigNumber.from(0));

    const blocker = await findGaslessSubmitBlocker({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      depositMessage: msg as any,
      currentTime: NOW,
      spokePoolPeriphery: periphery as unknown as Contract,
      ...(await makeFakes({ balance: 100 })),
    });

    expect(blocker?.code).to.equal("insufficient-balance");
    expect(blocker?.context.required).to.equal("123");
    expect(blocker?.context.shortfall).to.equal("23");
  });

  it("returns undefined rather than throwing when an on-chain read fails", async function () {
    const amountToken = await smock.fake(BALANCE_ABI);
    amountToken.balanceOf.reverts();
    const authToken = await smock.fake(AUTH_STATE_ABI);
    authToken.authorizationState.returns(false);

    const blocker = await findGaslessSubmitBlocker({
      depositMessage: inWindowMessage(),
      currentTime: NOW,
      amountToken: amountToken as unknown as Contract,
      authToken: authToken as unknown as Contract,
    });

    expect(blocker).to.be.undefined;
  });

  it("skips the checks it has no contract for instead of throwing", async function () {
    // No amountToken / authToken: nothing conclusive to report, but must not throw.
    const blocker = await findGaslessSubmitBlocker({ depositMessage: inWindowMessage(), currentTime: NOW });
    expect(blocker).to.be.undefined;
  });
});
