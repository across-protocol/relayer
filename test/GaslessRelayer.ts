import { Contract } from "ethers";
import { GaslessDepositMessage, DepositWithBlock } from "../src/interfaces";
import { GaslessRelayer, MessageState } from "../src/gasless/GaslessRelayer";
import { GaslessRelayerConfig } from "../src/gasless/GaslessRelayerConfig";
import SPOKE_POOL_PERIPHERY_ABI from "../src/common/abi/SpokePoolPeriphery.json";
import { CHAIN_IDs, EvmAddress, Provider, TransactionReceipt, getCurrentTime, TOKEN_SYMBOLS_MAP } from "../src/utils";
import { createSpyLogger, expect, smock, ethers, toBN } from "./utils";

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

type StrippedDeposit = Omit<DepositWithBlock, "fromLiteChain" | "toLiteChain" | "quoteBlockNumber">;

/**
 * Testable subclass: overrides initialize to no-op and exposes internals via setters/getters.
 */
class TestableGaslessRelayer extends GaslessRelayer {
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
  public setObservedNonces(nonces: { [chainId: number]: Set<string> }): void {
    this.observedNonces = nonces;
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
  public getDepositKey(token: string, originChainId: number, depositId: string): string {
    return this._getDepositKey(token, originChainId, depositId);
  }

  // Configurable function properties -- tests assign return values; overrides track call counts.
  public queryGaslessApiFn: () => Promise<GaslessDepositMessage[]> = async () => [];
  public initiateGaslessDepositFn: (msg: GaslessDepositMessage) => Promise<TransactionReceipt | null> = async () =>
    null;
  public initiateFillFn: (deposit: StrippedDeposit) => Promise<TransactionReceipt | null> = async () => null;
  public extractDepositFromReceiptFn: (receipt: TransactionReceipt, chainId: number) => StrippedDeposit = () => {
    throw new Error("extractDepositFromReceiptFn not configured");
  };
  // Call counters -- incremented by the overrides below.
  public initiateGaslessDepositCalls = 0;
  public initiateFillCalls = 0;

  protected override async _queryGaslessApi(): Promise<GaslessDepositMessage[]> {
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
    return this.extractDepositFromReceiptFn(receipt, originChainId);
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
    exclusivityDeadline: 0,
    exclusivityParameter: 0,
    message: "0x",
    ...baseOverrides,
  };

  return {
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
    exclusivityDeadline: 0,
    exclusivityParameter: 0,
    message: "0x",
    ...baseOverrides,
  };

  return {
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

describe("GaslessRelayer", function () {
  let relayer: TestableGaslessRelayer;
  let fakeSpokePoolAddress: string;

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
    const fakePeripherySmock = await smock.fake(SPOKE_POOL_PERIPHERY_ABI);
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
    relayer.setObservedNonces({ [ORIGIN_CHAIN_ID]: new Set() });
    relayer.setObservedFills({ [DESTINATION_CHAIN_ID]: new Set() });
    relayer.setSignerAddress(EvmAddress.from(signer.address));

    // Enable experimental handler.
    process.env.RELAYER_GASLESS_HANDLER = "experimental";
  });

  afterEach(function () {
    delete process.env.RELAYER_GASLESS_HANDLER;
  });

  it("Standard path: INITIAL -> DEPOSIT_PENDING -> FILL_PENDING -> FILLED", async function () {
    const msg = makeTestDepositMessage({ inputAmount: "2000000", outputAmount: "1900000" });
    const receipt = makeReceipt();
    const depositEvent = makeFakeDepositEvent({ inputAmount: "2000000", outputAmount: "1900000" });

    relayer.queryGaslessApiFn = async () => [msg];
    relayer.initiateGaslessDepositFn = async () => receipt;
    relayer.extractDepositFromReceiptFn = () => depositEvent;
    relayer.initiateFillFn = async () => receipt;

    await relayer.runEvaluateApiSignatures();

    expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.FILLED);
    expect(relayer.initiateGaslessDepositCalls).to.equal(1);
    expect(relayer.initiateFillCalls).to.equal(1);
  });

  it("Invalid deposit (mismatching L1 tokens) -> ERROR", async function () {
    // Use WETH as output token (different L1 token from USDC input).
    const msg = makeTestDepositMessage({
      inputToken: USDC_MAINNET,
      outputToken: WETH_BASE,
    });

    relayer.queryGaslessApiFn = async () => [msg];

    await relayer.runEvaluateApiSignatures();

    expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.ERROR);
    expect(relayer.initiateGaslessDepositCalls).to.equal(0);
  });

  it("Expired deposit -> ERROR", async function () {
    // Set fillDeadline in the past.
    const msg = makeTestDepositMessage({ fillDeadline: getCurrentTime() - 100 });

    relayer.queryGaslessApiFn = async () => [msg];

    await relayer.runEvaluateApiSignatures();

    expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.ERROR);
    expect(relayer.initiateGaslessDepositCalls).to.equal(0);
  });

  describe("Permit2 flow", function () {
    it("Permit2 deposit: INITIAL -> DEPOSIT_PENDING -> FILL_PENDING -> FILLED", async function () {
      const msg = makeTestPermit2Message({ inputAmount: "2000000", outputAmount: "1900000" });
      const receipt = makeReceipt();
      const depositEvent = makeFakeDepositEvent({ inputAmount: "2000000", outputAmount: "1900000" });

      relayer.queryGaslessApiFn = async () => [msg];
      relayer.initiateGaslessDepositFn = async () => receipt;
      relayer.extractDepositFromReceiptFn = () => depositEvent;
      relayer.initiateFillFn = async () => receipt;

      await relayer.runEvaluateApiSignatures();

      expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.FILLED);
      expect(relayer.initiateGaslessDepositCalls).to.equal(1);
      expect(relayer.initiateFillCalls).to.equal(1);
    });
  });

  describe("CCTP flow", function () {
    it("CCTP deposit: submits deposit, skips fill, goes to FILLED", async function () {
      const msg = makeTestCctpMessage({ inputAmount: "2000000", outputAmount: "1900000" });
      const receipt = makeReceipt();

      relayer.queryGaslessApiFn = async () => [msg];
      relayer.initiateGaslessDepositFn = async () => receipt;

      await relayer.runEvaluateApiSignatures();

      expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.FILLED);
      expect(relayer.initiateGaslessDepositCalls).to.equal(1);
      // Fill should NOT be called for CCTP deposits.
      expect(relayer.initiateFillCalls).to.equal(0);
    });
  });

  describe("Edge cases and multi-message handling", function () {
    it("Input amount less than output amount: goes to ERROR", async function () {
      // inputAmount < outputAmount is invalid and should be rejected
      const msg = makeTestDepositMessage({ inputAmount: "900000", outputAmount: "1000000" });

      relayer.queryGaslessApiFn = async () => [msg];

      await relayer.runEvaluateApiSignatures();

      expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.ERROR);
      expect(relayer.initiateGaslessDepositCalls).to.equal(0);
    });

    it("Multiple messages: processes each independently", async function () {
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
      let callCount = 0;
      relayer.initiateGaslessDepositFn = async () => receipt;
      relayer.extractDepositFromReceiptFn = (_, chainId) => {
        // Return different deposits based on which call this is.
        callCount++;
        return callCount === 1 ? depositEvent1 : depositEvent2;
      };
      relayer.initiateFillFn = async () => receipt;

      await relayer.runEvaluateApiSignatures();

      expect(relayer.getMessageState(depositNonceFor(relayer, msg1))).to.equal(MessageState.FILLED);
      expect(relayer.getMessageState(depositNonceFor(relayer, msg2))).to.equal(MessageState.FILLED);
      expect(relayer.initiateGaslessDepositCalls).to.equal(2);
      expect(relayer.initiateFillCalls).to.equal(2);
    });

    it("Message with existing state is skipped on subsequent polls", async function () {
      const msg = makeTestDepositMessage({ inputAmount: "2000000", outputAmount: "1900000" });
      const receipt = makeReceipt();
      const depositEvent = makeFakeDepositEvent({ inputAmount: "2000000", outputAmount: "1900000" });

      relayer.queryGaslessApiFn = async () => [msg];
      relayer.initiateGaslessDepositFn = async () => receipt;
      relayer.extractDepositFromReceiptFn = () => depositEvent;
      relayer.initiateFillFn = async () => receipt;

      // First poll: process message.
      await relayer.runEvaluateApiSignatures();
      expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.FILLED);
      expect(relayer.initiateGaslessDepositCalls).to.equal(1);

      // Second poll: message should be skipped (already has state).
      await relayer.runEvaluateApiSignatures();
      // Call count should not increase.
      expect(relayer.initiateGaslessDepositCalls).to.equal(1);
    });
  });
});
