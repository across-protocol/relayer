import { Contract } from "ethers";
import { AnyGaslessDepositMessage, DepositWithBlock, GaslessDepositMessage, RelayData } from "../src/interfaces";
import { GaslessRelayer, MessageState } from "../src/gasless/GaslessRelayer";
import { GaslessRelayerConfig } from "../src/gasless/GaslessRelayerConfig";
import SPOKE_POOL_PERIPHERY_ABI from "../src/common/abi/SpokePoolPeriphery.json";
import {
  Address,
  CHAIN_IDs,
  EvmAddress,
  Provider,
  TransactionReceipt,
  getCurrentTime,
  TOKEN_SYMBOLS_MAP,
} from "../src/utils";
import { MAX_EXCLUSIVITY_PERIOD_SECONDS } from "../src/utils/GaslessUtils";
import { createSpyLogger, expect, FakeContract, smock, ethers, toBN } from "./utils";

// Minimal 65-byte hex signature.
const DUMMY_SIGNATURE = "0x" + "ab".repeat(65);

const ORIGIN_CHAIN_ID = CHAIN_IDs.MAINNET;
const DESTINATION_CHAIN_ID = CHAIN_IDs.BASE;

// Real SDK-known USDC addresses so getTokenInfo / getL1TokenAddress resolves without stubbing.
const USDC_MAINNET = TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET];
const USDC_BASE = TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.BASE];
// WETH addresses (used for mismatching-token test).
const WETH_BASE = TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.BASE];

const DUMMY_ADDRESS = "0x" + "11".repeat(20);
const DUMMY_EVM_ADDRESS = EvmAddress.from(DUMMY_ADDRESS);

type GaslessDeposit = RelayData & { destinationChainId: number };
type StrippedDeposit = Omit<DepositWithBlock, "fromLiteChain" | "toLiteChain" | "quoteBlockNumber">;

/**
 * Testable subclass: overrides initialize to no-op and exposes internals via setters/getters.
 */
class TestableGaslessRelayer extends GaslessRelayer {
  constructor(logger: any, config: any, signer: any, depositSigners: any[]) {
    super(logger, config, signer, depositSigners);
    // Explicitly initialize state transition tracking
    this.stateTransitions = {};
  }

  public override async initialize(): Promise<void> {
    // No-op -- state is set directly by tests.
  }

  public async runEvaluateApiSignatures(): Promise<void> {
    return this.evaluateApiSignatures();
  }

  public setProvidersByChain(providers: { [chainId: number]: Provider }): void {
    this.providersByChain = providers;
  }
  public setSpokePoolPeripheries(peripheries: { [chainId: number]: Contract }): void {
    this.spokePoolPeripheries = peripheries;
  }
  public setSpokePools(pools: { [chainId: number]: Contract }): void {
    this.spokePools = pools;
  }
  public setObservedDeposits(deposits: { [chainId: number]: Set<string> }): void {
    this.observedDeposits = deposits;
  }
  public setObservedFills(fills: { [chainId: number]: Set<string> }): void {
    this.observedFills = fills;
  }
  public setSignerAddress(address: EvmAddress): void {
    this.signerAddress = address;
  }
  public getMessageState(depositNonce: string): MessageState {
    return this.messageState[depositNonce];
  }
  public testFillImmediate(
    deposit: Pick<RelayData, "originChainId" | "outputToken" | "outputAmount"> & {
      destinationChainId: number;
      exclusivityParameter: number;
    },
    spokePool: string
  ): boolean {
    return this.fillImmediate(deposit, spokePool);
  }
  public getDepositKey(token: string, originChainId: number, depositId: string): string {
    return this._getDepositKey(token, originChainId, depositId);
  }
  protected override getPeripheryContract(originChainId: number): Contract {
    return this.getPeripheryContractFn(originChainId);
  }

  // Configurable function properties -- tests assign return values; overrides track call counts.
  public getPeripheryContractFn: (chainId: number) => Contract = (chainId) => this.spokePoolPeripheries[chainId];
  public queryGaslessApiFn: () => Promise<AnyGaslessDepositMessage[]> = async () => [];
  public initiateGaslessDepositFn: (msg: GaslessDepositMessage) => Promise<TransactionReceipt | null> = async () =>
    null;
  public initiateFillFn: (deposit: GaslessDeposit) => Promise<TransactionReceipt | null> = async () => null;
  public extractDepositFromReceiptFn: (receipt: TransactionReceipt, chainId: number) => StrippedDeposit = () => {
    throw new Error("extractDepositFromReceiptFn not configured");
  };
  public findDepositFn: (
    originChainId: number,
    inputToken: Address,
    authorizer: string,
    nonce: string
  ) => Promise<StrippedDeposit | undefined> = async () => undefined;

  // Call counters -- incremented by the overrides below.
  public initiateGaslessDepositCalls = 0;
  public extractDepositFromReceiptCalls = 0;
  public initiateFillCalls = 0;
  public findDepositCalls = 0;

  // Track state transitions, keyed by depositKey (e.g., nonce)
  public stateTransitions: { [depositKey: string]: Array<{ from: MessageState; to: MessageState }> } = {};

  protected override async _queryGaslessApi(): Promise<AnyGaslessDepositMessage[]> {
    return this.queryGaslessApiFn();
  }
  protected override async initiateGaslessDeposit(msg: GaslessDepositMessage): Promise<TransactionReceipt | null> {
    this.initiateGaslessDepositCalls++;
    return this.initiateGaslessDepositFn(msg);
  }
  protected override async initiateFill(
    deposit: StrippedDeposit,
    originChainSpokePool: string
  ): Promise<TransactionReceipt | null> {
    this.initiateFillCalls++;

    // Validate that non-CCTP deposits pass the correct spokePool address
    // (defensive check - catches bugs in parameter passing)
    const expectedSpokePool = this.spokePools[deposit.originChainId]?.address;
    if (expectedSpokePool && originChainSpokePool !== expectedSpokePool) {
      throw new Error(
        `initiateFill called with wrong spokePool address: expected ${expectedSpokePool}, got ${originChainSpokePool}`
      );
    }

    return this.initiateFillFn(deposit);
  }
  protected override _extractDepositFromTransactionReceipt(
    receipt: TransactionReceipt,
    originChainId: number
  ): StrippedDeposit {
    this.extractDepositFromReceiptCalls++;
    return this.extractDepositFromReceiptFn(receipt, originChainId);
  }
  protected override async _findDeposit(
    originChainId: number,
    inputToken: Address,
    authorizer: string,
    nonce: string
  ): Promise<StrippedDeposit | undefined> {
    this.findDepositCalls++;
    return this.findDepositFn(originChainId, inputToken, authorizer, nonce);
  }

  protected override _setState(depositKey: string, state: MessageState): void {
    const currentState = this._getState(depositKey);
    super._setState(depositKey, state);

    this.stateTransitions[depositKey] ??= [];
    this.stateTransitions[depositKey].push({ from: currentState, to: state });
  }
}

/**
 * Build a GaslessDepositMessage with real USDC addresses.
 * Defaults: inputAmount == outputAmount == "1000000" (1 USDC).
 */
function makeDepositMessage(
  baseOverrides: Partial<GaslessDepositMessage["baseDepositData"]> = {},
  spokePool = DUMMY_ADDRESS
): GaslessDepositMessage {
  const fillDeadline = baseOverrides.fillDeadline ?? getCurrentTime() + 3600;
  const baseDepositData = {
    inputToken: USDC_MAINNET,
    outputToken: USDC_BASE,
    inputAmount: "1000000",
    outputAmount: "1000000",
    depositor: DUMMY_ADDRESS,
    recipient: DUMMY_ADDRESS,
    destinationChainId: DESTINATION_CHAIN_ID,
    exclusiveRelayer: DUMMY_ADDRESS,
    quoteTimestamp: getCurrentTime(),
    fillDeadline,
    exclusivityDeadline: 1700000000,
    exclusivityParameter: 1700000000,
    message: "0x",
    ...baseOverrides,
  };

  return {
    depositFlowType: "bridge" as const,
    originChainId: ORIGIN_CHAIN_ID,
    depositId: "42",
    requestId: "req-test",
    signature: DUMMY_SIGNATURE,
    permitType: "receiveWithAuthorization",
    permit: {
      types: { ReceiveWithAuthorization: [] },
      domain: { name: "USD Coin", version: "2", chainId: ORIGIN_CHAIN_ID, verifyingContract: USDC_MAINNET },
      primaryType: "ReceiveWithAuthorization",
      message: {
        from: DUMMY_ADDRESS,
        to: DUMMY_ADDRESS,
        value: baseDepositData.inputAmount,
        validAfter: 0,
        validBefore: 999999999999,
        nonce: "0x" + "00".repeat(32),
      },
    },
    inputAmount: baseDepositData.inputAmount,
    baseDepositData,
    submissionFees: { amount: "100", recipient: DUMMY_ADDRESS },
    spokePool,
    nonce: "1",
  };
}

/** Derive the deposit nonce key for a message, matching the experimental handler's key construction. */
function depositNonceFor(relayer: TestableGaslessRelayer, msg: GaslessDepositMessage): string {
  const token = EvmAddress.from(msg.baseDepositData.inputToken).toNative();
  return relayer.getDepositKey(token, msg.originChainId, msg.depositId);
}

/**
 * Build a Permit2 GaslessDepositMessage.
 * Permit2 uses a different permit structure and is identified by permitType === "permit2".
 */
function makePermit2DepositMessage(
  baseOverrides: Partial<GaslessDepositMessage["baseDepositData"]> = {},
  spokePool: string = DUMMY_ADDRESS
): GaslessDepositMessage {
  const fillDeadline = baseOverrides.fillDeadline ?? getCurrentTime() + 3600;
  const baseDepositData = {
    inputToken: USDC_MAINNET,
    outputToken: USDC_BASE,
    inputAmount: "1000000",
    outputAmount: "1000000",
    depositor: DUMMY_ADDRESS,
    recipient: DUMMY_ADDRESS,
    destinationChainId: DESTINATION_CHAIN_ID,
    exclusiveRelayer: DUMMY_ADDRESS,
    quoteTimestamp: getCurrentTime(),
    fillDeadline,
    exclusivityDeadline: 1700000000,
    exclusivityParameter: 1700000000,
    message: "0x",
    ...baseOverrides,
  };

  return {
    depositFlowType: "bridge" as const,
    originChainId: ORIGIN_CHAIN_ID,
    depositId: "42",
    requestId: "req-permit2-test",
    signature: DUMMY_SIGNATURE,
    permitType: "permit2",
    permit: {
      types: { PermitWitnessTransferFrom: [] },
      domain: { name: "Permit2", chainId: ORIGIN_CHAIN_ID, verifyingContract: DUMMY_ADDRESS },
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: USDC_MAINNET, amount: baseDepositData.inputAmount },
        spender: DUMMY_ADDRESS,
        nonce: "123",
        deadline: 999999999999,
        witness: {
          inputAmount: baseDepositData.inputAmount,
          baseDepositData,
          submissionFees: { amount: "100", recipient: DUMMY_ADDRESS },
          spokePool,
          nonce: "1",
        },
      },
    },
    inputAmount: baseDepositData.inputAmount,
    baseDepositData,
    submissionFees: { amount: "100", recipient: DUMMY_ADDRESS },
    spokePool,
    nonce: "1",
  };
}

/**
 * Build a CCTP GaslessDepositMessage.
 * CCTP deposits use a different spokePool address to indicate cross-chain transfer protocol.
 */
function makeCctpDepositMessage(
  baseOverrides: Partial<GaslessDepositMessage["baseDepositData"]> = {},
  normalSpokePool: string = DUMMY_ADDRESS
): GaslessDepositMessage {
  const msg = makeDepositMessage(baseOverrides, normalSpokePool);
  // CCTP deposits are identified by having a different spokePool address than the default.
  msg.spokePool = "0x" + "cc".repeat(20); // Different from normalSpokePool
  return msg;
}

/** Minimal transaction receipt that looks successful. */
function makeReceipt(overrides: Partial<TransactionReceipt> = {}): TransactionReceipt {
  const defaults: TransactionReceipt = {
    status: 1,
    logs: [],
    blockNumber: 1,
    transactionHash: "0x" + "ff".repeat(32),
    transactionIndex: 0,
    blockHash: "0x" + "ee".repeat(32),
    from: DUMMY_ADDRESS,
    to: DUMMY_ADDRESS,
    contractAddress: DUMMY_ADDRESS,
    cumulativeGasUsed: ethers.BigNumber.from(21_000),
    gasUsed: ethers.BigNumber.from(21_000),
    effectiveGasPrice: ethers.BigNumber.from(1),
    byzantium: true,
    type: 0,
    confirmations: 1,
    logsBloom: "0x",
  };
  return { ...defaults, ...overrides };
}

/** Fake deposit event data returned by _extractDepositFromTransactionReceipt / _findDeposit. */
function makeFakeDepositEvent(amounts: { inputAmount?: string; outputAmount?: string } = {}): StrippedDeposit {
  return {
    originChainId: ORIGIN_CHAIN_ID,
    depositId: toBN(42),
    depositor: DUMMY_EVM_ADDRESS,
    recipient: DUMMY_EVM_ADDRESS,
    inputToken: EvmAddress.from(USDC_MAINNET),
    inputAmount: toBN(amounts.inputAmount ?? "1000000"),
    outputToken: EvmAddress.from(USDC_BASE),
    outputAmount: toBN(amounts.outputAmount ?? "1000000"),
    message: "0x",
    fillDeadline: getCurrentTime() + 3600,
    exclusiveRelayer: DUMMY_EVM_ADDRESS,
    exclusivityDeadline: 0,
    destinationChainId: DESTINATION_CHAIN_ID,
    quoteTimestamp: getCurrentTime(),
    blockNumber: 1,
    txnIndex: 0,
    logIndex: 0,
    txnRef: "0x" + "ff".repeat(32),
    messageHash: "0x",
  };
}

/**
 * Helper to set up a test scenario with consistent message/receipt/event data.
 * Automatically configures relayer stubs to return the created objects.
 */
interface TestScenario {
  msg: GaslessDepositMessage;
  nonce: string;
  receipt: TransactionReceipt;
  depositEvent: StrippedDeposit;
}

function setupScenario(
  relayer: TestableGaslessRelayer,
  amounts: { inputAmount: string; outputAmount: string },
  messageFactory: (overrides: Partial<GaslessDepositMessage["baseDepositData"]>) => GaslessDepositMessage
): TestScenario {
  const msg = messageFactory(amounts);
  const receipt = makeReceipt();
  const depositEvent = makeFakeDepositEvent(amounts);
  const nonce = depositNonceFor(relayer, msg);

  // Configure stubs
  relayer.queryGaslessApiFn = async () => [msg];
  relayer.initiateGaslessDepositFn = async () => receipt;
  relayer.extractDepositFromReceiptFn = () => depositEvent;
  relayer.initiateFillFn = async () => receipt;

  return { msg, nonce, receipt, depositEvent };
}

/**
 * Validation helpers for common transition patterns.
 */
function expectStandardTransitions(transitions: Array<{ from: MessageState; to: MessageState }>) {
  expect(transitions).to.have.lengthOf(4);
  expect(transitions[0]).to.deep.equal({ from: MessageState.INITIAL, to: MessageState.DEPOSIT_SUBMIT });
  expect(transitions[1]).to.deep.equal({ from: MessageState.DEPOSIT_SUBMIT, to: MessageState.DEPOSIT_CONFIRM });
  expect(transitions[2]).to.deep.equal({ from: MessageState.DEPOSIT_CONFIRM, to: MessageState.FILL_PENDING });
  expect(transitions[3]).to.deep.equal({ from: MessageState.FILL_PENDING, to: MessageState.FILLED });
}

function expectImmediateTransitions(transitions: Array<{ from: MessageState; to: MessageState }>) {
  expect(transitions).to.have.lengthOf(4);
  expect(transitions[0]).to.deep.equal({ from: MessageState.INITIAL, to: MessageState.DEPOSIT_SUBMIT });
  expect(transitions[1]).to.deep.equal({ from: MessageState.DEPOSIT_SUBMIT, to: MessageState.FILL_PENDING });
  expect(transitions[2]).to.deep.equal({ from: MessageState.FILL_PENDING, to: MessageState.DEPOSIT_CONFIRM });
  expect(transitions[3]).to.deep.equal({ from: MessageState.DEPOSIT_CONFIRM, to: MessageState.FILLED });
}

function expectErrorTransition(transitions: Array<{ from: MessageState; to: MessageState }>) {
  expect(transitions).to.have.lengthOf(1);
  expect(transitions[0]).to.deep.equal({ from: MessageState.INITIAL, to: MessageState.ERROR });
}

function expectCctpTransitions(transitions: Array<{ from: MessageState; to: MessageState }>) {
  expect(transitions).to.have.lengthOf(3);
  expect(transitions[0]).to.deep.equal({ from: MessageState.INITIAL, to: MessageState.DEPOSIT_SUBMIT });
  expect(transitions[1]).to.deep.equal({ from: MessageState.DEPOSIT_SUBMIT, to: MessageState.DEPOSIT_CONFIRM });
  expect(transitions[2]).to.deep.equal({ from: MessageState.DEPOSIT_CONFIRM, to: MessageState.FILLED });
}

/**
 * Helper for testing error scenarios - validates that a message is rejected with ERROR state.
 */
async function expectErrorScenario(relayer: TestableGaslessRelayer, msg: GaslessDepositMessage) {
  relayer.queryGaslessApiFn = async () => [msg];

  await relayer.runEvaluateApiSignatures();

  const nonce = depositNonceFor(relayer, msg);
  expect(relayer.getMessageState(nonce)).to.equal(MessageState.ERROR);
  expect(relayer.initiateGaslessDepositCalls).to.equal(0);
  expectErrorTransition(relayer.stateTransitions[nonce]);
}

describe("GaslessRelayer", function () {
  let relayer: TestableGaslessRelayer;
  let fakeSpokePoolAddress: string;
  let fakePeripherySmock: FakeContract;

  // Test fixture helpers that automatically use the correct spokePool address
  const makeTestDepositMessage = (overrides?: Partial<GaslessDepositMessage["baseDepositData"]>) =>
    makeDepositMessage(overrides ?? {}, fakeSpokePoolAddress);
  const makeTestPermit2Message = (overrides?: Partial<GaslessDepositMessage["baseDepositData"]>) =>
    makePermit2DepositMessage(overrides ?? {}, fakeSpokePoolAddress);
  const makeTestCctpMessage = (overrides?: Partial<GaslessDepositMessage["baseDepositData"]>) =>
    makeCctpDepositMessage(overrides ?? {}, fakeSpokePoolAddress);

  beforeEach(async function () {
    const { spyLogger } = createSpyLogger();

    const [signer] = await ethers.getSigners();

    const config = new GaslessRelayerConfig({
      RELAYER_TOKEN_SYMBOLS: '["USDC"]',
      RELAYER_ORIGIN_CHAINS: `[${ORIGIN_CHAIN_ID}]`,
      RELAYER_DESTINATION_CHAINS: `[${DESTINATION_CHAIN_ID}]`,
      API_GASLESS_ENDPOINT: "http://127.0.0.1",
      SEND_TRANSACTIONS: "true",
    });

    relayer = new TestableGaslessRelayer(spyLogger, config, signer, []);

    // smock.fake() returns FakeContract which isn't assignable to Contract under strict mode.
    // Extract a Contract reference via the address and interface the fake already provides.
    fakePeripherySmock = await smock.fake(SPOKE_POOL_PERIPHERY_ABI);
    const fakePeriphery = new Contract(fakePeripherySmock.address, SPOKE_POOL_PERIPHERY_ABI, signer.provider);
    const fakeSpokePoolSmock = await smock.fake([]);
    const fakeSpokePool = new Contract(fakeSpokePoolSmock.address, [], signer.provider);

    // Save the address for use in message factories.
    fakeSpokePoolAddress = fakeSpokePool.address;

    relayer.setProvidersByChain({
      [ORIGIN_CHAIN_ID]: signer.provider!,
      [DESTINATION_CHAIN_ID]: signer.provider!,
    });
    relayer.setSpokePoolPeripheries({ [ORIGIN_CHAIN_ID]: fakePeriphery });
    relayer.setSpokePools({
      [ORIGIN_CHAIN_ID]: fakeSpokePool,
      [DESTINATION_CHAIN_ID]: fakeSpokePool,
    });
    relayer.setObservedDeposits({ [ORIGIN_CHAIN_ID]: new Set() });
    relayer.setObservedFills({ [DESTINATION_CHAIN_ID]: new Set() });
    relayer.setSignerAddress(EvmAddress.from(signer.address));
  });

  it("Standard path: INITIAL -> DEPOSIT_SUBMIT -> DEPOSIT_CONFIRM -> FILL_PENDING -> FILLED", async function () {
    // Use amounts above the default fillImmediate threshold (10 USDC) to ensure the standard path.
    const msg = makeTestDepositMessage({ inputAmount: "20000000", outputAmount: "19000000" });
    const receipt = makeReceipt();
    const depositEvent = makeFakeDepositEvent({ inputAmount: "20000000", outputAmount: "19000000" });

    relayer.queryGaslessApiFn = async () => [msg];
    relayer.initiateGaslessDepositFn = async () => receipt;
    relayer.extractDepositFromReceiptFn = () => depositEvent;
    relayer.initiateFillFn = async () => receipt;

    await relayer.runEvaluateApiSignatures();

    expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.FILLED);
    expect(relayer.initiateGaslessDepositCalls).to.equal(1);
    expect(relayer.initiateFillCalls).to.equal(1);
    // Deposit was found via receipt, so _findDeposit should not have been needed.
    expect(relayer.findDepositCalls).to.equal(0);
    expectStandardTransitions(relayer.stateTransitions[depositNonceFor(relayer, msg)]);
  });

  it("Immediate fill: INITIAL -> DEPOSIT_SUBMIT -> FILL_PENDING -> DEPOSIT_CONFIRM -> FILLED", async function () {
    // inputAmount == outputAmount == "1000000" (1 USDC, below 10 USDC threshold) -> fillImmediate = true.
    // Default smock fake behaviour (no revert) makes willSucceed return succeed: true.
    process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`] = "10";
    const msg = makeTestDepositMessage();
    const receipt = makeReceipt();

    relayer.queryGaslessApiFn = async () => [msg];
    relayer.initiateGaslessDepositFn = async () => receipt;
    relayer.extractDepositFromReceiptFn = () => makeFakeDepositEvent();
    relayer.initiateFillFn = async () => receipt;

    await relayer.runEvaluateApiSignatures();

    expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.FILLED);
    // Immediate path: fill uses synthetic deposit, but we MUST verify the actual deposit
    // succeeded by extracting from receipt to avoid unreimbursable fills.
    expect(relayer.extractDepositFromReceiptCalls).to.equal(1);
    expect(relayer.initiateFillCalls).to.be.gte(1);
    expectImmediateTransitions(relayer.stateTransitions[depositNonceFor(relayer, msg)]);
    delete process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`];
  });

  it("Immediate fill fallback: simulation failure falls back to standard path", async function () {
    // Same amounts as test above (fillImmediate initially true).
    // Configure the smock fake to revert so willSucceed returns succeed: false.
    fakePeripherySmock.depositWithAuthorization.reverts("revert");

    const msg = makeTestDepositMessage();
    const receipt = makeReceipt();
    const depositEvent = makeFakeDepositEvent();
    const nonce = depositNonceFor(relayer, msg);

    relayer.queryGaslessApiFn = async () => [msg];
    relayer.initiateGaslessDepositFn = async () => receipt;
    relayer.extractDepositFromReceiptFn = () => depositEvent;
    relayer.initiateFillFn = async () => receipt;

    await relayer.runEvaluateApiSignatures();

    expect(relayer.getMessageState(nonce)).to.equal(MessageState.FILLED);
    expectStandardTransitions(relayer.stateTransitions[nonce]);

    // Simulation failed, so the handler fell back to the standard path:
    // deposit was extracted from the receipt (not built synthetically).
    expect(relayer.extractDepositFromReceiptCalls).to.equal(1);
    expect(relayer.initiateFillCalls).to.equal(1);
  });

  it("Immediate fill: retries when deposit fails after fill succeeds", async function () {
    // Tests the critical safety check: if immediate fill succeeds but deposit fails/never mines,
    // the relayer detects this in DEPOSIT_CONFIRM and retries instead of finalizing.
    // Without this check, the relayer would have an unreimbursable fill.
    process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`] = "10";
    const msg = makeTestDepositMessage();
    const nonce = depositNonceFor(relayer, msg);

    let depositAttempts = 0;
    relayer.queryGaslessApiFn = async () => [msg];
    relayer.initiateGaslessDepositFn = async () => {
      depositAttempts++;
      // First attempt: return null (deposit failed)
      // Second attempt: return receipt (deposit succeeds)
      return depositAttempts === 1 ? null : makeReceipt();
    };
    relayer.extractDepositFromReceiptFn = () => makeFakeDepositEvent();
    relayer.initiateFillFn = async () => makeReceipt();

    await relayer.runEvaluateApiSignatures();

    expect(relayer.getMessageState(nonce)).to.equal(MessageState.FILLED);
    // Should have retried deposit after first attempt failed
    expect(depositAttempts).to.equal(2);
    expect(relayer.initiateGaslessDepositCalls).to.equal(2);
    // Fill is attempted on both passes (deposit persists across retry).
    // This is safe because fills are idempotent - second attempt is a no-op if first succeeded.
    expect(relayer.initiateFillCalls).to.equal(2);
    // Should verify deposit on second attempt
    expect(relayer.extractDepositFromReceiptCalls).to.equal(1);

    // Verify state transition sequence shows retry behavior
    const transitions = relayer.stateTransitions[nonce];
    expect(transitions).to.have.length.at.least(4);
    expect(transitions[0]).to.deep.equal({ from: MessageState.INITIAL, to: MessageState.DEPOSIT_SUBMIT });
    expect(transitions[1]).to.deep.equal({ from: MessageState.DEPOSIT_SUBMIT, to: MessageState.FILL_PENDING });
    expect(transitions[2]).to.deep.equal({ from: MessageState.FILL_PENDING, to: MessageState.DEPOSIT_CONFIRM });
    // Critical: should retry DEPOSIT_SUBMIT after verification fails
    expect(transitions[3]).to.deep.equal({ from: MessageState.DEPOSIT_CONFIRM, to: MessageState.DEPOSIT_SUBMIT });
    // Should eventually reach FILLED after retry succeeds
    expect(transitions[transitions.length - 1].to).to.equal(MessageState.FILLED);

    delete process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`];
  });

  it("Immediate fill: normalizes plain-text message to match on-chain deposit", async function () {
    // Tests that buildSyntheticDeposit normalizes message field to hex, matching the encoding
    // used by toContractDepositData when building the origin deposit transaction.
    // Without normalization, relay data hashes would mismatch and fillRelay would fail.
    process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`] = "10";
    const plainTextMessage = "Hello, Across!";
    const expectedHexMessage = "0x48656c6c6f2c204163726f737321"; // hex encoding of plain text
    const msg = makeTestDepositMessage({ message: plainTextMessage });
    const receipt = makeReceipt();

    let capturedFillDeposit: RelayData | undefined;
    relayer.queryGaslessApiFn = async () => [msg];
    relayer.initiateGaslessDepositFn = async () => receipt;
    relayer.extractDepositFromReceiptFn = () => makeFakeDepositEvent({ message: expectedHexMessage });
    relayer.initiateFillFn = async (deposit) => {
      capturedFillDeposit = deposit;
      return receipt;
    };

    await relayer.runEvaluateApiSignatures();

    expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.FILLED);
    // Verify that the fill was called with normalized (hex) message, not plain text
    expect(capturedFillDeposit).to.not.be.undefined;
    expect(capturedFillDeposit!.message).to.equal(expectedHexMessage);
    expect(capturedFillDeposit!.message).to.not.equal(plainTextMessage);
    delete process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`];
  });

  it("Throws error if buildSyntheticDeposit called with relative exclusivityParameter", function () {
    // This test verifies the defensive assertion in buildSyntheticDeposit.
    // It should never be reached in practice (fillImmediate rejects relative parameters),
    // but the assertion provides defense-in-depth if the check is bypassed.
    const { buildSyntheticDeposit } = require("../src/utils/GaslessUtils");
    const msgWithRelativeExclusivity = makeTestDepositMessage({ exclusivityParameter: 300 });

    expect(() => buildSyntheticDeposit(msgWithRelativeExclusivity)).to.throw(/exclusivityParameter is not absolute/);
  });

  it("Invalid deposit (mismatching L1 tokens) -> ERROR", async function () {
    const msg = makeTestDepositMessage({ inputToken: USDC_MAINNET, outputToken: WETH_BASE });
    await expectErrorScenario(relayer, msg);
  });

  it("Expired deposit -> ERROR", async function () {
    const msg = makeTestDepositMessage({ fillDeadline: getCurrentTime() - 100 });
    await expectErrorScenario(relayer, msg);
  });

  describe("Permit2 flow", function () {
    it("Permit2 deposit: INITIAL -> DEPOSIT_PENDING -> FILL_PENDING -> FILLED", async function () {
      process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`] = "10";
      const { nonce } = setupScenario(
        relayer,
        { inputAmount: "2000000", outputAmount: "1900000" },
        makeTestPermit2Message
      );

      await relayer.runEvaluateApiSignatures();

      expect(relayer.getMessageState(nonce)).to.equal(MessageState.FILLED);
      expect(relayer.initiateGaslessDepositCalls).to.equal(1);
      expect(relayer.initiateFillCalls).to.equal(1);
      expectImmediateTransitions(relayer.stateTransitions[nonce]);
      delete process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`];
    });
  });

  describe("CCTP flow", function () {
    it("CCTP deposit: submits deposit, skips fill, goes to FILLED", async function () {
      const msg = makeTestCctpMessage({ inputAmount: "2000000", outputAmount: "1900000" });
      const receipt = makeReceipt();
      const nonce = depositNonceFor(relayer, msg);

      relayer.queryGaslessApiFn = async () => [msg];
      relayer.initiateGaslessDepositFn = async () => receipt;

      await relayer.runEvaluateApiSignatures();

      expect(relayer.getMessageState(nonce)).to.equal(MessageState.FILLED);
      expect(relayer.initiateGaslessDepositCalls).to.equal(1);
      expect(relayer.initiateFillCalls).to.equal(0);
      expectCctpTransitions(relayer.stateTransitions[nonce]);
    });
  });

  describe("Edge cases and multi-message handling", function () {
    it("Input amount less than output amount: goes to ERROR", async function () {
      const msg = makeTestDepositMessage({ inputAmount: "900000", outputAmount: "1000000" });
      await expectErrorScenario(relayer, msg);
    });

    it("Deposit receipt null, recovered via _findDeposit", async function () {
      // Use amounts above the default fillImmediate threshold (10 USDC) to ensure the standard path.
      const msg = makeTestDepositMessage({ inputAmount: "20000000", outputAmount: "19000000" });
      const depositEvent = makeFakeDepositEvent({ inputAmount: "20000000", outputAmount: "19000000" });
      const receipt = makeReceipt();

      relayer.queryGaslessApiFn = async () => [msg];
      // Deposit returns null (failed/skipped).
      relayer.initiateGaslessDepositFn = async () => null;
      // _findDeposit locates the deposit on-chain.
      relayer.findDepositFn = async () => depositEvent;
      relayer.initiateFillFn = async () => receipt;

      await relayer.runEvaluateApiSignatures();

      expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.FILLED);
      expect(relayer.findDepositCalls).to.equal(1);
      expect(relayer.initiateFillCalls).to.equal(1);
      expectStandardTransitions(relayer.stateTransitions[depositNonceFor(relayer, msg)]);
    });

    it("Multiple messages: processes each independently", async function () {
      process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`] = "10";
      const msg1 = makeTestDepositMessage({ inputAmount: "1000000", outputAmount: "900000" });
      msg1.depositId = "100";
      const msg2 = makeTestDepositMessage({ inputAmount: "2000000", outputAmount: "1900000" });
      msg2.depositId = "200";

      const receipt = makeReceipt();
      const depositEvent1 = makeFakeDepositEvent({ inputAmount: "1000000", outputAmount: "900000" });
      depositEvent1.depositId = toBN(100);
      const depositEvent2 = makeFakeDepositEvent({ inputAmount: "2000000", outputAmount: "1900000" });
      depositEvent2.depositId = toBN(200);

      relayer.queryGaslessApiFn = async () => [msg1, msg2];
      relayer.initiateGaslessDepositFn = async () => receipt;
      relayer.extractDepositFromReceiptFn = (() => {
        let callCount = 0;
        return () => (++callCount === 1 ? depositEvent1 : depositEvent2);
      })();
      relayer.initiateFillFn = async () => receipt;

      await relayer.runEvaluateApiSignatures();

      const nonce1 = depositNonceFor(relayer, msg1);
      const nonce2 = depositNonceFor(relayer, msg2);

      expect(relayer.getMessageState(nonce1)).to.equal(MessageState.FILLED);
      expect(relayer.getMessageState(nonce2)).to.equal(MessageState.FILLED);
      expect(relayer.initiateGaslessDepositCalls).to.equal(2);
      expect(relayer.initiateFillCalls).to.equal(2);

      expectImmediateTransitions(relayer.stateTransitions[nonce1]);
      expectImmediateTransitions(relayer.stateTransitions[nonce2]);
      delete process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`];
    });

    it("Message with existing state is skipped on subsequent polls", async function () {
      process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`] = "10";
      const { nonce } = setupScenario(
        relayer,
        { inputAmount: "2000000", outputAmount: "1900000" },
        makeTestDepositMessage
      );

      // First poll: process message
      await relayer.runEvaluateApiSignatures();
      expect(relayer.getMessageState(nonce)).to.equal(MessageState.FILLED);
      expect(relayer.initiateGaslessDepositCalls).to.equal(1);
      expectImmediateTransitions(relayer.stateTransitions[nonce]);

      // Second poll: message should be skipped (already has state)
      await relayer.runEvaluateApiSignatures();
      expect(relayer.initiateGaslessDepositCalls).to.equal(1);
      expectImmediateTransitions(relayer.stateTransitions[nonce]);
      delete process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`];
    });

    describe("fillImmediate", function () {
      afterEach(function () {
        delete process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`];
      });

      it("Returns true when outputAmount is below threshold", function () {
        process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`] = "10";
        const result = relayer.testFillImmediate(
          {
            originChainId: ORIGIN_CHAIN_ID,
            destinationChainId: DESTINATION_CHAIN_ID,
            outputToken: EvmAddress.from(USDC_BASE),
            outputAmount: toBN("1000000"), // 1 USDC < 10 USDC threshold
            exclusivityParameter: 1700000000,
          },
          fakeSpokePoolAddress
        );
        expect(result).to.be.true;
      });

      it("Returns false when outputAmount exceeds threshold", function () {
        process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`] = "10";
        const result = relayer.testFillImmediate(
          {
            originChainId: ORIGIN_CHAIN_ID,
            destinationChainId: DESTINATION_CHAIN_ID,
            outputToken: EvmAddress.from(USDC_BASE),
            outputAmount: toBN("20000000"), // 20 USDC > 10 USDC threshold
            exclusivityParameter: 1700000000,
          },
          fakeSpokePoolAddress
        );
        expect(result).to.be.false;
      });

      it("Returns false when outputAmount equals threshold (exclusive boundary)", function () {
        process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`] = "10";
        const result = relayer.testFillImmediate(
          {
            originChainId: ORIGIN_CHAIN_ID,
            destinationChainId: DESTINATION_CHAIN_ID,
            outputToken: EvmAddress.from(USDC_BASE),
            outputAmount: toBN("10000000"), // 10 USDC == 10 USDC threshold
            exclusivityParameter: 1700000000,
          },
          fakeSpokePoolAddress
        );
        expect(result).to.be.false;
      });

      it("Respects per-chain env var override", function () {
        process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`] = "5";
        expect(
          relayer.testFillImmediate(
            {
              originChainId: ORIGIN_CHAIN_ID,
              destinationChainId: DESTINATION_CHAIN_ID,
              outputToken: EvmAddress.from(USDC_BASE),
              outputAmount: toBN("3000000"), // 3 USDC < 5 USDC override
              exclusivityParameter: 1700000000,
            },
            fakeSpokePoolAddress
          )
        ).to.be.true;
        expect(
          relayer.testFillImmediate(
            {
              originChainId: ORIGIN_CHAIN_ID,
              destinationChainId: DESTINATION_CHAIN_ID,
              outputToken: EvmAddress.from(USDC_BASE),
              outputAmount: toBN("7000000"), // 7 USDC > 5 USDC override
              exclusivityParameter: 1700000000,
            },
            fakeSpokePoolAddress
          )
        ).to.be.false;
      });

      it("Returns false for non-stablecoin tokens regardless of amount", function () {
        // WETH is not USDC/USDT, so fillImmediate is always false.
        process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`] = "10";
        const result = relayer.testFillImmediate(
          {
            originChainId: ORIGIN_CHAIN_ID,
            destinationChainId: DESTINATION_CHAIN_ID,
            outputToken: EvmAddress.from(WETH_BASE),
            outputAmount: toBN("1"), // Tiny amount, but not a stablecoin
            exclusivityParameter: 1700000000,
          },
          fakeSpokePoolAddress
        );
        expect(result).to.be.false;
      });

      it("Returns false for relative exclusivityParameter (immediate fill unsafe)", function () {
        // Relative parameter (300 seconds = 5 minutes) should reject immediate fill
        // because we can't know the actual deadline until deposit mines.
        const result = relayer.testFillImmediate(
          {
            originChainId: ORIGIN_CHAIN_ID,
            destinationChainId: DESTINATION_CHAIN_ID,
            outputToken: EvmAddress.from(USDC_BASE),
            outputAmount: toBN("1000000"), // 1 USDC < 10 USDC (would pass amount check)
            exclusivityParameter: 300,
          },
          fakeSpokePoolAddress
        );
        expect(result).to.be.false;
      });

      it("Returns true for absolute exclusivityParameter (immediate fill safe)", function () {
        // Absolute timestamp (>= 1e9) allows immediate fill because deadline is known.
        process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`] = "10";
        const result = relayer.testFillImmediate(
          {
            originChainId: ORIGIN_CHAIN_ID,
            destinationChainId: DESTINATION_CHAIN_ID,
            outputToken: EvmAddress.from(USDC_BASE),
            outputAmount: toBN("1000000"), // 1 USDC < 10 USDC
            exclusivityParameter: 1700000000,
          },
          fakeSpokePoolAddress
        );
        expect(result).to.be.true;
      });

      it("Returns true for exclusivityParameter = 0 (treated as absolute)", function () {
        // exclusivityParameter = 0 means no exclusivity, treated as absolute (not relative).
        process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`] = "10";
        const result = relayer.testFillImmediate(
          {
            originChainId: ORIGIN_CHAIN_ID,
            destinationChainId: DESTINATION_CHAIN_ID,
            outputToken: EvmAddress.from(USDC_BASE),
            outputAmount: toBN("1000000"),
            exclusivityParameter: 0,
          },
          fakeSpokePoolAddress
        );
        expect(result).to.be.true;
      });

      it("Returns false for exclusivityParameter just under threshold (relative)", function () {
        // Just under MAX_EXCLUSIVITY_PERIOD_SECONDS should be treated as relative.
        const result = relayer.testFillImmediate(
          {
            originChainId: ORIGIN_CHAIN_ID,
            destinationChainId: DESTINATION_CHAIN_ID,
            outputToken: EvmAddress.from(USDC_BASE),
            outputAmount: toBN("1000000"),
            exclusivityParameter: MAX_EXCLUSIVITY_PERIOD_SECONDS - 1,
          },
          fakeSpokePoolAddress
        );
        expect(result).to.be.false;
      });

      it("Returns false for exclusivityParameter at threshold (conservatively treated as relative)", function () {
        // Exactly at MAX_EXCLUSIVITY_PERIOD_SECONDS is conservatively treated as relative.
        // This is the safer choice: reject immediate fill rather than risk using wrong deadline.
        const result = relayer.testFillImmediate(
          {
            originChainId: ORIGIN_CHAIN_ID,
            destinationChainId: DESTINATION_CHAIN_ID,
            outputToken: EvmAddress.from(USDC_BASE),
            outputAmount: toBN("1000000"),
            exclusivityParameter: MAX_EXCLUSIVITY_PERIOD_SECONDS,
          },
          fakeSpokePoolAddress
        );
        expect(result).to.be.false;
      });

      it("Returns true for exclusivityParameter just over threshold (absolute)", function () {
        // Just over MAX_EXCLUSIVITY_PERIOD_SECONDS should be treated as absolute.
        process.env[`RELAYER_GASLESS_FILL_IMMEDIATE_USD_THRESHOLD_${ORIGIN_CHAIN_ID}`] = "10";
        const result = relayer.testFillImmediate(
          {
            originChainId: ORIGIN_CHAIN_ID,
            destinationChainId: DESTINATION_CHAIN_ID,
            outputToken: EvmAddress.from(USDC_BASE),
            outputAmount: toBN("1000000"),
            exclusivityParameter: MAX_EXCLUSIVITY_PERIOD_SECONDS + 1,
          },
          fakeSpokePoolAddress
        );
        expect(result).to.be.true;
      });
    });
  });
});
