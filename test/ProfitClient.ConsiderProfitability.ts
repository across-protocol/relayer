import { expect, createSpyLogger, winston, toBNWei, toBN } from "./utils";
import { MockHubPoolClient, MockProfitClient } from "./mocks";
import { Deposit } from "../src/interfaces";
import { WMATIC } from "../src/clients";

let hubPoolClient: MockHubPoolClient, spyLogger: winston.Logger, profitClient: MockProfitClient;

const mainnetWeth = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const mainnetUsdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

describe("ProfitClient: Consider relay profit", async function () {
  beforeEach(async function () {
    ({ spyLogger } = createSpyLogger());

    hubPoolClient = new MockHubPoolClient(null, null);
    profitClient = new MockProfitClient(spyLogger, hubPoolClient);

    // Seed prices
    profitClient.setTokenPrices({
      [mainnetWeth]: toBNWei(3000),
      [mainnetUsdc]: toBNWei(1),
      [WMATIC]: toBNWei("0.4"),
    });
  });

  it("Considers gas cost when computing protfitability", async function () {
    // Create a relay that is clearly profitable. Currency of the relay is WETH with a fill amount of 0.1 WETH, price per
    // WETH set at 3000 and relayer fee % of 0.1% which is a revenue of 0.3.
    // However, since WMATIC costs $0.4, the profit is only 1.2 - 0.3 = $0.9 after gas, which is unprofitable.
    const relaySize = toBNWei("0.1"); // 1 ETH
    hubPoolClient.setTokenInfoToReturn({ address: mainnetWeth, decimals: 18, symbol: "WETH" });
    const relay = { relayerFeePct: toBNWei("0.001"), destinationChainId: 137 } as Deposit;
    expect(profitClient.isFillProfitable(relay, relaySize, toBNWei(1))).to.be.false;
  });

  it("Handles non-standard token decimals when considering a relay profitability", async function () {
    // Create a relay that is clearly profitable. Currency of the relay is USDC with a fill amount of 1000 USDC with a
    // price per USDC of 1 USD. Set the relayer Fee to 10% should make this clearly relayable.

    const relaySize = toBN(1000).mul(toBN(10).pow(6)); // 1000e6 for 1000 USDC.

    // Relayer fee is 10% or $100. Gas cost is 0.01 * 3000 = $30. This leaves a profit of $70.
    hubPoolClient.setTokenInfoToReturn({ address: mainnetUsdc, decimals: 6, symbol: "USDC" });
    const profitableUsdcL1Relay = { relayerFeePct: toBNWei("0.1"), destinationChainId: 1 } as Deposit;
    expect(profitClient.isFillProfitable(profitableUsdcL1Relay, relaySize, toBNWei("0.01"))).to.be.true;

    // Relayer fee is still $100. Gas cost is 0.1 * 3000 = $300. This leaves a loss of $200.
    const unprofitableUsdcL1Relay = { relayerFeePct: toBNWei("0.1"), destinationChainId: 1 } as Deposit;
    expect(profitClient.isFillProfitable(unprofitableUsdcL1Relay, relaySize, toBNWei("0.1"))).to.be.false;
    // Relayer fee is still $100. Gas cost is 0.033 * 3000 = $99. This leaves a small profit of $1.
    const marginallyProfitableUsdcL1Relay = { relayerFeePct: toBNWei("0.1"), destinationChainId: 1 } as Deposit;
    expect(profitClient.isFillProfitable(marginallyProfitableUsdcL1Relay, relaySize, toBNWei("0.033"))).to.be.true;

    // Equally, works on non-mainnet chainIDs.
    const unprofitableUsdcL2Relay = { relayerFeePct: toBNWei("0.1"), destinationChainId: 10 } as Deposit;
    expect(profitClient.isFillProfitable(unprofitableUsdcL2Relay, relaySize, toBNWei("0.1"))).to.be.false;
    const marginallyUsdcL2ProfitableRelay = { relayerFeePct: toBNWei("0.1"), destinationChainId: 10 } as Deposit;
    expect(profitClient.isFillProfitable(marginallyUsdcL2ProfitableRelay, relaySize, toBNWei("0.033"))).to.be.true;
  });

  it("Captures unprofitable fills", async function () {
    const deposit = { relayerFeePct: toBNWei("0.003"), originChainId: 1, depositId: 42 } as Deposit;
    profitClient.captureUnprofitableFill(deposit, toBNWei(1));
    expect(profitClient.getUnprofitableFills()).to.deep.equal({ 1: [{ deposit, fillAmount: toBNWei(1) }] });
  });
});
