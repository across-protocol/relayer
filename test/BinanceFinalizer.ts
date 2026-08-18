import { createSpyLogger, expect, sinon } from "./utils";
import {
  assertAllConfirmedBinanceDepositsAttributed,
  BinanceFinalizerDependencies,
  binanceFinalizer,
  getBinanceSweepRecipient,
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

  it("attributes L1 and L2 Binance deposits to their transaction senders", async function () {
    const l1Depositor = "0x0000000000000000000000000000000000000001";
    const l2Depositor = "0x0000000000000000000000000000000000000002";
    const deposits: BinanceDeposit[] = [
      { amount: 10, coin: "USDC", network: BINANCE_NETWORKS[CHAIN_IDs.MAINNET], txId: "l1", insertTime: 1 },
      { amount: 20, coin: "USDC", network: BINANCE_NETWORKS[CHAIN_IDs.BSC], txId: "l2", insertTime: 2 },
      { amount: 30, coin: "USDC", network: "UNSUPPORTED", txId: "other", insertTime: 3 },
    ];
    const ownedDeposits = await getOwnedBinanceDeposits(deposits, {
      [BINANCE_NETWORKS[CHAIN_IDs.MAINNET]]: {
        getTransactionReceipt: sinon.stub().resolves({ from: l1Depositor }),
      },
      [BINANCE_NETWORKS[CHAIN_IDs.BSC]]: {
        getTransactionReceipt: sinon.stub().resolves({ from: l2Depositor }),
      },
    });

    expect(ownedDeposits.map(({ txId, depositor }) => ({ txId, depositor }))).to.deep.equal([
      { txId: "l1", depositor: EvmAddress.from(l1Depositor).toNative() },
      { txId: "l2", depositor: EvmAddress.from(l2Depositor).toNative() },
    ]);
  });

  it("fails closed when a Binance deposit receipt cannot be resolved", async function () {
    const deposits: BinanceDeposit[] = [
      { amount: 10, coin: "USDC", network: BINANCE_NETWORKS[CHAIN_IDs.MAINNET], txId: "missing", insertTime: 1 },
    ];
    const ownedDeposits = await getOwnedBinanceDeposits(deposits, {
      [BINANCE_NETWORKS[CHAIN_IDs.MAINNET]]: {
        getTransactionReceipt: sinon.stub().rejects(new Error("RPC unavailable")),
      },
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
    } as unknown as BinanceFinalizerDependencies;
    const clients = getBinanceFinalizerTestClients(sinon.stub().rejects(new Error("RPC unavailable")));
    await expect(
      binanceFinalizer(
        createSpyLogger().spyLogger,
        clients.signer,
        {} as never,
        clients.l2,
        clients.l1,
        new Map([[EvmAddress.from("0x0000000000000000000000000000000000000001"), ["USDC"]]]),
        dependencies
      )
    ).to.be.rejectedWith("Cannot safely finalize 1 confirmed Binance deposit");
  });

  it("finalizes same-coin deposits by EOA and excludes a prior orphan sweep on rerun", async function () {
    const first = "0x0000000000000000000000000000000000000001";
    const second = "0x0000000000000000000000000000000000000002";
    const deposits: BinanceDeposit[] = [
      {
        amount: 10,
        coin: "USDC",
        network: BINANCE_NETWORKS[CHAIN_IDs.MAINNET],
        txId: "l1-deposit",
        insertTime: 1,
        status: 1,
      },
      {
        amount: 20,
        coin: "USDC",
        network: BINANCE_NETWORKS[CHAIN_IDs.BSC],
        txId: "l2-deposit",
        insertTime: 2,
        status: 1,
      },
    ];
    const submitted: Array<Record<string, unknown> & { id: string }> = [];
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
      isEVMSpokePoolClient: sinon.stub().returns(true),
      submitBinanceWithdrawal: sinon.stub().callsFake(async (_api, withdrawal) => {
        const result = { ...withdrawal, id: `withdrawal-${submitted.length}` };
        submitted.push(result);
        return result;
      }),
      constructAdapter: sinon.stub().resolves({ getPendingRebalances: sinon.stub().resolves({}) } as never),
    } as unknown as BinanceFinalizerDependencies;

    const receipt = (txId: string) => ({ from: txId === "l2-deposit" ? second : first });
    const clients = getBinanceFinalizerTestClients(sinon.stub().callsFake(receipt));
    const addresses = new Map([
      [EvmAddress.from(first), ["USDC"]],
      [EvmAddress.from(second), ["USDC"]],
    ]);
    await binanceFinalizer(
      createSpyLogger().spyLogger,
      clients.signer,
      {} as never,
      clients.l2,
      clients.l1,
      addresses,
      dependencies
    );

    expect(submitted.map(({ address, network, amount }) => ({ address, network, amount }))).to.deep.equal([
      { address: EvmAddress.from(first).toNative(), network: BINANCE_NETWORKS[CHAIN_IDs.BSC], amount: 10 },
      { address: EvmAddress.from(second).toNative(), network: BINANCE_NETWORKS[CHAIN_IDs.MAINNET], amount: 20 },
      { address: EvmAddress.from(first).toNative(), network: BINANCE_NETWORKS[CHAIN_IDs.MAINNET], amount: 0.9 },
    ]);
    expect(submitted[2].withdrawOrderId).to.match(/^across-finalizer-sweep-USDC-/);

    deposits.push({
      amount: 5,
      coin: "USDC",
      network: BINANCE_NETWORKS[CHAIN_IDs.BSC],
      txId: "later-l2-deposit",
      insertTime: 3,
      status: 1,
    });

    await binanceFinalizer(
      createSpyLogger().spyLogger,
      clients.signer,
      {} as never,
      clients.l2,
      clients.l1,
      addresses,
      dependencies
    );
    expect(submitted).to.have.length(4);
    expect(submitted.slice(3).map(({ address, network, amount }) => ({ address, network, amount }))).to.deep.equal([
      { address: EvmAddress.from(first).toNative(), network: BINANCE_NETWORKS[CHAIN_IDs.MAINNET], amount: 5 },
    ]);
  });

  it("uses the first authorized EOA when multiple EOAs share a symbol", function () {
    const first = "0x0000000000000000000000000000000000000001";
    const second = "0x0000000000000000000000000000000000000002";
    const recipients = { [first]: ["USDC"], [second]: ["USDC"] };

    expect(getBinanceSweepRecipient(recipients, "USDC")).to.equal(EvmAddress.from(first).toNative());
  });

  it("uses the sole eligible EOA as the default orphan sweep recipient", function () {
    const recipient = "0x0000000000000000000000000000000000000001";

    expect(getBinanceSweepRecipient({ [recipient]: ["USDC"] }, "USDC")).to.equal(EvmAddress.from(recipient).toNative());
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

function getBinanceFinalizerTestClients(getTransactionReceipt: sinon.SinonStub) {
  const signer = {
    provider: {},
    getAddress: sinon.stub().resolves("0x0000000000000000000000000000000000000003"),
  } as never;
  const client = (chainId: number) =>
    ({ chainId, eventSearchConfig: { from: 0 }, spokePool: { provider: { getTransactionReceipt } } }) as never;
  return { signer, l1: client(CHAIN_IDs.MAINNET), l2: client(CHAIN_IDs.BSC) };
}
