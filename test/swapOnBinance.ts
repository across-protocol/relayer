import * as BinanceUtils from "../src/utils/BinanceUtils";
import {
  BINANCE_NETWORKS,
  BINANCE_WITHDRAWAL_STATUS,
  BigNumber,
  CHAIN_IDs,
  Coin,
  getNativeTokenInfoForChain,
  resolveAcrossToken,
  toBNWei,
} from "../src/utils";
import {
  BinanceSwapVenue,
  estimateDepositGasWithDeps,
  formatWithdrawalProgressLine,
  getBinanceWithdrawalAmount,
  requireDefinedFilledAmount,
  ResolvedBinanceAsset,
  resolveBinanceAsset,
  waitForBinanceDepositToBeAvailable,
  waitForBinanceOrderFillAndBalance,
  waitForBinanceWithdrawalCompletion,
} from "../scripts/swapOnBinance";
import { expect, sinon } from "./utils";

describe("swapOnBinance script helpers", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("only accepts the configured native token symbol and rejects Polygon native deposits without an atomic depositor", function () {
    const nativeSymbol = getNativeTokenInfoForChain(CHAIN_IDs.POLYGON).symbol.toUpperCase();
    const alternateSymbol = nativeSymbol === "POL" ? "MATIC" : "POL";
    const accountCoins = [makeNativeCoin("POL", CHAIN_IDs.POLYGON)];

    const nativeDeposit = resolveBinanceAsset({
      accountCoins,
      tokenSymbol: nativeSymbol,
      chainId: CHAIN_IDs.POLYGON,
      direction: "deposit",
    });
    const nativeWithdrawal = resolveBinanceAsset({
      accountCoins,
      tokenSymbol: nativeSymbol,
      chainId: CHAIN_IDs.POLYGON,
      direction: "withdraw",
    });
    const alternateResolution = resolveBinanceAsset({
      accountCoins,
      tokenSymbol: alternateSymbol,
      chainId: CHAIN_IDs.POLYGON,
      direction: "deposit",
    });

    expect(nativeDeposit.ok).to.equal(false);
    if (!nativeDeposit.ok) {
      expect(nativeDeposit.reason).to.equal("NATIVE_SOURCE_ATOMIC_DEPOSITOR_REQUIRED");
    }

    expect(nativeWithdrawal.ok).to.equal(true);
    if (nativeWithdrawal.ok) {
      expect(nativeWithdrawal.asset.isNativeAsset).to.equal(true);
      expect(nativeWithdrawal.asset.binanceCoin).to.equal("POL");
    }

    expect(alternateResolution.ok).to.equal(false);
  });

  it("accepts native ETH deposits on chains with an atomic depositor deployment", function () {
    const nativeSymbol = getNativeTokenInfoForChain(CHAIN_IDs.MAINNET).symbol.toUpperCase();
    const accountCoins = [makeNativeCoin("ETH", CHAIN_IDs.MAINNET)];

    const resolution = resolveBinanceAsset({
      accountCoins,
      tokenSymbol: nativeSymbol,
      chainId: CHAIN_IDs.MAINNET,
      direction: "deposit",
    });

    expect(resolution.ok).to.equal(true);
    if (resolution.ok) {
      expect(resolution.asset.isNativeAsset).to.equal(true);
      expect(resolution.asset.depositMode).to.equal("native");
      expect(resolution.asset.binanceCoin).to.equal("ETH");
    }
  });

  it("accepts native SOL withdrawals on Solana", function () {
    const accountCoins = [makeNativeCoin("SOL", CHAIN_IDs.SOLANA)];

    const resolution = resolveBinanceAsset({
      accountCoins,
      tokenSymbol: "SOL",
      chainId: CHAIN_IDs.SOLANA,
      direction: "withdraw",
    });

    expect(resolution.ok).to.equal(true);
    if (resolution.ok) {
      expect(resolution.asset.isNativeAsset).to.equal(true);
      expect(resolution.asset.binanceCoin).to.equal("SOL");
      expect(resolution.asset.network.name).to.equal("SOL");
      expect(resolution.asset.tokenDecimals).to.equal(9);
    }
  });

  it("rejects Solana source deposits because deposit execution is EVM-only", function () {
    const accountCoins = [makeErc20Coin("USDC", [{ chainId: CHAIN_IDs.SOLANA }])];

    const resolution = resolveBinanceAsset({
      accountCoins,
      tokenSymbol: "USDC",
      chainId: CHAIN_IDs.SOLANA,
      direction: "deposit",
    });

    expect(resolution).to.deep.equal({ ok: false, reason: "SVM_SOURCE_DEPOSIT_UNSUPPORTED" });
  });

  it("uses token-specific mappings for non-L1 token symbols", function () {
    const usdbcAddress = resolveAcrossToken("USDbC", CHAIN_IDs.BASE)!;
    const accountCoins = [
      makeErc20Coin("USDC", [
        {
          chainId: CHAIN_IDs.BASE,
          contractAddress: usdbcAddress,
        },
      ]),
    ];

    const resolution = resolveBinanceAsset({
      accountCoins,
      tokenSymbol: "USDbC",
      chainId: CHAIN_IDs.BASE,
      direction: "deposit",
    });

    expect(resolution.ok).to.equal(true);
    if (resolution.ok) {
      expect(resolution.asset.binanceCoin).to.equal("USDC");
      expect(resolution.asset.localTokenAddress).to.equal(usdbcAddress);
    }
  });

  it("rejects ERC20 routes when Binance contract metadata does not match the repo token address", function () {
    const accountCoins = [
      makeErc20Coin("USDC", [
        {
          chainId: CHAIN_IDs.POLYGON,
          contractAddress: "0x0000000000000000000000000000000000000001",
        },
      ]),
    ];

    const resolution = resolveBinanceAsset({
      accountCoins,
      tokenSymbol: "USDC",
      chainId: CHAIN_IDs.POLYGON,
      direction: "deposit",
    });

    expect(resolution).to.deep.equal({ ok: false, reason: "CONTRACT_ADDRESS_MISMATCH" });
  });

  it("compares Solana token contract addresses case-sensitively", function () {
    const solanaUsdc = resolveAcrossToken("USDC", CHAIN_IDs.SOLANA)!;
    const misCasedSolanaUsdc = `${solanaUsdc[0].toLowerCase()}${solanaUsdc.slice(1)}`;
    const accountCoins = [
      makeErc20Coin("USDC", [
        {
          chainId: CHAIN_IDs.SOLANA,
          contractAddress: misCasedSolanaUsdc,
        },
      ]),
    ];

    const resolution = resolveBinanceAsset({
      accountCoins,
      tokenSymbol: "USDC",
      chainId: CHAIN_IDs.SOLANA,
      direction: "withdraw",
    });

    expect(misCasedSolanaUsdc.toLowerCase()).to.equal(solanaUsdc.toLowerCase());
    expect(misCasedSolanaUsdc).to.not.equal(solanaUsdc);
    expect(resolution).to.deep.equal({ ok: false, reason: "CONTRACT_ADDRESS_MISMATCH" });
  });

  it("rejects same-coin routes because the script only supports swaps", async function () {
    const venue = new BinanceSwapVenue({} as never);
    const source = makeResolvedAsset({
      tokenSymbol: "USDC",
      chainId: CHAIN_IDs.POLYGON,
      binanceCoin: "USDC",
      contractAddress: resolveAcrossToken("USDC", CHAIN_IDs.POLYGON)!,
      withdrawFee: "0.25",
    });
    const destination = makeResolvedAsset({
      tokenSymbol: "USDC",
      chainId: CHAIN_IDs.BASE,
      binanceCoin: "USDC",
      contractAddress: resolveAcrossToken("USDC", CHAIN_IDs.BASE)!,
      withdrawFee: "0.25",
    });

    await expectRejected(
      venue.getQuote(source, destination, toBNWei("100", 6)),
      "This script only supports swap routes"
    );
  });

  it("computes swapped-route quote components with trade, slippage, and withdrawal fees", async function () {
    const venue = new BinanceSwapVenue({
      exchangeInfo: sinon.stub().resolves({
        symbols: [makeStablecoinMarketSymbol()],
      }),
      book: sinon.stub().resolves(
        makeOrderBook({
          asks: [
            { price: "1.0000", quantity: "100" },
            { price: "1.0100", quantity: "100" },
          ],
          bids: [],
        })
      ),
      tradeFee: sinon.stub().resolves([{ symbol: "USDCUSDT", takerCommission: "0.1" }]),
    } as never);
    const source = makeResolvedAsset({
      tokenSymbol: "USDT",
      chainId: CHAIN_IDs.POLYGON,
      binanceCoin: "USDT",
      contractAddress: resolveAcrossToken("USDT", CHAIN_IDs.POLYGON)!,
    });
    const destination = makeResolvedAsset({
      tokenSymbol: "USDC",
      chainId: CHAIN_IDs.BASE,
      binanceCoin: "USDC",
      contractAddress: resolveAcrossToken("USDC", CHAIN_IDs.BASE)!,
      withdrawFee: "0.25",
    });

    const quote = await venue.getQuote(source, destination, toBNWei("150", 6));

    expect(quote.latestPrice).to.equal(1.01);
    expect(quote.slippagePct).to.be.closeTo(1, 1e-9);
    expect(quote.tradeFeeSourceToken.eq(toBNWei("15", 6))).to.equal(true);
    expect(quote.slippageFeeSourceToken.eq(toBNWei("1.5", 6))).to.equal(true);
    expect(quote.withdrawalFeeDestinationToken.eq(toBNWei("0.25", 6))).to.equal(true);
    expect(quote.withdrawalFeeSourceToken.eq(toBNWei("0.25", 6))).to.equal(true);
    expect(quote.totalFeeSourceToken.eq(toBNWei("16.75", 6))).to.equal(true);
    expect(quote.expectedDestinationAmount.eq(toBNWei("148.514851", 6))).to.equal(true);
    expect(quote.expectedNetDestinationAmount.eq(toBNWei("133.264851", 6))).to.equal(true);
  });

  it("rejects orders that are smaller than Binance minimum size", async function () {
    const venue = new BinanceSwapVenue({
      exchangeInfo: sinon.stub().resolves({
        symbols: [
          {
            ...makeStablecoinMarketSymbol(),
            filters: [
              { filterType: "PRICE_FILTER", tickSize: "0.0001" },
              { filterType: "LOT_SIZE", stepSize: "0.01", minQty: "200.00" },
            ],
          },
        ],
      }),
      book: sinon.stub().resolves(
        makeOrderBook({
          asks: [{ price: "1.0000", quantity: "1000" }],
          bids: [],
        })
      ),
    } as never);

    await expectRejected(
      venue.getQuantityForOrder(
        makeResolvedAsset({
          tokenSymbol: "USDT",
          chainId: CHAIN_IDs.POLYGON,
          binanceCoin: "USDT",
          contractAddress: resolveAcrossToken("USDT", CHAIN_IDs.POLYGON)!,
        }),
        makeResolvedAsset({
          tokenSymbol: "USDC",
          chainId: CHAIN_IDs.BASE,
          binanceCoin: "USDC",
          contractAddress: resolveAcrossToken("USDC", CHAIN_IDs.BASE)!,
        }),
        toBNWei("50", 6)
      ),
      "minimum order size"
    );
  });

  it("fails when order-book depth is insufficient for the requested size", async function () {
    const venue = new BinanceSwapVenue({
      exchangeInfo: sinon.stub().resolves({
        symbols: [makeStablecoinMarketSymbol()],
      }),
      book: sinon.stub().resolves(
        makeOrderBook({
          asks: [{ price: "1.0010", quantity: "10" }],
          bids: [],
        })
      ),
    } as never);

    await expectRejected(
      venue.getLatestPrice("USDT", "USDC", 6, toBNWei("1000", 6)),
      "exceeds visible Binance order book depth"
    );
  });

  it("fails fast when the filled amount is not yet available from Binance order history", function () {
    expect(() => requireDefinedFilledAmount(undefined, "cloid-1", "TRX")).to.throw(
      "Filled amount for Binance order cloid-1 (TRX) is not available yet from Binance order history"
    );
  });

  it("converts withdrawal amount strings without float precision loss", function () {
    const amount = getBinanceWithdrawalAmount("123456789012345.123456789", 6);

    expect(amount.eq(toBNWei("123456789012345.123456", 6))).to.equal(true);
  });

  it("subtracts realized fill commission using Binance fill trades", async function () {
    const allOrders = sinon.stub().resolves([
      {
        orderId: 42,
        clientOrderId: "cloid-1",
        status: "FILLED",
        side: "BUY",
        executedQty: "149.25",
        cummulativeQuoteQty: "150",
      },
    ]);
    const myTrades = sinon.stub().resolves([
      { id: 1, commissionAsset: "USDC", commission: "0.25" },
      { id: 2, commissionAsset: "BNB", commission: "0.10" },
    ]);
    const venue = new BinanceSwapVenue({
      exchangeInfo: sinon.stub().resolves({
        symbols: [makeStablecoinMarketSymbol()],
      }),
      allOrders,
      myTrades,
    } as never);

    const expectedAmountToReceive = await venue.getExpectedAmountToReceiveForFilledOrder(
      42,
      "cloid-1",
      makeResolvedAsset({
        tokenSymbol: "USDT",
        chainId: CHAIN_IDs.POLYGON,
        binanceCoin: "USDT",
        contractAddress: resolveAcrossToken("USDT", CHAIN_IDs.POLYGON)!,
      }),
      makeResolvedAsset({
        tokenSymbol: "USDC",
        chainId: CHAIN_IDs.BASE,
        binanceCoin: "USDC",
        contractAddress: resolveAcrossToken("USDC", CHAIN_IDs.BASE)!,
      })
    );

    expect(expectedAmountToReceive).to.equal(149);
    expect(myTrades.calledOnce).to.equal(true);
  });

  it("throws a clear error when Binance trade fees are missing for the market symbol", async function () {
    const venue = new BinanceSwapVenue({
      exchangeInfo: sinon.stub().resolves({
        symbols: [makeStablecoinMarketSymbol()],
      }),
      book: sinon.stub().resolves(
        makeOrderBook({
          asks: [{ price: "1.0000", quantity: "100" }],
          bids: [],
        })
      ),
      tradeFee: sinon.stub().resolves([]),
    } as never);

    await expectRejected(
      venue.getQuote(
        makeResolvedAsset({
          tokenSymbol: "USDT",
          chainId: CHAIN_IDs.POLYGON,
          binanceCoin: "USDT",
          contractAddress: resolveAcrossToken("USDT", CHAIN_IDs.POLYGON)!,
        }),
        makeResolvedAsset({
          tokenSymbol: "USDC",
          chainId: CHAIN_IDs.BASE,
          binanceCoin: "USDC",
          contractAddress: resolveAcrossToken("USDC", CHAIN_IDs.BASE)!,
        }),
        toBNWei("10", 6)
      ),
      "Trade fee percentage not found for symbol USDCUSDT"
    );
  });

  it("waits for a Binance deposit record even if free balance is already sufficient", async function () {
    const venue = new BinanceSwapVenue({} as never);
    sinon
      .stub(BinanceUtils, "getBinanceDeposits")
      .onCall(0)
      .resolves([])
      .onCall(1)
      .resolves([makeDeposit({ txId: "0xabc", status: 0, network: "MATIC", coin: "USDC" })])
      .onCall(2)
      .resolves([makeDeposit({ txId: "0xabc", status: 6, network: "MATIC", coin: "USDC" })]);
    sinon.stub(venue, "getSpotFreeBalance").onCall(0).resolves(100).onCall(1).resolves(100).onCall(2).resolves(100);

    const availability = await waitForBinanceDepositToBeAvailable({
      venue,
      source: makeResolvedAsset({
        tokenSymbol: "USDC",
        chainId: CHAIN_IDs.POLYGON,
        binanceCoin: "USDC",
        contractAddress: resolveAcrossToken("USDC", CHAIN_IDs.POLYGON)!,
      }),
      depositTxHash: "0xabc",
      minFreeBalance: 100,
      startTimeMs: 0,
      pollDelayMs: 0,
    });

    expect(availability.attempts).to.equal(3);
    expect(availability.deposit.status).to.equal(6);
    expect(availability.freeBalance).to.equal(100);
  });

  it("waits for a filled order until the destination balance is withdrawable", async function () {
    const venue = new BinanceSwapVenue({} as never);
    sinon
      .stub(venue, "getMatchingFillForCloid")
      .onCall(0)
      .resolves(undefined)
      .onCall(1)
      .resolves({
        matchingFill: {
          clientOrderId: "cloid-1",
          status: "FILLED",
          executedQty: "149.25",
          cummulativeQuoteQty: "150",
        } as never,
        expectedAmountToReceive: "149.25",
      });
    sinon.stub(venue, "getSpotFreeBalance").onCall(0).resolves(20).onCall(1).resolves(149.25);

    const availability = await waitForBinanceOrderFillAndBalance({
      venue,
      cloid: "cloid-1",
      source: makeResolvedAsset({
        tokenSymbol: "USDT",
        chainId: CHAIN_IDs.POLYGON,
        binanceCoin: "USDT",
        contractAddress: resolveAcrossToken("USDT", CHAIN_IDs.POLYGON)!,
      }),
      destination: makeResolvedAsset({
        tokenSymbol: "USDC",
        chainId: CHAIN_IDs.BASE,
        binanceCoin: "USDC",
        contractAddress: resolveAcrossToken("USDC", CHAIN_IDs.BASE)!,
      }),
      pollDelayMs: 0,
    });

    expect(availability.attempts).to.equal(2);
    expect(availability.matchingFill.status).to.equal("FILLED");
    expect(availability.expectedAmountToReceive).to.equal("149.25");
  });

  it("waits for Binance withdrawals to complete", async function () {
    const venue = new BinanceSwapVenue({} as never);
    sinon
      .stub(BinanceUtils, "getBinanceWithdrawals")
      .onCall(0)
      .resolves([makeWithdrawal({ id: "withdraw-1", status: BINANCE_WITHDRAWAL_STATUS.PROCESSING, txId: "" })])
      .onCall(1)
      .resolves([makeWithdrawal({ id: "withdraw-1", status: BINANCE_WITHDRAWAL_STATUS.COMPLETED, txId: "0xdef" })]);

    const completion = await waitForBinanceWithdrawalCompletion({
      venue,
      destination: makeResolvedAsset({
        tokenSymbol: "USDC",
        chainId: CHAIN_IDs.BASE,
        binanceCoin: "USDC",
        contractAddress: resolveAcrossToken("USDC", CHAIN_IDs.BASE)!,
      }),
      withdrawalId: "withdraw-1",
      startTimeMs: 0,
      pollDelayMs: 0,
    });

    expect(completion.attempts).to.equal(2);
    expect(completion.withdrawal.status).to.equal(BINANCE_WITHDRAWAL_STATUS.COMPLETED);
    expect(completion.withdrawal.txId).to.equal("0xdef");
  });

  it("formats withdrawal progress before Binance exposes the history entry", function () {
    const line = formatWithdrawalProgressLine({ attempts: 1, elapsedMs: 1_200 });

    expect(line).to.equal("[poll 1, elapsed: 1s] withdrawal=not-seen amount=unknown");
  });

  it("surfaces rejected Binance withdrawals immediately", async function () {
    const venue = new BinanceSwapVenue({} as never);
    sinon
      .stub(BinanceUtils, "getBinanceWithdrawals")
      .resolves([makeWithdrawal({ id: "withdraw-2", status: BINANCE_WITHDRAWAL_STATUS.REJECTED })]);

    await expectRejected(
      waitForBinanceWithdrawalCompletion({
        venue,
        destination: makeResolvedAsset({
          tokenSymbol: "USDC",
          chainId: CHAIN_IDs.BASE,
          binanceCoin: "USDC",
          contractAddress: resolveAcrossToken("USDC", CHAIN_IDs.BASE)!,
        }),
        withdrawalId: "withdraw-2",
        startTimeMs: 0,
        pollDelayMs: 0,
      }),
      "failed with status rejected"
    );
  });

  it("uses a dependent-step gas fallback when a bridge simulation waits on a prior approval", async function () {
    const simulateTransaction = sinon
      .stub()
      .onFirstCall()
      .resolves({
        succeed: true,
        transaction: { gasLimit: BigNumber.from(50_000) },
      })
      .onSecondCall()
      .resolves({
        succeed: false,
        transaction: {},
        reason: "ERC20: insufficient allowance",
      });
    const estimateGasPrice = sinon.stub().resolves({
      maxFeePerGas: BigNumber.from(2),
      maxPriorityFeePerGas: BigNumber.from(1),
    });

    const estimate = await estimateDepositGasWithDeps(
      {
        steps: [
          {
            label: "approve",
            transaction: {
              contract: { provider: {} },
              method: "approve",
              args: [],
            },
          },
          {
            label: "bridge",
            transaction: {
              contract: { provider: {} },
              method: "bridgeWeth",
              args: [],
            },
          },
        ],
      } as never,
      { priorityFeeScaler: 1.2, maxFeePerGasScaler: 3 },
      { willSucceed: simulateTransaction as never, getGasPrice: estimateGasPrice as never }
    );

    expect(estimate.gasLimit.eq(BigNumber.from(300_000))).to.equal(true);
    expect(estimate.gasCost.eq(BigNumber.from(600_000))).to.equal(true);
  });
});

async function expectRejected<T>(promise: Promise<T>, message: string): Promise<void> {
  try {
    await promise;
    expect.fail(`Expected promise to reject with message containing: ${message}`);
  } catch (error) {
    expect(String(error)).to.contain(message);
  }
}

function makeResolvedAsset({
  tokenSymbol,
  chainId,
  binanceCoin,
  contractAddress,
  withdrawFee = "0.1",
}: {
  tokenSymbol: string;
  chainId: number;
  binanceCoin: string;
  contractAddress?: string;
  withdrawFee?: string;
}): ResolvedBinanceAsset {
  const tokenDecimals = tokenSymbol === "ETH" ? 18 : 6;
  const nativeSymbol = getNativeTokenInfoForChain(chainId).symbol.toUpperCase();
  return {
    tokenSymbol,
    chainId,
    binanceCoin,
    tokenDecimals,
    isNativeAsset: tokenSymbol.toUpperCase() === nativeSymbol,
    localTokenAddress: contractAddress,
    network: {
      name: getTestBinanceNetworkName(chainId),
      coin: binanceCoin,
      withdrawFee,
      withdrawMin: "0.01",
      withdrawMax: "1000000",
      contractAddress: contractAddress ?? "",
      depositEnable: true,
      withdrawEnable: true,
    },
  };
}

function makeNativeCoin(symbol: string, chainId: number): Coin {
  return {
    symbol,
    balance: "0",
    networkList: [
      {
        name: getTestBinanceNetworkName(chainId),
        coin: symbol,
        withdrawMin: "0.01",
        withdrawMax: "1000000",
        contractAddress: "",
        withdrawFee: "0.1",
        depositEnable: true,
        withdrawEnable: true,
      },
    ],
  };
}

function makeErc20Coin(
  symbol: string,
  networks: Array<{
    chainId: number;
    contractAddress?: string;
  }>
): Coin {
  return {
    symbol,
    balance: "0",
    networkList: networks.map(({ chainId, contractAddress }) => ({
      name: getTestBinanceNetworkName(chainId),
      coin: symbol,
      withdrawMin: "0.01",
      withdrawMax: "1000000",
      contractAddress: contractAddress ?? resolveAcrossToken(symbol, chainId)!,
      withdrawFee: "0.1",
      depositEnable: true,
      withdrawEnable: true,
    })),
  };
}

function makeStablecoinMarketSymbol() {
  return {
    symbol: "USDCUSDT",
    baseAsset: "USDC",
    quoteAsset: "USDT",
    filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.0001" },
      { filterType: "LOT_SIZE", stepSize: "0.01", minQty: "0.01" },
    ],
  };
}

function makeOrderBook({
  asks,
  bids,
}: {
  asks: Array<{ price: string; quantity: string }>;
  bids: Array<{ price: string; quantity: string }>;
}) {
  return { asks, bids };
}

function makeDeposit({ txId, status, network, coin }: { txId: string; status: number; network: string; coin: string }) {
  return {
    amount: 100,
    coin,
    network,
    txId,
    insertTime: Date.now(),
    status,
  };
}

function makeWithdrawal({ id, status, txId }: { id: string; status: number; txId?: string }) {
  return {
    id,
    amount: 100,
    coin: "USDC",
    network: "BASE",
    recipient: "0x1111111111111111111111111111111111111111",
    ...(txId !== undefined ? { txId } : {}),
    transactionFee: 0.1,
    applyTime: new Date().toISOString(),
    status,
  };
}

function getTestBinanceNetworkName(chainId: number): string {
  return BINANCE_NETWORKS[chainId] ?? "UNKNOWN";
}
