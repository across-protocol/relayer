import { BINANCE_NETWORKS, CHAIN_IDs, toBNWei } from "../src/utils";
import { ResolvedBinanceAsset } from "../scripts/swapOnBinance";
import { buildSweepPlan } from "../scripts/sweepBinanceBalance";
import { expect } from "./utils";

describe("sweepBinanceBalance script helpers", function () {
  it("sweeps the full free balance when it is within Binance withdrawal limits", function () {
    const destination = makeResolvedAsset({
      tokenSymbol: "TRX",
      chainId: CHAIN_IDs.TRON,
      decimals: 6,
      withdrawMin: "10",
      withdrawMax: "1000",
      withdrawFee: "1.5",
    });

    const sweepPlan = buildSweepPlan({
      destination,
      freeBalance: toBNWei("100", 6),
    });

    expect(sweepPlan.withdrawalAmount.eq(toBNWei("100", 6))).to.equal(true);
    expect(sweepPlan.withdrawalFee.eq(toBNWei("1.5", 6))).to.equal(true);
    expect(sweepPlan.expectedRecipientAmount.eq(toBNWei("98.5", 6))).to.equal(true);
    expect(sweepPlan.residualBalance.eq(toBNWei("0", 6))).to.equal(true);
    expect(sweepPlan.cappedByWithdrawMax).to.equal(false);
  });

  it("caps the withdrawal at Binance withdraw max and leaves a residual balance", function () {
    const destination = makeResolvedAsset({
      tokenSymbol: "USDC",
      chainId: CHAIN_IDs.POLYGON,
      decimals: 6,
      withdrawMin: "10",
      withdrawMax: "250",
      withdrawFee: "0.12",
    });

    const sweepPlan = buildSweepPlan({
      destination,
      freeBalance: toBNWei("400", 6),
    });

    expect(sweepPlan.withdrawalAmount.eq(toBNWei("250", 6))).to.equal(true);
    expect(sweepPlan.expectedRecipientAmount.eq(toBNWei("249.88", 6))).to.equal(true);
    expect(sweepPlan.residualBalance.eq(toBNWei("150", 6))).to.equal(true);
    expect(sweepPlan.cappedByWithdrawMax).to.equal(true);
  });

  it("fails when the free balance is below Binance withdraw min", function () {
    const destination = makeResolvedAsset({
      tokenSymbol: "TRX",
      chainId: CHAIN_IDs.TRON,
      decimals: 6,
      withdrawMin: "30",
      withdrawMax: "1000",
      withdrawFee: "1.5",
    });

    expect(() =>
      buildSweepPlan({
        destination,
        freeBalance: toBNWei("20", 6),
      })
    ).to.throw("below Binance minimum withdrawal size");
  });
});

function makeResolvedAsset(params: {
  tokenSymbol: string;
  chainId: number;
  decimals: number;
  withdrawMin: string;
  withdrawMax: string;
  withdrawFee: string;
}): ResolvedBinanceAsset {
  return {
    tokenSymbol: params.tokenSymbol,
    chainId: params.chainId,
    binanceCoin: params.tokenSymbol,
    tokenDecimals: params.decimals,
    isNativeAsset: true,
    network: {
      name: BINANCE_NETWORKS[params.chainId],
      coin: params.tokenSymbol,
      withdrawMin: params.withdrawMin,
      withdrawMax: params.withdrawMax,
      withdrawFee: params.withdrawFee,
      contractAddress: "",
      withdrawEnable: true,
      depositEnable: true,
    },
  };
}
