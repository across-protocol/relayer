import { Contract } from "ethers";
import { DepositWithBlock, GaslessDepositMessage, RelayData } from "../src/interfaces";
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
  public getNonceKey(token: string, authorizer: string, nonce: string): string {
    return this._getNonceKey(token, { authorizer, nonce });
  }

  // Configurable function properties -- tests assign return values; overrides track call counts.
  public getPeripheryContractFn: (chainId: number) => Contract = (chainId) => this.spokePoolPeripheries[chainId];
  public queryGaslessApiFn: () => Promise<GaslessDepositMessage[]> = async () => [];
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

  protected override getPeripheryContract(originChainId: number): Contract {
    return this.getPeripheryContractFn(originChainId);
  }
  protected override async _queryGaslessApi(): Promise<GaslessDepositMessage[]> {
    return this.queryGaslessApiFn();
  }
  protected override async initiateGaslessDeposit(msg: GaslessDepositMessage): Promise<TransactionReceipt | null> {
    this.initiateGaslessDepositCalls++;
    return this.initiateGaslessDepositFn(msg);
  }
  protected override async initiateFill(deposit: GaslessDeposit): Promise<TransactionReceipt | null> {
    this.initiateFillCalls++;
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
}

/**
 * Build a GaslessDepositMessage with real USDC addresses.
 * Defaults: inputAmount == outputAmount == "1000000" (1 USDC).
 */
function makeDepositMessage(
  baseOverrides: Partial<GaslessDepositMessage["baseDepositData"]> = {}
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
    spokePool: DUMMY_ADDRESS,
    nonce: "1",
  };
}

/** Derive the deposit nonce key for a message, matching the experimental handler's key construction. */
function depositNonceFor(relayer: TestableGaslessRelayer, msg: GaslessDepositMessage): string {
  const token = EvmAddress.from(msg.baseDepositData.inputToken).toNative();
  return relayer.getNonceKey(token, msg.permit.message.from, msg.permit.message.nonce);
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
  let fakePeriphery: Contract;
  let fakePeripherySmock: FakeContract<Contract>;

  beforeEach(async function () {
    const { spyLogger } = createSpyLogger();

    const [signer] = await ethers.getSigners();

    const config = new GaslessRelayerConfig({
      RELAYER_TOKEN_SYMBOLS: '["USDC"]',
      RELAYER_ORIGIN_CHAINS: `[${ORIGIN_CHAIN_ID}]`,
      RELAYER_DESTINATION_CHAINS: `[${DESTINATION_CHAIN_ID}]`,
      API_GASLESS_ENDPOINT: "http://test",
      SEND_TRANSACTIONS: "true",
    });

    relayer = new TestableGaslessRelayer(spyLogger, config, signer, []);

    // smock.fake() returns FakeContract which isn't assignable to Contract under strict mode.
    // Extract a Contract reference via the address and interface the fake already provides.
    fakePeripherySmock = await smock.fake(SPOKE_POOL_PERIPHERY_ABI);
    fakePeriphery = new Contract(fakePeripherySmock.address, SPOKE_POOL_PERIPHERY_ABI, signer.provider);
    const fakeSpokePoolSmock = await smock.fake([]);
    const fakeSpokePool = new Contract(fakeSpokePoolSmock.address, [], signer.provider);

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

  it("Standard path: INITIAL -> DEPOSIT_SUBMIT -> DEPOSIT_CONFIRM -> FILL_PENDING -> FILLED", async function () {
    const msg = makeDepositMessage({ inputAmount: "2000000", outputAmount: "1900000" });
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
    // Deposit was found via receipt, so _findDeposit should not have been needed.
    expect(relayer.findDepositCalls).to.equal(0);
  });

  it("Invalid deposit (mismatching L1 tokens) -> ERROR", async function () {
    // Use WETH as output token (different L1 token from USDC input).
    const msg = makeDepositMessage({
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
    const msg = makeDepositMessage({ fillDeadline: getCurrentTime() - 100 });

    relayer.queryGaslessApiFn = async () => [msg];

    await relayer.runEvaluateApiSignatures();

    expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.ERROR);
    expect(relayer.initiateGaslessDepositCalls).to.equal(0);
  });

  it("Deposit receipt null, recovered via _findDeposit", async function () {
    const msg = makeDepositMessage({ inputAmount: "2000000", outputAmount: "1900000" });
    const depositEvent = makeFakeDepositEvent({ inputAmount: "2000000", outputAmount: "1900000" });
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
  });

  it("Immediate fill: INITIAL -> DEPOSIT_SUBMIT -> FILL_PENDING -> DEPOSIT_CONFIRM -> FILLED", async function () {
    // inputAmount == outputAmount == "1000000" (1 USDC, within 1000 USDC threshold) -> fillImmediate = true.
    // Default smock fake behaviour (no revert) makes willSucceed return succeed: true.
    const msg = makeDepositMessage();
    const receipt = makeReceipt();

    relayer.queryGaslessApiFn = async () => [msg];
    relayer.initiateGaslessDepositFn = async () => receipt;
    relayer.extractDepositFromReceiptFn = () => makeFakeDepositEvent();
    relayer.initiateFillFn = async () => receipt;

    await relayer.runEvaluateApiSignatures();

    expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.FILLED);
    // Immediate path: fill was submitted before deposit confirmed, so deposit was built
    // synthetically rather than extracted from the receipt.
    expect(relayer.extractDepositFromReceiptCalls).to.equal(0);
    expect(relayer.initiateFillCalls).to.be.gte(1);
  });

  it("Immediate fill fallback: simulation failure falls back to standard path", async function () {
    // Same amounts as test above (fillImmediate initially true).
    // Configure the smock fake to revert so willSucceed returns succeed: false.
    fakePeripherySmock.depositWithAuthorization.reverts("revert");

    const msg = makeDepositMessage();
    const receipt = makeReceipt();
    const depositEvent = makeFakeDepositEvent();

    relayer.queryGaslessApiFn = async () => [msg];
    relayer.initiateGaslessDepositFn = async () => receipt;
    relayer.extractDepositFromReceiptFn = () => depositEvent;
    relayer.initiateFillFn = async () => receipt;

    await relayer.runEvaluateApiSignatures();

    expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.FILLED);
    // Simulation failed, so the handler fell back to the standard path:
    // deposit was extracted from the receipt (not built synthetically).
    expect(relayer.extractDepositFromReceiptCalls).to.equal(1);
    expect(relayer.initiateFillCalls).to.equal(1);
  });
});
