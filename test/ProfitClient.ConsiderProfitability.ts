import { expect, createSpyLogger, winston, toBNWei, toBN } from "./utils";
import { MockHubPoolClient, MockProfitClient } from "./mocks";
import { Deposit } from "../src/interfaces";
import { WMATIC } from "../src/clients";

let hubPoolClient: MockHubPoolClient, spyLogger: winston.Logger, profitClient: MockProfitClient;

const mainnetWeth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const mainnetUsdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

describe("ProfitClient: Consider relay profit", async function () {
  beforeEach(async function () {
    ({ spyLogger } = createSpyLogger());

    hubPoolClient = new MockHubPoolClient(null, null);
    profitClient = new MockProfitClient(spyLogger, hubPoolClient, toBN(0));

    // Seed prices
    profitClient.setTokenPrices({
      [mainnetWeth]: toBNWei(3000),
      [mainnetUsdc]: toBNWei(1),
      [WMATIC]: toBNWei("0.3"),
    });
  });

  it("Decides a relay profitability", async function () {
    // Create a relay that is clearly profitable. Currency of the relay is WETH with a fill amount of 1 WETH, price per
    // WETH set at 3000 and relayer fee % of 10% which is a revenue of 300. This is more than the hard coded min of 10.
    const relaySize = toBNWei(1); // 1 ETH

    hubPoolClient.setTokenInfoToReturn({ address: mainnetWeth, decimals: 18, symbol: "WETH" });
    const profitableWethL1Relay = { relayerFeePct: toBNWei("0.1"), destinationChainId: 1 } as Deposit;
    expect(profitClient.isFillProfitable(profitableWethL1Relay, relaySize, toBN(0))).to.be.true;

    // The profitability margin for a relay of this currency given this pricing of 10 USD minimum is 10/3000=0.00333333.
    // I.e anything below this, as a percentage of the total allocated as a relayer fee, should be unprofitable.
    const unprofitableWethL1Relay = { relayerFeePct: toBNWei("0.003"), destinationChainId: 1 } as Deposit;
    expect(profitClient.isFillProfitable(unprofitableWethL1Relay, relaySize, toBN(0))).to.be.false;
    const marginallyWethL1ProfitableRelay = { relayerFeePct: toBNWei("0.0034"), destinationChainId: 1 } as Deposit;
    expect(profitClient.isFillProfitable(marginallyWethL1ProfitableRelay, relaySize, toBN(0))).to.be.true;

    // Relay minimum revenue is different on different chains. On all L2s its minimum set to 1 USD. This works out to
    // a relayed amount of 1/3000= 0.0003333333333 as the realized LP Fee PCT as the mim. Set chain Id to OP Mainnnet.
    const unprofitableWethL2Relay = { relayerFeePct: toBNWei("0.0003"), destinationChainId: 10 } as Deposit;
    expect(profitClient.isFillProfitable(unprofitableWethL2Relay, relaySize, toBN(0))).to.be.false;
    const marginallyWethL2ProfitableRelay = { relayerFeePct: toBNWei("0.00034"), destinationChainId: 10 } as Deposit;
    expect(profitClient.isFillProfitable(marginallyWethL2ProfitableRelay, relaySize, toBN(0))).to.be.true;
  });

  it("Considers gas cost when computing protfitability", async function () {
    // Create a relay that is clearly profitable. Currency of the relay is WETH with a fill amount of 0.4 WETH, price per
    // WETH set at 3000 and relayer fee % of 0.1% which is a revenue of 1.2. This is more than the hard coded min of 1.
    // However, since WMATIC costs $0.3, the profit is only 1.2 - 0.3 = $0.9 which is below the min of 1.
    // Therefore, this fill is not profitable enough.
    const relaySize = toBNWei("0.4"); // 1 ETH
    hubPoolClient.setTokenInfoToReturn({ address: mainnetWeth, decimals: 18, symbol: "WETH" });
    const relay = { relayerFeePct: toBNWei("0.001"), destinationChainId: 137 } as Deposit;
    expect(profitClient.isFillProfitable(relay, relaySize, toBNWei(1))).to.be.false;
  });

  it("Handles non-standard token decimals when considering a relay profitability", async function () {
    // Create a relay that is clearly profitable. Currency of the relay is USDC with a fill amount of 1000 USDC with a
    // price per USDC of 1 USD. Set the relayer Fee to 10% should make this clearly relayable.

    const relaySize = toBN(1000).mul(toBN(10).pow(6)); // 1000e6 for 1000 USDC.

    hubPoolClient.setTokenInfoToReturn({ address: mainnetUsdc, decimals: 6, symbol: "USDC" });
    const profitableUsdcL1Relay = { relayerFeePct: toBNWei("0.1"), destinationChainId: 1 } as Deposit;
    expect(profitClient.isFillProfitable(profitableUsdcL1Relay, relaySize, toBN(0))).to.be.true;

    // The profitability margin for a relay of this currency given this pricing of 10 USD minimum is 10/1000=0.01
    // I.e anything below this, as a percentage of the total allocated as a relayer fee, should be unprofitable.
    const unprofitableUsdcL1Relay = { relayerFeePct: toBNWei("0.009"), destinationChainId: 1 } as Deposit;
    expect(profitClient.isFillProfitable(unprofitableUsdcL1Relay, relaySize, toBN(0))).to.be.false;
    const marginallyProfitableUsdcL1Relay = { relayerFeePct: toBNWei("0.0101"), destinationChainId: 1 } as Deposit;
    expect(profitClient.isFillProfitable(marginallyProfitableUsdcL1Relay, relaySize, toBN(0))).to.be.true;

    // Equally, works on non-mainnet chainIDs. Again, this is 1/10th of the previous margin.
    const unprofitableUsdcL2Relay = { relayerFeePct: toBNWei("0.0009"), destinationChainId: 10 } as Deposit;
    expect(profitClient.isFillProfitable(unprofitableUsdcL2Relay, relaySize, toBN(0))).to.be.false;
    const marginallyUsdcL2ProfitableRelay = { relayerFeePct: toBNWei("0.00101"), destinationChainId: 10 } as Deposit;
    expect(profitClient.isFillProfitable(marginallyUsdcL2ProfitableRelay, relaySize, toBN(0))).to.be.true;
  });

  it("Captures unprofitable fills", async function () {
    const deposit = { relayerFeePct: toBNWei("0.003"), originChainId: 1, depositId: 42 } as Deposit;
    profitClient.captureUnprofitableFill(deposit, toBNWei(1));
    expect(profitClient.getUnprofitableFills()).to.deep.equal({ 1: [{ deposit, fillAmount: toBNWei(1) }] });
  });
});
