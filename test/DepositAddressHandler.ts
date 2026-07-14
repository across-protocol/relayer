import sinon from "sinon";
import { expect } from "chai";
import { EvmAddress, getCurrentTime, HttpError, Signer, winston } from "../src/utils";
import { DepositAddressMessage, DepositAddressMessageV3 } from "../src/interfaces/DepositAddress";
import { DepositAddressExecuteResponse, DepositAddressSignWithdrawResponse } from "../src/clients";
import { DepositAddressHandler } from "../src/deposit-address/DepositAddressHandler";
import { DepositAddressHandlerConfig } from "../src/deposit-address/DepositAddressHandlerConfig";

const SIGNER = "0x000000000000000000000000000000000000BEEF";
const DEPOSIT_ADDRESS = "0x000000000000000000000000000000000000C0DE";
const REFUND_ADDRESS = "0x0000000000000000000000000000000000002222";
const TOKEN = "0x000000000000000000000000000000000000DEAD";
const OUTPUT_TOKEN = "0x0000000000000000000000000000000000005678";
const RECIPIENT = "0x0000000000000000000000000000000000001111";
const IMPL = "0x000000000000000000000000000000000000A4A4";

// The 12 params the deposit-execute quote sent before executionFee support — the legacy request shape.
const BASE_PARAM_KEYS = [
  "originChainId",
  "destinationChainId",
  "inputToken",
  "outputToken",
  "tradeType",
  "amount",
  "depositor",
  "recipient",
  "refundAddress",
  "depositAddress",
  "executionFeeRecipient",
  "shouldSponsorAccountCreation",
];

/**
 * EVM-origin correct_transfer message; `materials` overrides the counterfactualMaterials leaves and
 * `integrator` overrides the optional integrator projection (omitted entirely when not provided).
 */
function depositMessage(
  materials: DepositAddressMessage["counterfactualMaterials"],
  integrator?: DepositAddressMessage["integrator"]
): DepositAddressMessage {
  return {
    ...(integrator !== undefined ? { integrator } : {}),
    depositAddress: DEPOSIT_ADDRESS,
    paramsHash: "0x" + "0".repeat(64),
    salt: "0x" + "0".repeat(64),
    counterfactualDepositContractAddress: "0x000000000000000000000000000000000000A1A1",
    counterfactualFactoryContractAddress: "0x000000000000000000000000000000000000A2A2",
    adminWithdrawManagerContractAddress: "0x000000000000000000000000000000000000A3A3",
    shouldSponsorAccountCreation: false,
    counterfactualMaterials: materials,
    routeParams: {
      inputToken: TOKEN,
      outputToken: OUTPUT_TOKEN,
      originChainId: "1",
      destinationChainId: "10",
      recipient: RECIPIENT,
      refundAddress: REFUND_ADDRESS,
    },
    erc20Transfer: {
      chainId: "1",
      blockNumber: 1_000_000,
      logIndex: 4,
      from: REFUND_ADDRESS,
      to: DEPOSIT_ADDRESS,
      amount: "5000",
      contractAddress: TOKEN,
      transactionHash: "0x" + "1".repeat(64),
      transferClassification: "correct_transfer",
    },
  };
}

const withdrawLeaf = {
  leafHash: "0x" + "0".repeat(64),
  merkleProof: [],
  encodedParams: "0x",
  implementationAddress: IMPL,
};

const WITHDRAW_IMPL = "0x000000000000000000000000000000000000B4B4";

/** v3 withdraw leaf as projected by the indexer (`kind === "withdraw"`). */
const v3WithdrawLeaf = {
  kind: "withdraw",
  implementationAddress: WITHDRAW_IMPL,
  encodedParams: "0x",
  leafHash: "0x" + "4".repeat(64),
  merkleProof: ["0x" + "5".repeat(64), "0x" + "6".repeat(64)],
};

/** v3 mis_route message carrying a withdraw leaf, ready for the refund-withdraw path. */
function withdrawMessageV3(overrides: Partial<DepositAddressMessageV3> = {}): DepositAddressMessageV3 {
  const message = depositMessageV3({
    counterfactualMaterials: [v3WithdrawLeaf],
    ...overrides,
  });
  message.erc20Transfer.transferClassification = "mis_route";
  return message;
}

/** v3 correct_transfer message mirroring the indexer's DepositAddressTransferItemV3 projection. */
function depositMessageV3(overrides: Partial<DepositAddressMessageV3> = {}): DepositAddressMessageV3 {
  return {
    depositAddress: DEPOSIT_ADDRESS,
    version: 3,
    salt: "0x" + "0".repeat(64),
    initialRoot: "0x" + "2".repeat(64),
    counterfactualBeaconContractAddress: "0x000000000000000000000000000000000000B1B1",
    counterfactualFactoryContractAddress: "0x000000000000000000000000000000000000B2B2",
    adminWithdrawManagerContractAddress: "0x000000000000000000000000000000000000B3B3",
    shouldSponsorAccountCreation: false,
    counterfactualMaterials: [
      {
        kind: "vanilla-cctp",
        implementationAddress: IMPL,
        encodedParams: "0x",
        leafHash: "0x" + "0".repeat(64),
        merkleProof: [],
      },
    ],
    routeParams: {
      outputToken: OUTPUT_TOKEN,
      destinationChainId: "1337",
      recipient: { namespace: "evm", address: RECIPIENT },
    },
    refundAddress: { namespace: "evm", address: REFUND_ADDRESS },
    depositAddressNamespace: "evm",
    integrator: { name: "test-integrator", integratorId: "0xdead" },
    erc20Transfer: {
      chainId: "42161",
      blockNumber: 1_000_000,
      logIndex: 4,
      from: REFUND_ADDRESS,
      to: DEPOSIT_ADDRESS,
      amount: "5000",
      contractAddress: TOKEN,
      transactionHash: "0x" + "3".repeat(64),
      transferClassification: "correct_transfer",
    },
    ...overrides,
  };
}

describe("DepositAddressHandler._getSwapApiQuote params", function () {
  let handler: DepositAddressHandler;
  let getStub: sinon.SinonStub;

  beforeEach(function () {
    const config = {} as unknown as DepositAddressHandlerConfig;
    handler = new DepositAddressHandler(undefined as unknown as winston.Logger, config, {} as unknown as Signer, []);
    // _signerAddress is normally set by initialize(); set it directly for this unit test.
    (handler as unknown as { _signerAddress: EvmAddress })._signerAddress = EvmAddress.from(SIGNER);
    // Replace the swap API client with a stub that captures the params and returns a successful quote.
    getStub = sinon.stub().resolves({ swapTx: { simulationSuccess: true, to: TOKEN, data: "0x", value: "0" } });
    (handler as unknown as { api: { getCounterfactualDepositQuote: sinon.SinonStub } }).api = {
      getCounterfactualDepositQuote: getStub,
    };
  });

  afterEach(() => sinon.restore());

  async function capturedParams(message: DepositAddressMessage): Promise<Record<string, unknown>> {
    await (handler as unknown as { _getSwapApiQuote: (m: DepositAddressMessage) => Promise<unknown> })._getSwapApiQuote(
      message
    );
    expect(getStub.calledOnce).to.equal(true);
    return getStub.firstCall.args[0] as Record<string, unknown>;
  }

  it("forwards both committed fees verbatim when both leaves carry params", async function () {
    const params = await capturedParams(
      depositMessage({
        withdrawLeaf,
        cctpLeaf: { ...withdrawLeaf, params: { executionFee: "777" } },
        spokePoolLeaf: { ...withdrawLeaf, params: { executionFee: "12345" } },
      })
    );
    expect(params.cctpExecutionFee).to.equal("777");
    expect(params.spokePoolExecutionFee).to.equal("12345");
  });

  it("leaves the fee param undefined for the leaves whose params are absent", async function () {
    const params = await capturedParams(
      depositMessage({ withdrawLeaf, spokePoolLeaf: { ...withdrawLeaf, params: { executionFee: "12345" } } })
    );
    // Undefined values are dropped at query-string serialization, so the absent leaf contributes no fee.
    expect(params.cctpExecutionFee).to.equal(undefined);
    expect(params.spokePoolExecutionFee).to.equal("12345");
  });

  it("leaves both fee params undefined when no fee leaves are present", async function () {
    const params = await capturedParams(depositMessage({ withdrawLeaf }));
    // No fee leaves => both fees undefined and dropped at serialization, yielding the legacy request shape.
    expect(params.cctpExecutionFee).to.equal(undefined);
    expect(params.spokePoolExecutionFee).to.equal(undefined);
    expect(BASE_PARAM_KEYS.every((key) => key in params)).to.equal(true);
  });

  it("forwards integratorId verbatim when the message carries one", async function () {
    const params = await capturedParams(
      depositMessage({ withdrawLeaf }, { name: "test-integrator", integratorId: "0x1234" })
    );
    expect(params.integratorId).to.equal("0x1234");
  });

  it("leaves integratorId undefined when the message has no integrator", async function () {
    const params = await capturedParams(depositMessage({ withdrawLeaf }));
    // Undefined is dropped at query-string serialization, so the request keeps its legacy shape.
    expect(params.integratorId).to.equal(undefined);
  });

  it("leaves integratorId undefined when the integrator id is null", async function () {
    const params = await capturedParams(
      depositMessage({ withdrawLeaf }, { name: "test-integrator", integratorId: null })
    );
    // `?? undefined` collapses an explicit null id so it too is dropped at serialization.
    expect(params.integratorId).to.equal(undefined);
  });
});

describe("DepositAddressHandler._queryIndexerApi version filtering", function () {
  let handler: DepositAddressHandler;
  let getStub: sinon.SinonStub;

  type Internals = { _queryIndexerApi: () => Promise<DepositAddressMessage[]> };

  beforeEach(function () {
    const config = {} as unknown as DepositAddressHandlerConfig;
    const logger = { debug: sinon.stub() } as unknown as winston.Logger;
    handler = new DepositAddressHandler(logger, config, {} as unknown as Signer, []);
    getStub = sinon.stub();
    (handler as unknown as { indexerApi: { get: sinon.SinonStub } }).indexerApi = { get: getStub };
  });

  afterEach(() => sinon.restore());

  async function query(messages: unknown[]): Promise<DepositAddressMessage[]> {
    getStub.resolves(messages);
    return (handler as unknown as Internals)._queryIndexerApi();
  }

  it("drops v2 messages and keeps v1 + legacy + v3 in the same batch", async function () {
    const v1 = { ...depositMessage({ withdrawLeaf }), version: 1 };
    const legacy = depositMessage({ withdrawLeaf });
    // v2 payloads do NOT carry the v1 shape — only v1/legacy messages should ever reach
    // normalizeDepositAddressMessage, so v2 must be filtered out before the map.
    const v2 = { version: 2, depositAddress: DEPOSIT_ADDRESS, paramsHash: "0x" + "0".repeat(64) };
    const v3 = depositMessageV3();

    const result = await query([v2, v1, v3, legacy]);

    expect(result).to.have.length(3);
    expect(result.map((m) => m.version)).to.deep.equal([1, 3, undefined]);
  });

  it("passes v3 messages through un-normalized", async function () {
    // normalizeDepositAddressMessage dereferences v1-only fields; a v3 item reaching it would
    // throw. The v3 shape must be returned verbatim.
    const v3 = depositMessageV3();
    const result = await query([v3]);
    expect(result).to.deep.equal([v3]);
  });

  it("does not throw when a v2 message lacks the v1 shape", async function () {
    // A bare v2 payload would make normalizeDepositAddressMessage throw if it reached the map;
    // filtering before normalization must keep the poll alive.
    const result = await query([{ version: 2 }]);
    expect(result).to.deep.equal([]);
  });
});

describe("DepositAddressHandler.processExecution v3 routing", function () {
  let handler: DepositAddressHandler;
  let v3Stub: sinon.SinonStub;
  let v1Stub: sinon.SinonStub;
  let withdrawStub: sinon.SinonStub;
  let withdrawV3Stub: sinon.SinonStub;
  let logger: winston.Logger;

  type Internals = { processExecution: (m: unknown) => Promise<void> };

  beforeEach(function () {
    const config = {} as unknown as DepositAddressHandlerConfig;
    logger = { debug: sinon.stub() } as unknown as winston.Logger;
    handler = new DepositAddressHandler(logger, config, {} as unknown as Signer, []);
    v3Stub = sinon.stub().resolves();
    v1Stub = sinon.stub().resolves();
    withdrawStub = sinon.stub().resolves();
    withdrawV3Stub = sinon.stub().resolves();
    Object.assign(handler, {
      initiateDepositV3: v3Stub,
      initiateDeposit: v1Stub,
      initiateWithdraw: withdrawStub,
      initiateWithdrawV3: withdrawV3Stub,
    });
  });

  afterEach(() => sinon.restore());

  it("routes v3 correct_transfer to the v3 execute path", async function () {
    const message = depositMessageV3();
    await (handler as unknown as Internals).processExecution(message);
    expect(v3Stub.calledOnceWithExactly(message)).to.equal(true);
    expect(v1Stub.notCalled).to.equal(true);
    expect(withdrawStub.notCalled).to.equal(true);
    expect(withdrawV3Stub.notCalled).to.equal(true);
  });

  it("routes v3 mis_route to the v3 withdraw path", async function () {
    const message = depositMessageV3();
    message.erc20Transfer.transferClassification = "mis_route";
    await (handler as unknown as Internals).processExecution(message);
    expect(withdrawV3Stub.calledOnceWithExactly(message)).to.equal(true);
    expect(v3Stub.notCalled).to.equal(true);
    expect(v1Stub.notCalled).to.equal(true);
    expect(withdrawStub.notCalled).to.equal(true);
  });

  it("drops v3 intent_refund (not yet supported)", async function () {
    const message = depositMessageV3();
    message.erc20Transfer.transferClassification = "intent_refund";
    await (handler as unknown as Internals).processExecution(message);
    expect(v3Stub.notCalled).to.equal(true);
    expect(v1Stub.notCalled).to.equal(true);
    expect(withdrawStub.notCalled).to.equal(true);
    expect(withdrawV3Stub.notCalled).to.equal(true);
  });

  it("keeps routing v1 messages to the v1 paths", async function () {
    const deposit = depositMessage({ withdrawLeaf });
    await (handler as unknown as Internals).processExecution(deposit);
    expect(v1Stub.calledOnceWithExactly(deposit)).to.equal(true);

    const refund = depositMessage({ withdrawLeaf });
    refund.erc20Transfer.transferClassification = "mis_route";
    await (handler as unknown as Internals).processExecution(refund);
    expect(withdrawStub.calledOnceWithExactly(refund)).to.equal(true);
    expect(v3Stub.notCalled).to.equal(true);
    expect(withdrawV3Stub.notCalled).to.equal(true);
  });
});

describe("DepositAddressHandler._getExecuteTx request mapping", function () {
  let handler: DepositAddressHandler;
  let executeStub: sinon.SinonStub;

  type Internals = {
    _getExecuteTx: (m: DepositAddressMessageV3) => Promise<DepositAddressExecuteResponse | undefined>;
  };

  beforeEach(function () {
    const config = {} as unknown as DepositAddressHandlerConfig;
    handler = new DepositAddressHandler(undefined as unknown as winston.Logger, config, {} as unknown as Signer, []);
    // _signerAddress is normally set by initialize(); set it directly for this unit test.
    (handler as unknown as { _signerAddress: EvmAddress })._signerAddress = EvmAddress.from(SIGNER);
    executeStub = sinon.stub().resolves({ depositAddress: DEPOSIT_ADDRESS });
    (handler as unknown as { api: { executeDepositAddress: sinon.SinonStub } }).api = {
      executeDepositAddress: executeStub,
    };
  });

  afterEach(() => sinon.restore());

  it("relays funding context and integratorId, with executionFee omitted", async function () {
    await (handler as unknown as Internals)._getExecuteTx(depositMessageV3());
    expect(executeStub.calledOnce).to.equal(true);
    // Exact request body with all execute feature flags off (the default / production shape): the
    // execute endpoint re-derives the address/materials from this identity, and its superstruct
    // schema rejects unknown or missing keys. Neither `inputToken` nor `erc20Transfer` is sent.
    expect(executeStub.firstCall.args[0]).to.deep.equal({
      destination: {
        token: { chainId: 1337, address: OUTPUT_TOKEN },
        recipient: RECIPIENT,
      },
      originChainId: 42161,
      userAddress: REFUND_ADDRESS,
      amount: "5000",
      executionFeeRecipient: SIGNER,
      integratorId: "0xdead",
    });
  });

  it("relays erc20Transfer provenance when ENABLE_EXECUTE_ERC20_TRANSFER is on", async function () {
    (handler as unknown as { config: { enableExecuteErc20Transfer: boolean } }).config.enableExecuteErc20Transfer =
      true;
    await (handler as unknown as Internals)._getExecuteTx(depositMessageV3());
    expect(executeStub.calledOnce).to.equal(true);
    expect(executeStub.firstCall.args[0]).to.deep.equal({
      destination: {
        token: { chainId: 1337, address: OUTPUT_TOKEN },
        recipient: RECIPIENT,
      },
      originChainId: 42161,
      userAddress: REFUND_ADDRESS,
      amount: "5000",
      executionFeeRecipient: SIGNER,
      integratorId: "0xdead",
      // chainId coerced from the fixture's "42161" string; Number() is a no-op on a numeric value.
      erc20Transfer: {
        chainId: 42161,
        blockNumber: 1_000_000,
        transactionHash: "0x" + "3".repeat(64),
        logIndex: 4,
      },
    });
  });

  it("relays the funding token as inputToken when ENABLE_EXECUTE_INPUT_TOKEN is on", async function () {
    (handler as unknown as { config: { enableExecuteInputToken: boolean } }).config.enableExecuteInputToken = true;
    await (handler as unknown as Internals)._getExecuteTx(depositMessageV3());
    expect(executeStub.calledOnce).to.equal(true);
    expect(executeStub.firstCall.args[0]).to.deep.equal({
      destination: {
        token: { chainId: 1337, address: OUTPUT_TOKEN },
        recipient: RECIPIENT,
      },
      originChainId: 42161,
      inputToken: { chainId: 42161, address: TOKEN },
      userAddress: REFUND_ADDRESS,
      amount: "5000",
      executionFeeRecipient: SIGNER,
      integratorId: "0xdead",
    });
  });

  it("retries on undefined responses and gives up after exhausting retries", async function () {
    executeStub.resolves(undefined);
    const result = await (handler as unknown as Internals)._getExecuteTx(depositMessageV3());
    expect(result).to.equal(undefined);
    expect(executeStub.callCount).to.equal(4); // initial attempt + 3 retries
  });
});

describe("DepositAddressHandler.initiateDepositV3 integratorId guard", function () {
  let handler: DepositAddressHandler;
  let executeStub: sinon.SinonStub;
  let warnStub: sinon.SinonStub;
  const originChainId = 42161;

  type Internals = { initiateDepositV3: (m: DepositAddressMessageV3) => Promise<void> };

  beforeEach(function () {
    const config = { relayerOriginChains: [originChainId] } as unknown as DepositAddressHandlerConfig;
    warnStub = sinon.stub();
    const logger = { warn: warnStub, debug: sinon.stub() } as unknown as winston.Logger;
    handler = new DepositAddressHandler(logger, config, {} as unknown as Signer, []);
    executeStub = sinon.stub().resolves({ depositAddress: DEPOSIT_ADDRESS });
    (handler as unknown as { api: { executeDepositAddress: sinon.SinonStub } }).api = {
      executeDepositAddress: executeStub,
    };
    // initiateDepositV3 adds/removes the depositKey from this set; seed it so the path runs.
    (handler as unknown as { observedExecutedDeposits: Record<number, Set<string>> }).observedExecutedDeposits = {
      [originChainId]: new Set<string>(),
    };
  });

  afterEach(() => sinon.restore());

  // Each case reaches the guard (evm namespace, origin chain allowed, not yet executed) and must
  // skip before calling the execute endpoint, since a missing/malformed integratorId would only
  // derive a different, unfunded address.
  const skipCases: { name: string; integrator: DepositAddressMessageV3["integrator"] }[] = [
    { name: "integrator is null", integrator: null },
    { name: "integratorId is null", integrator: { name: "x", integratorId: null } },
    { name: "integratorId is non-hex", integrator: { name: "x", integratorId: "0xZZZZ" } },
    { name: "integratorId is wrong length", integrator: { name: "x", integratorId: "0xdeadbeef" } },
  ];

  skipCases.forEach(({ name, integrator }) => {
    it(`skips without calling the execute endpoint when ${name}`, async function () {
      await (handler as unknown as Internals).initiateDepositV3(depositMessageV3({ integrator }));
      expect(executeStub.notCalled).to.equal(true);
      expect(warnStub.calledOnce).to.equal(true);
    });
  });
});

describe("DepositAddressHandler._validateExecuteResponse guards", function () {
  let handler: DepositAddressHandler;
  let warnStub: sinon.SinonStub;

  type Internals = {
    _validateExecuteResponse: (
      r: DepositAddressExecuteResponse,
      m: DepositAddressMessageV3,
      originChainId: number,
      depositKey: string
    ) => boolean;
  };

  const message = depositMessageV3();
  const originChainId = Number(message.erc20Transfer.chainId);

  function executeResponse(overrides: Partial<DepositAddressExecuteResponse> = {}): DepositAddressExecuteResponse {
    return {
      depositAddress: DEPOSIT_ADDRESS,
      executeTx: { ecosystem: "evm", chainId: originChainId, to: TOKEN, data: "0x", value: "0" },
      signer: SIGNER,
      signatureDeadline: getCurrentTime() + 600,
      isPlaceholder: false,
      ...overrides,
    };
  }

  function validate(response: DepositAddressExecuteResponse): boolean {
    return (handler as unknown as Internals)._validateExecuteResponse(response, message, originChainId, "key");
  }

  beforeEach(function () {
    const config = {} as unknown as DepositAddressHandlerConfig;
    warnStub = sinon.stub();
    const logger = { warn: warnStub } as unknown as winston.Logger;
    handler = new DepositAddressHandler(logger, config, {} as unknown as Signer, []);
  });

  afterEach(() => sinon.restore());

  it("accepts a well-formed response (case-insensitive address match)", function () {
    expect(validate(executeResponse({ depositAddress: DEPOSIT_ADDRESS.toLowerCase() }))).to.equal(true);
    expect(warnStub.notCalled).to.equal(true);
  });

  it("rejects when the API-derived deposit address does not match the funded address", function () {
    expect(validate(executeResponse({ depositAddress: RECIPIENT }))).to.equal(false);
    expect(warnStub.calledOnce).to.equal(true);
  });

  it("rejects when the execute tx targets the wrong chain", function () {
    const response = executeResponse();
    response.executeTx.chainId = 1;
    expect(validate(response)).to.equal(false);
  });

  it("rejects placeholder derivations", function () {
    expect(validate(executeResponse({ isPlaceholder: true }))).to.equal(false);
  });

  it("rejects responses whose signature deadline is too close to expiry", function () {
    expect(validate(executeResponse({ signatureDeadline: getCurrentTime() + 30 }))).to.equal(false);
  });
});

describe("DepositAddressHandler._getSignedWithdrawV3", function () {
  let handler: DepositAddressHandler;
  let signWithdrawStub: sinon.SinonStub;
  let redisSetStub: sinon.SinonStub;

  type Internals = {
    _getSignedWithdrawV3: (
      m: DepositAddressMessageV3,
      leaf: typeof v3WithdrawLeaf,
      retriesRemaining?: number
    ) => Promise<DepositAddressSignWithdrawResponse | undefined>;
    terminallySkippedWithdrawKeys: Set<string>;
  };

  function internals(): Internals {
    return handler as unknown as Internals;
  }

  beforeEach(function () {
    const config = {} as unknown as DepositAddressHandlerConfig;
    const logger = { warn: sinon.stub(), debug: sinon.stub() } as unknown as winston.Logger;
    handler = new DepositAddressHandler(logger, config, {} as unknown as Signer, []);
    signWithdrawStub = sinon.stub();
    (handler as unknown as { api: { signWithdrawDepositAddressV3: sinon.SinonStub } }).api = {
      signWithdrawDepositAddressV3: signWithdrawStub,
    };
    redisSetStub = sinon.stub().resolves();
    (handler as unknown as { redisCache: { set: sinon.SinonStub } }).redisCache = { set: redisSetStub };
  });

  afterEach(() => sinon.restore());

  it("builds the sign-withdraw request from the message + withdraw leaf, with gas deduction on", async function () {
    signWithdrawStub.resolves({ signedWithdrawTx: { chainId: 42161 } });
    const message = withdrawMessageV3();
    await internals()._getSignedWithdrawV3(message, v3WithdrawLeaf);
    expect(signWithdrawStub.calledOnce).to.equal(true);
    expect(signWithdrawStub.firstCall.args[0]).to.deep.equal({
      chainId: 42161,
      depositAddress: DEPOSIT_ADDRESS,
      initialRoot: "0x" + "2".repeat(64),
      salt: "0x" + "0".repeat(64),
      token: TOKEN,
      amount: "5000",
      user: REFUND_ADDRESS,
      proof: v3WithdrawLeaf.merkleProof,
      counterfactualDepositFactory: "0x000000000000000000000000000000000000B2B2",
      counterfactualBeacon: "0x000000000000000000000000000000000000B1B1",
      adminWithdrawManager: "0x000000000000000000000000000000000000B3B3",
      withdrawImplementation: WITHDRAW_IMPL,
      deductGasFromRefund: true,
    });
  });

  it("retries transient failures, then gives up without persisting a skip", async function () {
    signWithdrawStub.rejects(new HttpError(400, "GAS_FEE_TEMPORARILY_UNAVAILABLE"));
    const message = withdrawMessageV3();
    const result = await internals()._getSignedWithdrawV3(message, v3WithdrawLeaf);
    expect(result).to.equal(undefined);
    expect(signWithdrawStub.callCount).to.equal(4); // initial attempt + 3 retries
    expect(internals().terminallySkippedWithdrawKeys.size).to.equal(0);
    expect(redisSetStub.notCalled).to.equal(true);
  });

  it("treats a 422 as terminal: no retry, persists the skip key", async function () {
    signWithdrawStub.rejects(new HttpError(422, "GAS_EXCEEDS_REFUND"));
    const message = withdrawMessageV3();
    const result = await internals()._getSignedWithdrawV3(message, v3WithdrawLeaf);
    expect(result).to.equal(undefined);
    expect(signWithdrawStub.callCount).to.equal(1); // no retries on a terminal 422
    const depositKey = `${DEPOSIT_ADDRESS}:${message.erc20Transfer.transactionHash}`;
    expect(internals().terminallySkippedWithdrawKeys.has(depositKey)).to.equal(true);
    expect(redisSetStub.calledOnce).to.equal(true);
  });
});

describe("DepositAddressHandler.initiateWithdrawV3 guards", function () {
  let handler: DepositAddressHandler;
  let signWithdrawStub: sinon.SinonStub;
  let warnStub: sinon.SinonStub;
  let debugStub: sinon.SinonStub;
  const chainId = 42161;

  type Internals = {
    initiateWithdrawV3: (m: DepositAddressMessageV3) => Promise<void>;
    terminallySkippedWithdrawKeys: Set<string>;
  };

  function makeHandler(enableV3Withdrawals: boolean): void {
    const config = { enableV3Withdrawals, relayerOriginChains: [chainId] } as unknown as DepositAddressHandlerConfig;
    warnStub = sinon.stub();
    debugStub = sinon.stub();
    const logger = { warn: warnStub, debug: debugStub } as unknown as winston.Logger;
    handler = new DepositAddressHandler(logger, config, {} as unknown as Signer, []);
    signWithdrawStub = sinon.stub().resolves({ signedWithdrawTx: { chainId } });
    (handler as unknown as { api: { signWithdrawDepositAddressV3: sinon.SinonStub } }).api = {
      signWithdrawDepositAddressV3: signWithdrawStub,
    };
    (handler as unknown as { observedExecutedWithdraws: Record<number, Set<string>> }).observedExecutedWithdraws = {
      [chainId]: new Set<string>(),
    };
    (handler as unknown as { redisCache: { set: sinon.SinonStub } }).redisCache = { set: sinon.stub().resolves() };
  }

  afterEach(() => sinon.restore());

  it("skips without calling the API when the v3 withdraw gate is off", async function () {
    makeHandler(false);
    await (handler as unknown as Internals).initiateWithdrawV3(withdrawMessageV3());
    expect(signWithdrawStub.notCalled).to.equal(true);
    expect(debugStub.calledOnce).to.equal(true);
  });

  it("skips with a warning when the deposit-address namespace is not evm", async function () {
    makeHandler(true);
    await (handler as unknown as Internals).initiateWithdrawV3(withdrawMessageV3({ depositAddressNamespace: "svm" }));
    expect(signWithdrawStub.notCalled).to.equal(true);
    expect(warnStub.calledOnce).to.equal(true);
  });

  it("skips with a warning when the message carries no withdraw leaf", async function () {
    makeHandler(true);
    await (handler as unknown as Internals).initiateWithdrawV3(
      withdrawMessageV3({ counterfactualMaterials: [{ ...v3WithdrawLeaf, kind: "vanilla-cctp" }] })
    );
    expect(signWithdrawStub.notCalled).to.equal(true);
    expect(warnStub.calledOnce).to.equal(true);
  });
});
