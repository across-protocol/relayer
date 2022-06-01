import { expect, ethers, SignerWithAddress, createSpyLogger, winston, BigNumber, lastSpyLogIncludes } from "./utils";
import { toBN, toWei, randomAddress, spyLogIncludes } from "./utils";

import { InventoryConfig, Deposit } from "../src/interfaces";
import { MockHubPoolClient, MockAdapterManager, MockTokenClient } from "./mocks";
import { InventoryClient } from "../src/clients"; // Tested

const toMegaWei = (num: string | number | BigNumber) => ethers.utils.parseUnits(num.toString(), 6);

let hubPoolClient: MockHubPoolClient, adapterManager: MockAdapterManager, tokenClient: MockTokenClient;
let owner: SignerWithAddress, spy: sinon.SinonSpy, spyLogger: winston.Logger;
let inventoryClient: InventoryClient; // tested
let sampleDepositData: Deposit;

const enabledChainIds = [1, 10, 137, 42161];

const mainnetWeth = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const mainnetUsdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// construct two mappings of chainId to token address. Set the l1 token address to the "real" token address.
let l2TokensForWeth = { 1: mainnetWeth };
let l2TokensForUsdc = { 1: mainnetUsdc };
enabledChainIds.slice(1).forEach((chainId) => {
  l2TokensForWeth[chainId] = randomAddress();
  l2TokensForUsdc[chainId] = randomAddress();
});

// Configure target percentages as 80% mainnet, 10% optimism, 5% polygon and 5% Arbitrum.
const inventoryConfig: InventoryConfig = {
  managedL1Tokens: [mainnetWeth, mainnetUsdc],
  targetL2PctOfTotal: { "1": toWei(0.8), "10": toWei(0.1), "137": toWei(0.05), "42161": toWei(0.05) },
  rebalanceOvershoot: toWei(0.02),
  wrapEtherThreshold: toWei(1),
};

// Construct an initial distribution that keeps these values within the above thresholds.
const initialAllocation = {
  1: { [mainnetWeth]: toWei(100), [mainnetUsdc]: toMegaWei(10000) }, // seed 100 WETH and 10000 USDC on Mainnet
  10: { [mainnetWeth]: toWei(20), [mainnetUsdc]: toMegaWei(2000) }, // seed 20 WETH and 2000 USDC on Optimism
  137: { [mainnetWeth]: toWei(10), [mainnetUsdc]: toMegaWei(1000) }, // seed 10 WETH and 1000 USDC on Polygon
  42161: { [mainnetWeth]: toWei(10), [mainnetUsdc]: toMegaWei(1000) }, // seed 10 WETH and 1000 USDC on Arbitrum
};

const initialWethTotal = toWei(140); // Sum over all 4 chains is 140
const initialUsdcTotal = toMegaWei(14000); // Sum over all 4 chains is 14000
const initialTotals = { [mainnetWeth]: initialWethTotal, [mainnetUsdc]: initialUsdcTotal };

describe("InventoryClient: Refund chain selection", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spy, spyLogger } = createSpyLogger());

    hubPoolClient = new MockHubPoolClient(null, null);
    adapterManager = new MockAdapterManager(null, null, null, null);
    tokenClient = new MockTokenClient(null, null, null, null);

    inventoryClient = new InventoryClient(
      spyLogger,
      inventoryConfig,
      tokenClient,
      enabledChainIds,
      hubPoolClient,
      adapterManager
    );

    seedMocks(initialAllocation);

    sampleDepositData = {
      depositId: 0,
      depositor: owner.address,
      recipient: owner.address,
      originToken: mainnetWeth,
      destinationToken: l2TokensForWeth[10],
      realizedLpFeePct: toBN(0),
      amount: toBN(1),
      originChainId: 1,
      destinationChainId: 10,
      relayerFeePct: toBN(1337),
      quoteTimestamp: 1234,
    };
    hubPoolClient.setReturnedL1TokenForDeposit(mainnetWeth);
  });

  it("Correctly decides when to refund based on relay size", async function () {
    // To start with, consider a simple case where the relayer is filling small relays. The current allocation on the
    // target chain of Optimism for WETH is 20/140=14.2%. This is above the sum of targetL2Pct and rebalanceOvershoot(12%).
    // Construct a small mock deposit of side 1 WETH. Post relay Optimism should have (20-1)/(140-1)=13.6%. This is still
    // above the threshold and so the bot should choose to be refunded on L1.

    sampleDepositData.amount = toWei(1);

    expect(inventoryClient.determineRefundChainId(sampleDepositData)).to.equal(1);

    // Now consider a case where the relayer is filling a marginally larger relay of size 5 WETH. Now the post relay
    // allocation on optimism would be (20-2)/(140-2)=11%. This is now below the sum of the threshold and overshoot
    // (10+2=12%) and so the bot should choose to be refunded on the source chain.
    sampleDepositData.amount = toWei(5);
    expect(inventoryClient.determineRefundChainId(sampleDepositData)).to.equal(10);
  });

  it("Correctly factors in cross chain transfers when deciding where to refund", async function () {
    // The relayer should correctly factor in pending cross-chain relays when thinking about shortfalls. Consider a large
    // fictitious relay that exceeds all outstanding liquidity on the target chain(Arbitrum) of 15 Weth (target only)
    // has 10 WETH in it.
    const largeRelayAmount = toWei(15);
    tokenClient.setTokenShortFallData(42161, l2TokensForWeth[42161], [6969], largeRelayAmount); // Mock the shortfall.
    // The expected cross chain transfer amount is (0.05+0.02-(10-15)/140)*140=14.8
    adapterManager.setMockedOutstandingCrossChainTransfers(42161, mainnetUsdc, toWei(14.8)); // Mock the cross-chain transfer.

    // Now, consider that the bot is run while these funds for the above deposit are in the canonical bridge (cant)
    // be filled yet. When it runs it picks up a relay that it can do, of size 1.69 WETH. Considering the funds on the
    // target chain we have a balance of 10 WETH, with an amount of 14.8 that is currently coming over the bridge. This
    // totals a "virtual" balance of (10+14.8)=24.8. With this the effective allocation after this relay would be:
    // (24.8-15-1.69)/140=0.057. i.e factoring in the funds in the bridge and the current shortfall, considering the
    // current relay that is outstanding we have a utilization of 5.7%. This is above the minimum allocation threshold(5%)
    // so the relayer would not send more funds but it is below the refund threshold of minimum+overshoot(7%). Therefore
    // the bot should choose to get a refund on Arbitrum.
    sampleDepositData.destinationChainId = 42161;
    sampleDepositData.amount = toWei(1.69);
    expect(inventoryClient.determineRefundChainId(sampleDepositData)).to.equal(42161);
  });
});

function seedMocks(seedBalances: { [chainId: string]: { [token: string]: BigNumber } }) {
  hubPoolClient.addL1Token({ address: mainnetWeth, decimals: 18, symbol: "WETH" });
  hubPoolClient.addL1Token({ address: mainnetUsdc, decimals: 6, symbol: "USDC" });
  enabledChainIds.forEach((chainId) => {
    adapterManager.setMockedOutstandingCrossChainTransfers(chainId, mainnetWeth, toBN(0));
    adapterManager.setMockedOutstandingCrossChainTransfers(chainId, mainnetUsdc, toBN(0));
    tokenClient.setTokenData(chainId, l2TokensForWeth[chainId], seedBalances[chainId][mainnetWeth], toBN(0));
    tokenClient.setTokenData(chainId, l2TokensForUsdc[chainId], seedBalances[chainId][mainnetUsdc], toBN(0));
  });

  hubPoolClient.setL1TokensToDestinationTokens({ [mainnetWeth]: l2TokensForWeth, [mainnetUsdc]: l2TokensForUsdc });
}
