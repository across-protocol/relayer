import { createSpyLogger, expect, sinon } from "./utils";
import {
  assertAllConfirmedBinanceDepositsAttributed,
  BinanceFinalizerDependencies,
  binanceFinalizer,
  getEvmBinanceRebalanceLookupAccounts,
  getOwnedBinanceDeposits,
  getPositivePendingRebalanceAmountsByBinanceCoin,
  getSweepableOrphanBinanceBalance,
} from "../src/finalizer/utils/binance";
import {
  BinanceDeposit,
  BINANCE_NETWORKS,
  BinanceTransactionType,
  BINANCE_WITHDRAWAL_STATUS,
  bnZero,
  CHAIN_IDs,
  EvmAddress,
  toBNWei,
} from "../src/utils";

const FIRST_EOA = "0x0000000000000000000000000000000000000001";
const SECOND_EOA = "0x0000000000000000000000000000000000000002";
const BINANCE_ADDRESS = "0x0000000000000000000000000000000000000011";

describe("Binance finalizer helpers", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("converts positive Binance pending rebalances into withdrawal deductions", function () {
    const deductions = getPositivePendingRebalanceAmountsByBinanceCoin({
      [CHAIN_IDs.MAINNET]: {
        USDC: toBNWei("100", 6),
        WETH: toBNWei("1", 18),
        USDT: bnZero.sub(toBNWei("10", 6)),
      },
    });

    expect(deductions).to.deep.equal({ USDC: 100, ETH: 1 });
  });

  it("nets pending rebalance amounts by Binance coin before applying positive deductions", function () {
    const deductions = getPositivePendingRebalanceAmountsByBinanceCoin({
      [CHAIN_IDs.MAINNET]: {
        USDC: toBNWei("100", 6),
      },
      [CHAIN_IDs.ARBITRUM]: {
        USDC: bnZero.sub(toBNWei("40", 6)),
        WETH: bnZero.sub(toBNWei("1", 18)),
      },
    });

    expect(deductions).to.deep.equal({ USDC: 60 });
  });

  it("resolves logical USDC symbol on BSC where the on-chain symbol is USDC-BNB", function () {
    const deductions = getPositivePendingRebalanceAmountsByBinanceCoin({
      [CHAIN_IDs.BSC]: {
        USDC: toBNWei("50", 18),
      },
    });

    expect(deductions).to.deep.equal({ USDC: 50 });
  });

  it("resolves logical USDT symbol on BSC where the on-chain symbol is USDT-BNB", function () {
    const deductions = getPositivePendingRebalanceAmountsByBinanceCoin({
      [CHAIN_IDs.BSC]: {
        USDT: toBNWei("75", 18),
      },
    });

    expect(deductions).to.deep.equal({ USDT: 75 });
  });

  it("subtracts credited, swap, pending rebalance, and attributed amounts from orphan sweep candidates", function () {
    const sweepableBalance = getSweepableOrphanBinanceBalance(250_000, 10_000, 20_000, 30_000, 40_000);

    expect(sweepableBalance).to.equal(150_000);
  });

  it("does not query Binance when no symbols are configured", async function () {
    const dependencies = {
      isEVMSpokePoolClient: sinon.stub().returns(true),
    } as unknown as BinanceFinalizerDependencies;

    await runTestFinalizer(dependencies, new Map());
  });

  it("attributes L1 and L2 Binance deposits to their transaction senders", async function () {
    const l1Depositor = FIRST_EOA;
    const l2Depositor = SECOND_EOA;
    const deposits: BinanceDeposit[] = [
      makeDeposit({
        amount: 10,
        txId: "l1",
      }),
      makeDeposit({
        amount: 20,
        network: BINANCE_NETWORKS[CHAIN_IDs.BSC],
        txId: "l2",
        address: "0x0000000000000000000000000000000000000022",
        insertTime: 2,
      }),
      makeDeposit({
        amount: 30,
        network: "UNSUPPORTED",
        txId: "other",
        address: "0x0000000000000000000000000000000000000033",
        insertTime: 3,
      }),
    ];
    const queryTransfers = sinon.stub().callsFake(async (_provider, _eventConfig, _token, recipient) => [
      {
        transactionHash: recipient === deposits[0].address ? "l1" : "l2",
        from: recipient === deposits[0].address ? l1Depositor : l2Depositor,
      },
    ]);
    const ownedDeposits = await getOwnedBinanceDeposits(
      deposits,
      {
        [BINANCE_NETWORKS[CHAIN_IDs.MAINNET]]: getDepositAttributionTestClient(CHAIN_IDs.MAINNET),
        [BINANCE_NETWORKS[CHAIN_IDs.BSC]]: getDepositAttributionTestClient(CHAIN_IDs.BSC),
      },
      queryTransfers
    );

    expect(ownedDeposits.map(({ txId, depositor }) => ({ txId, depositor }))).to.deep.equal([
      { txId: "l1", depositor: EvmAddress.from(l1Depositor).toNative() },
      { txId: "l2", depositor: EvmAddress.from(l2Depositor).toNative() },
    ]);
    expect(queryTransfers.callCount).to.equal(2);
  });

  it("uses the transaction receipt for native ETH deposits", async function () {
    const depositor = FIRST_EOA;
    const deposit = makeDeposit({
      coin: "ETH",
      txId: "native",
    });
    const client = getDepositAttributionTestClient(CHAIN_IDs.MAINNET);
    client.provider.getTransactionReceipt = sinon.stub().resolves({ from: depositor });

    const ownedDeposits = await getOwnedBinanceDeposits([deposit], {
      [BINANCE_NETWORKS[CHAIN_IDs.MAINNET]]: client,
    });

    expect(ownedDeposits[0].depositor).to.equal(EvmAddress.from(depositor).toNative());
  });

  it("falls back to a receipt when an ERC20 transfer log query fails", async function () {
    const depositor = FIRST_EOA;
    const deposit = makeDeposit({
      txId: "missing-log",
    });
    const client = getDepositAttributionTestClient(CHAIN_IDs.MAINNET);
    client.eventSearchConfig = { from: 0, to: 0, maxLookBack: 1 };
    client.provider.getTransactionReceipt = sinon.stub().resolves({ from: depositor });

    const ownedDeposits = await getOwnedBinanceDeposits(
      [deposit],
      { [BINANCE_NETWORKS[CHAIN_IDs.MAINNET]]: client },
      sinon.stub().rejects(new Error("RPC unavailable"))
    );

    expect(ownedDeposits[0].depositor).to.equal(EvmAddress.from(depositor).toNative());
  });

  it("batches receipt fallbacks and retries a missing receipt", async function () {
    const depositor = FIRST_EOA;
    const deposits = Array.from({ length: 51 }, (_, index) =>
      makeDeposit({
        network: BINANCE_NETWORKS[CHAIN_IDs.BSC],
        txId: `deposit-${index}`,
      })
    );
    const client = getDepositAttributionTestClient(CHAIN_IDs.BSC);
    client.eventSearchConfig = { from: 0, to: 100, maxLookBack: 1 };
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const attempts = new Map<string, number>();
    client.provider.getTransactionReceipt = sinon.stub().callsFake(async (txId: string) => {
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setImmediate(resolve));
      activeRequests--;
      attempts.set(txId, (attempts.get(txId) ?? 0) + 1);
      return txId === deposits[0].txId && attempts.get(txId) === 1 ? null : { from: depositor };
    });
    const queryTransfers = sinon.stub();

    const ownedDeposits = await getOwnedBinanceDeposits(
      deposits,
      { [BINANCE_NETWORKS[CHAIN_IDs.BSC]]: client },
      queryTransfers
    );

    expect(ownedDeposits).to.have.length(51);
    expect(client.provider.getTransactionReceipt.callCount).to.equal(52);
    expect(maxActiveRequests).to.equal(50);
    expect(queryTransfers.callCount).to.equal(0);
  });

  it("propagates receipt errors and fails closed when a native receipt is missing", async function () {
    const deposits = [
      makeDeposit({
        amount: 10,
        coin: "ETH",
        txId: "missing",
      }),
    ];
    const client = getDepositAttributionTestClient(CHAIN_IDs.MAINNET);
    client.provider.getTransactionReceipt = sinon.stub().rejects(new Error("RPC unavailable"));
    await expect(
      getOwnedBinanceDeposits(deposits, { [BINANCE_NETWORKS[CHAIN_IDs.MAINNET]]: client })
    ).to.be.rejectedWith("RPC unavailable");

    client.provider.getTransactionReceipt = sinon.stub().resolves(null);
    const ownedDeposits = await getOwnedBinanceDeposits(deposits, {
      [BINANCE_NETWORKS[CHAIN_IDs.MAINNET]]: client,
    });
    expect(ownedDeposits).to.deep.equal([]);
    expect(() => assertAllConfirmedBinanceDepositsAttributed([{ ...deposits[0], status: 1 }], ownedDeposits)).to.throw(
      "Cannot safely finalize 1 confirmed Binance deposit"
    );

    const dependencies = {
      isEVMSpokePoolClient: sinon.stub().returns(true),
      getBinanceApiClient: sinon.stub().resolves({} as never),
      getTimestampForBlock: sinon.stub().resolves(0),
      getBinanceDeposits: sinon.stub().resolves([{ ...deposits[0], status: 1 }]),
      getAccountCoins: sinon.stub().resolves([]),
      getBinanceDepositType: sinon.stub().resolves(BinanceTransactionType.UNKNOWN),
      getOwnedBinanceDeposits: sinon.stub().resolves([]),
    } as unknown as BinanceFinalizerDependencies;
    await expect(runTestFinalizer(dependencies, new Map([[EvmAddress.from(FIRST_EOA), ["ETH"]]]))).to.be.rejectedWith(
      "Cannot safely finalize 1 confirmed Binance deposit"
    );
  });

  it("finalizes deposits from non-BSC Binance routes on L1", async function () {
    const deposit = makeDeposit({
      amount: 10,
      coin: "USDT",
      network: BINANCE_NETWORKS[CHAIN_IDs.AVALANCHE],
      status: 1,
    });
    const submitted: Array<Record<string, unknown>> = [];
    const dependencies = {
      getTimestampForBlock: sinon.stub().resolves(0),
      getBinanceApiClient: sinon.stub().resolves({} as never),
      getBinanceDeposits: sinon.stub().resolves([deposit]),
      getAccountCoins: sinon.stub().resolves([
        {
          symbol: "USDT",
          balance: "10",
          networkList: [
            {
              name: BINANCE_NETWORKS[CHAIN_IDs.MAINNET],
              coin: "USDT",
              withdrawMin: "0.01",
              withdrawMax: "1000",
              withdrawFee: "0",
              contractAddress: "",
            },
          ],
        },
      ]),
      getBinanceDepositType: sinon.stub().resolves(BinanceTransactionType.UNKNOWN),
      getOwnedBinanceDeposits: sinon
        .stub()
        .callsFake(async (deposits: BinanceDeposit[]) =>
          deposits.map((deposit) => ({ ...deposit, depositor: EvmAddress.from(FIRST_EOA).toNative() }))
        ),
      getBinanceWithdrawals: sinon.stub().resolves([]),
      getBinanceWithdrawalType: sinon.stub(),
      isBinanceRoute: sinon.stub().callsFake((chainId) => chainId === CHAIN_IDs.AVALANCHE),
      isEVMSpokePoolClient: sinon.stub().returns(true),
      submitBinanceWithdrawal: sinon.stub().callsFake(async (_api, withdrawal) => {
        submitted.push(withdrawal);
        return { id: "withdrawal" };
      }),
      constructAdapter: sinon.stub().resolves({ getPendingRebalances: sinon.stub().resolves({}) } as never),
    } as unknown as BinanceFinalizerDependencies;

    await runTestFinalizer(dependencies, new Map([[EvmAddress.from(FIRST_EOA), ["USDT"]]]), [
      CHAIN_IDs.MAINNET,
      CHAIN_IDs.BSC,
      CHAIN_IDs.AVALANCHE,
    ]);

    expect(dependencies.getOwnedBinanceDeposits.firstCall.firstArg).to.deep.equal([deposit]);
    expect(submitted[0]).to.include({
      address: EvmAddress.from(FIRST_EOA).toNative(),
      network: BINANCE_NETWORKS[CHAIN_IDs.MAINNET],
      amount: 10,
    });
  });

  it("finalizes same-coin deposits by EOA and excludes a prior orphan sweep on rerun", async function () {
    const first = FIRST_EOA;
    const second = SECOND_EOA;
    const deposits: BinanceDeposit[] = [
      makeDeposit({
        amount: 10,
        txId: "l1-deposit",
        status: 1,
      }),
      makeDeposit({
        amount: 20,
        network: BINANCE_NETWORKS[CHAIN_IDs.BSC],
        txId: "l2-deposit",
        address: "0x0000000000000000000000000000000000000022",
        insertTime: 2,
        status: 1,
      }),
      makeDeposit({
        amount: 0.5,
        network: BINANCE_NETWORKS[CHAIN_IDs.OPTIMISM],
        txId: "unsupported-deposit",
        address: "0x0000000000000000000000000000000000000033",
        insertTime: 3,
        status: 1,
      }),
      makeDeposit({ coin: "DAI", txId: "unconfigured", status: 1 }),
      makeDeposit({ txId: "pending", status: 0 }),
    ];
    const submitted: Array<Record<string, unknown> & { id: string }> = [];
    const getOwnedBinanceDepositsStub = sinon.stub().callsFake(async (items: BinanceDeposit[]) =>
      items.map((deposit) => ({
        ...deposit,
        depositor: EvmAddress.from(deposit.txId === "l2-deposit" ? second : first).toNative(),
      }))
    );
    const coin = {
      symbol: "USDC",
      balance: "31.2",
      networkList: [BINANCE_NETWORKS[CHAIN_IDs.MAINNET], BINANCE_NETWORKS[CHAIN_IDs.BSC]].map((name) => ({
        name,
        coin: "USDC",
        withdrawMin: "0.01",
        withdrawMax: "1000",
        withdrawFee: "0.1",
        contractAddress: "",
      })),
    };
    const dependencies = {
      getTimestampForBlock: sinon.stub().resolves(0),
      getBinanceApiClient: sinon.stub().resolves({} as never),
      getBinanceDeposits: sinon.stub().resolves(deposits),
      getAccountCoins: sinon
        .stub()
        .onFirstCall()
        .resolves([coin])
        .onSecondCall()
        .resolves([{ ...coin, balance: "5.1" }]),
      getBinanceDepositType: sinon.stub().resolves(BinanceTransactionType.UNKNOWN),
      getOwnedBinanceDeposits: getOwnedBinanceDepositsStub,
      getBinanceWithdrawals: sinon.stub().callsFake(async () =>
        submitted.map((withdrawal) => ({
          ...withdrawal,
          amount: withdrawal.amount as number,
          coin: "USDC",
          recipient: withdrawal.address as string,
          txId: "",
          status: BINANCE_WITHDRAWAL_STATUS.COMPLETED,
          transactionFee: 0.1,
          applyTime: "",
        }))
      ),
      getBinanceWithdrawalType: sinon.stub().resolves(BinanceTransactionType.BRIDGE),
      isBinanceRoute: sinon.stub().returns(true),
      isEVMSpokePoolClient: sinon.stub().returns(true),
      submitBinanceWithdrawal: sinon.stub().callsFake(async (_api, withdrawal) => {
        const result = { ...withdrawal, id: `withdrawal-${submitted.length}` };
        submitted.push(result);
        return result;
      }),
      constructAdapter: sinon.stub().resolves({ getPendingRebalances: sinon.stub().resolves({}) } as never),
    } as unknown as BinanceFinalizerDependencies;

    const addresses = new Map([
      [EvmAddress.from(first), ["USDC"]],
      [EvmAddress.from(second), ["USDC"]],
    ]);
    await runTestFinalizer(dependencies, addresses);

    expect(submitted.map(({ address, network, amount }) => ({ address, network, amount }))).to.deep.equal([
      { address: EvmAddress.from(first).toNative(), network: BINANCE_NETWORKS[CHAIN_IDs.BSC], amount: 10 },
      { address: EvmAddress.from(second).toNative(), network: BINANCE_NETWORKS[CHAIN_IDs.MAINNET], amount: 20 },
      { address: EvmAddress.from(first).toNative(), network: BINANCE_NETWORKS[CHAIN_IDs.MAINNET], amount: 0.5 },
    ]);
    expect(submitted[2].withdrawOrderId).to.match(/^across-finalizer-sweep-USDC-/);
    expect(
      getOwnedBinanceDepositsStub.args.every(([items]) =>
        items.every(
          ({ coin, network, status }: BinanceDeposit) =>
            coin === "USDC" && network !== BINANCE_NETWORKS[CHAIN_IDs.OPTIMISM] && status === 1
        )
      )
    ).to.equal(true);

    deposits.push(
      makeDeposit({
        amount: 5,
        network: BINANCE_NETWORKS[CHAIN_IDs.BSC],
        txId: "later-l2-deposit",
        address: "0x0000000000000000000000000000000000000022",
        insertTime: 3,
        status: 1,
      })
    );

    await runTestFinalizer(dependencies, addresses);
    expect(submitted).to.have.length(4);
    expect(submitted.slice(3).map(({ address, network, amount }) => ({ address, network, amount }))).to.deep.equal([
      { address: EvmAddress.from(first).toNative(), network: BINANCE_NETWORKS[CHAIN_IDs.MAINNET], amount: 5 },
    ]);
  });

  it("skips non-EVM addresses when collecting pending rebalance accounts", function () {
    const evmAddress = "0x0000000000000000000000000000000000000001";
    const svmAddress = "11111111111111111111111111111111";

    const accounts = getEvmBinanceRebalanceLookupAccounts([evmAddress, svmAddress]);

    expect(accounts.map((account) => account.toNative())).to.deep.equal([EvmAddress.from(evmAddress).toNative()]);
  });

  it("includes the signer account when collecting pending rebalance accounts", function () {
    const recipientAddress = "0x0000000000000000000000000000000000000001";
    const signerAddress = "0x0000000000000000000000000000000000000002";

    const accounts = getEvmBinanceRebalanceLookupAccounts([recipientAddress], signerAddress);

    expect(accounts.map((account) => account.toNative())).to.deep.equal([
      EvmAddress.from(recipientAddress).toNative(),
      EvmAddress.from(signerAddress).toNative(),
    ]);
  });
});

function runTestFinalizer(
  dependencies: BinanceFinalizerDependencies,
  addresses = new Map([[EvmAddress.from(FIRST_EOA), ["USDC"]]]),
  chainIds = [CHAIN_IDs.MAINNET, CHAIN_IDs.BSC]
) {
  const signer = {
    provider: {},
    getAddress: sinon.stub().resolves("0x0000000000000000000000000000000000000003"),
  } as never;
  const client = (chainId: number) =>
    ({ chainId, eventSearchConfig: { from: 0 }, spokePool: { provider: {} } }) as never;
  const clients = Object.fromEntries(chainIds.map((chainId) => [chainId, client(chainId)]));
  return binanceFinalizer(
    createSpyLogger().spyLogger,
    signer,
    {} as never,
    client(CHAIN_IDs.BSC),
    client(CHAIN_IDs.MAINNET),
    addresses,
    clients,
    dependencies
  );
}

function getDepositAttributionTestClient(chainId: number) {
  return {
    chainId,
    provider: { getTransactionReceipt: sinon.stub() } as never,
    eventSearchConfig: { from: 0, to: 0 },
  };
}

function makeDeposit(overrides: Partial<BinanceDeposit> = {}): BinanceDeposit {
  return {
    amount: 1,
    coin: "USDC",
    network: BINANCE_NETWORKS[CHAIN_IDs.MAINNET],
    txId: "deposit",
    address: BINANCE_ADDRESS,
    insertTime: 1,
    ...overrides,
  };
}
