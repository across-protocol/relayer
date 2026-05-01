import { expect, sinon } from "./utils";
import {
  getEvmBinanceRebalanceLookupAccounts,
  getPendingBinanceRebalanceSymbolsForAccount,
  getPendingBinanceRebalanceSymbols,
  getSweepableOrphanBinanceBalance,
} from "../src/finalizer/utils/binance";
import { EvmAddress } from "../src/utils";

describe("Binance finalizer helpers", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("collects Binance symbols from pending rebalancer orders", function () {
    const symbols = getPendingBinanceRebalanceSymbols([
      {
        sourceToken: "USDT",
        destinationToken: "USDC",
      },
      {
        sourceToken: "WETH",
        destinationToken: "USDT",
      },
    ]);

    expect([...symbols].sort()).to.deep.equal(["ETH", "USDC", "USDT"]);
  });

  it("subtracts credited and swap deposits from orphan sweep candidates", function () {
    const sweepableBalance = getSweepableOrphanBinanceBalance(250_000, 10_000, 20_000);

    expect(sweepableBalance).to.equal(220_000);
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

  it("treats pending rebalance Redis lookup failures as an empty sweep guard", async function () {
    const logger = { warn: sinon.stub() };
    const account = EvmAddress.from("0x0000000000000000000000000000000000000001");
    const getRedisCache = sinon.stub().rejects(new Error("temporary redis outage"));

    const symbols = await getPendingBinanceRebalanceSymbolsForAccount(logger as never, account, getRedisCache);

    expect([...symbols]).to.deep.equal([]);
    expect(logger.warn.calledOnce).to.equal(true);
    expect(logger.warn.firstCall.args[0]).to.include({
      at: "BinanceFinalizer",
      account: account.toNative(),
      error: "temporary redis outage",
    });
  });
});
