import {
  BigNumber,
  expect,
  createSpyLogger,
  winston,
  toBNWei,
  toBN,
  ethers,
  deploySpokePoolWithToken,
  originChainId,
  destinationChainId,
} from "./utils";
import { MockHubPoolClient, MockProfitClient } from "./mocks";
import { Deposit, L1Token } from "../src/interfaces";
import { SpokePoolClient, MATIC, USDC, WETH } from "../src/clients";

const tokens: { [symbol: string]: L1Token } = {
  MATIC: { address: MATIC, decimals: 18, symbol: "MATIC" },
  USDC: { address: USDC, decimals: 6, symbol: "USDC" },
  WETH: { address: WETH, decimals: 18, symbol: "WETH" },
};

const tokenPrices: { [symbol: string]: BigNumber } = {
  MATIC: toBNWei("0.4"),
  USDC: toBNWei(1),
  WETH: toBNWei(3000),
};

// Set env LOG_IN_TEST to log to console.
const { spyLogger } = createSpyLogger();
let hubPoolClient: MockHubPoolClient, profitClient: MockProfitClient;

describe("ProfitClient: Consider relay profit", async function () {
  beforeEach(async function () {
    hubPoolClient = new MockHubPoolClient(null, null);
    const [owner] = await ethers.getSigners();
    const { spokePool: spokePool_1 } = await deploySpokePoolWithToken(originChainId, destinationChainId);
    const { spokePool: spokePool_2 } = await deploySpokePoolWithToken(destinationChainId, originChainId);

    const spokePoolClient_1 = new SpokePoolClient(spyLogger, spokePool_1.connect(owner), null, originChainId);
    const spokePoolClient_2 = new SpokePoolClient(spyLogger, spokePool_2.connect(owner), null, destinationChainId);
    const spokePoolClients = { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 };
    profitClient = new MockProfitClient(spyLogger, hubPoolClient, spokePoolClients, false, [], false, toBN(0));

    // Load ERC20 token prices in USD.
    profitClient.setTokenPrices(
      Object.fromEntries(Object.entries(tokenPrices).map(([symbol, price]) => [tokens[symbol].address, price]))
    );
  });

  it("Considers gas cost when computing protfitability", async function () {
    // Create a relay that is clearly profitable. Currency of the relay is WETH with a fill amount of 0.1 WETH, price per
    // WETH set at 3000 and relayer fee % of 0.1% which is a revenue of 0.3.
    // However, since MATIC costs $0.4, the profit is only 1.2 - 0.3 = $0.9 after gas, which is unprofitable.
    const relaySize = toBNWei("0.1"); // 1 ETH
    hubPoolClient.setTokenInfoToReturn(tokens["WETH"]);

    const relay = { relayerFeePct: toBNWei("0.001"), destinationChainId: 137 } as Deposit;
    profitClient.setGasCosts({ 137: toBNWei(1) });
    expect(profitClient.isFillProfitable(relay, relaySize)).to.be.false;
  });

  it("Return 0 when gas cost fails to be fetched", async function () {
    profitClient.setGasCosts({ 137: undefined });
    expect(profitClient.getTotalGasCost(137)).to.equal(toBN(0));
  });

  it("Handles non-standard token decimals when considering a relay profitability", async function () {
    // Create a relay that is clearly profitable. Currency of the relay is USDC with a fill amount of 1000 USDC with a
    // price per USDC of 1 USD. Set the relayer Fee to 10% should make this clearly relayable.
    const relaySize = toBN(1000).mul(toBN(10).pow(6)); // 1000e6 for 1000 USDC.

    // Relayer fee is 10% or $100. Gas cost is 0.01 * 3000 = $30. This leaves a profit of $70.
    hubPoolClient.setTokenInfoToReturn(tokens["USDC"]);
    const profitableUsdcL1Relay = { relayerFeePct: toBNWei("0.1"), destinationChainId: 1 } as Deposit;
    profitClient.setGasCosts({ 1: toBNWei("0.01") });
    expect(profitClient.isFillProfitable(profitableUsdcL1Relay, relaySize)).to.be.true;

    // Relayer fee is still $100. Gas cost is 0.1 * 3000 = $300. This leaves a loss of $200.
    const unprofitableUsdcL1Relay = { relayerFeePct: toBNWei("0.1"), destinationChainId: 1 } as Deposit;
    profitClient.setGasCosts({ 1: toBNWei("0.1") });
    expect(profitClient.isFillProfitable(unprofitableUsdcL1Relay, relaySize)).to.be.false;

    // Relayer fee is still $100. Gas cost is 0.033 * 3000 = $99. This leaves a small profit of $1.
    const marginallyProfitableUsdcL1Relay = { relayerFeePct: toBNWei("0.1"), destinationChainId: 1 } as Deposit;
    profitClient.setGasCosts({ 1: toBNWei("0.033") });
    expect(profitClient.isFillProfitable(marginallyProfitableUsdcL1Relay, relaySize)).to.be.true;

    // Equally, works on non-mainnet chainIDs.
    const unprofitableUsdcL2Relay = { relayerFeePct: toBNWei("0.1"), destinationChainId: 10 } as Deposit;
    profitClient.setGasCosts({ 10: toBNWei("0.1") });
    expect(profitClient.isFillProfitable(unprofitableUsdcL2Relay, relaySize)).to.be.false;
    profitClient.setGasCosts({ 10: toBNWei("0.033") });
    const marginallyUsdcL2ProfitableRelay = { relayerFeePct: toBNWei("0.1"), destinationChainId: 10 } as Deposit;
    expect(profitClient.isFillProfitable(marginallyUsdcL2ProfitableRelay, relaySize)).to.be.true;
  });

  it("Considers deposits with relayer fee below min required unprofitable", async function () {
    const profitableWethL1Relay = { relayerFeePct: toBNWei("0.01"), destinationChainId: 1 } as Deposit;
    // Ignore gas cost but with a min fee of 0.03%.
    const profitClientWithMinFee = new MockProfitClient(spyLogger, hubPoolClient, {}, true, [], false, toBNWei("0.03"));
    expect(profitClientWithMinFee.isFillProfitable(profitableWethL1Relay, toBNWei(1))).to.be.false;
  });

  it("Considers deposits with newRelayerFeePct", async function () {
    const profitableWethL1Relay = {
      relayerFeePct: toBNWei("0.01"),
      newRelayerFeePct: toBNWei("0.1"),
      destinationChainId: 1,
    } as Deposit;
    // Ignore gas cost but with a min fee of 0.03%.
    const profitClientWithMinFee = new MockProfitClient(spyLogger, hubPoolClient, {}, true, [], false, toBNWei("0.03"));
    expect(profitClientWithMinFee.isFillProfitable(profitableWethL1Relay, toBNWei(1))).to.be.true;
  });

  it("Ignores newRelayerFeePct if it's lower than original relayerFeePct", async function () {
    const profitableWethL1Relay = {
      relayerFeePct: toBNWei("0.1"),
      newRelayerFeePct: toBNWei("0.01"),
      destinationChainId: 1,
    } as Deposit;
    profitClient.setGasCosts({ 1: toBNWei("0.01") });
    // Ignore gas cost but with a min fee of 0.03%.
    const profitClientWithMinFee = new MockProfitClient(spyLogger, hubPoolClient, {}, true, [], false, toBNWei("0.03"));
    expect(profitClientWithMinFee.isFillProfitable(profitableWethL1Relay, toBNWei(1))).to.be.true;
  });

  it("Captures unprofitable fills", async function () {
    const deposit = { relayerFeePct: toBNWei("0.003"), originChainId: 1, depositId: 42 } as Deposit;
    profitClient.captureUnprofitableFill(deposit, toBNWei(1));
    expect(profitClient.getUnprofitableFills()).to.deep.equal({ 1: [{ deposit, fillAmount: toBNWei(1) }] });
  });
});
