import { Contract } from "ethers";
import { GaslessDepositMessage, DepositWithBlock } from "../src/interfaces";
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
import { createSpyLogger, expect, sinon, smock, ethers, toBN } from "./utils";

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

  // Widen protected -> public so sinon.stub() type-checks without `as any`.
  public override async _queryGaslessApi(retries = 0): Promise<GaslessDepositMessage[]> {
    return super._queryGaslessApi(retries);
  }
  public override async initiateGaslessDeposit(msg: GaslessDepositMessage): Promise<TransactionReceipt | null> {
    return super.initiateGaslessDeposit(msg);
  }
  public override async initiateFill(
    deposit: StrippedDeposit
  ): Promise<TransactionReceipt | null> {
    return super.initiateFill(deposit);
  }
  public override _extractDepositFromTransactionReceipt(
    receipt: TransactionReceipt,
    originChainId: number
  ): StrippedDeposit {
    return super._extractDepositFromTransactionReceipt(receipt, originChainId);
  }
  public override async _findDeposit(
    originChainId: number,
    inputToken: Address,
    authorizer: string,
    nonce: string
  ): Promise<StrippedDeposit | undefined> {
    return super._findDeposit(originChainId, inputToken, authorizer, nonce);
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
    depositor: EvmAddress.from(DUMMY_ADDRESS),
    recipient: EvmAddress.from(DUMMY_ADDRESS),
    inputToken: EvmAddress.from(USDC_MAINNET),
    inputAmount: toBN(amounts.inputAmount ?? "1000000"),
    outputToken: EvmAddress.from(USDC_BASE),
    outputAmount: toBN(amounts.outputAmount ?? "1000000"),
    message: "0x",
    fillDeadline: getCurrentTime() + 3600,
    exclusiveRelayer: EvmAddress.from(DUMMY_ADDRESS),
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

  let queryApiStub: sinon.SinonStub;
  let initiateDepositStub: sinon.SinonStub;
  let initiateFillStub: sinon.SinonStub;
  let extractDepositStub: sinon.SinonStub;
  let findDepositStub: sinon.SinonStub;

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

    // Use smock fakes for periphery and spokePool contracts.
    fakePeriphery = await smock.fake<Contract>(SPOKE_POOL_PERIPHERY_ABI);
    // SpokePool fake uses a minimal ABI -- every method that touches it is stubbed.
    const fakeSpokePool: Contract = await smock.fake<Contract>([]);

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

    // Stub internal methods on the instance (public on TestableGaslessRelayer).
    queryApiStub = sinon.stub(relayer, "_queryGaslessApi");
    initiateDepositStub = sinon.stub(relayer, "initiateGaslessDeposit");
    initiateFillStub = sinon.stub(relayer, "initiateFill");
    extractDepositStub = sinon.stub(relayer, "_extractDepositFromTransactionReceipt");
    findDepositStub = sinon.stub(relayer, "_findDeposit");
  });

  afterEach(function () {
    sinon.restore();
    delete process.env.RELAYER_GASLESS_HANDLER;
  });

  it("Standard path: INITIAL -> DEPOSIT_PENDING -> FILL_PENDING -> FILLED", async function () {
    const msg = makeDepositMessage({ inputAmount: "2000000", outputAmount: "1900000" });
    const receipt = makeReceipt();
    const depositEvent = makeFakeDepositEvent({ inputAmount: "2000000", outputAmount: "1900000" });

    queryApiStub.resolves([msg]);
    initiateDepositStub.resolves(receipt);
    extractDepositStub.returns(depositEvent);
    initiateFillStub.resolves(receipt);

    await relayer.runEvaluateApiSignatures();

    expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.FILLED);
    expect(initiateDepositStub.calledOnce).to.be.true;
    expect(initiateFillStub.calledOnce).to.be.true;
    // Deposit was found via receipt, so _findDeposit should not have been needed.
    expect(findDepositStub.called).to.be.false;
  });

  it("Invalid deposit (mismatching L1 tokens) -> ERROR", async function () {
    // Use WETH as output token (different L1 token from USDC input).
    const msg = makeDepositMessage({
      inputToken: USDC_MAINNET,
      outputToken: WETH_BASE,
    });

    queryApiStub.resolves([msg]);

    await relayer.runEvaluateApiSignatures();

    expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.ERROR);
    expect(initiateDepositStub.called).to.be.false;
  });

  it("Expired deposit -> ERROR", async function () {
    // Set fillDeadline in the past.
    const msg = makeDepositMessage({ fillDeadline: getCurrentTime() - 100 });

    queryApiStub.resolves([msg]);

    await relayer.runEvaluateApiSignatures();

    expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.ERROR);
    expect(initiateDepositStub.called).to.be.false;
  });

  it("Deposit receipt null, recovered via _findDeposit", async function () {
    const msg = makeDepositMessage({ inputAmount: "2000000", outputAmount: "1900000" });
    const depositEvent = makeFakeDepositEvent({ inputAmount: "2000000", outputAmount: "1900000" });
    const receipt = makeReceipt();

    queryApiStub.resolves([msg]);
    // Deposit returns null (failed/skipped).
    initiateDepositStub.resolves(null);
    // _findDeposit locates the deposit on-chain.
    findDepositStub.resolves(depositEvent);
    initiateFillStub.resolves(receipt);

    await relayer.runEvaluateApiSignatures();

    expect(relayer.getMessageState(depositNonceFor(relayer, msg))).to.equal(MessageState.FILLED);
    expect(findDepositStub.calledOnce).to.be.true;
    expect(initiateFillStub.calledOnce).to.be.true;
  });
});
