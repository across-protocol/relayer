import {
  BigNumber,
  SignerWithAddress,
  createRefunds,
  createSpyLogger,
  deployConfigStore,
  ethers,
  expect,
  hubPoolFixture,
  lastSpyLogIncludes,
  randomAddress,
  sinon,
  toBN,
  toWei,
  winston,
} from "./utils";

import { ConfigStoreClient, InventoryClient, MultiCallerClient } from "../src/clients"; // Tested
import { CrossChainTransferClient } from "../src/clients/bridges";
import { Deposit, InventoryConfig } from "../src/interfaces";
import { MockAdapterManager, MockBundleDataClient, MockHubPoolClient, MockTokenClient } from "./mocks";

const toMegaWei = (num: string | number | BigNumber) => ethers.utils.parseUnits(num.toString(), 6);

let hubPoolClient: MockHubPoolClient, adapterManager: MockAdapterManager, tokenClient: MockTokenClient;
let bundleDataClient: MockBundleDataClient;
let owner: SignerWithAddress, spy: sinon.SinonSpy, spyLogger: winston.Logger;
let inventoryClient: InventoryClient; // tested
let sampleDepositData: Deposit;
let crossChainTransferClient: CrossChainTransferClient;

const enabledChainIds = [1, 10, 137, 42161];

const mainnetWeth = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const mainnetUsdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// construct two mappings of chainId to token address. Set the l1 token address to the "real" token address.
const l2TokensForWeth = { 1: mainnetWeth };
const l2TokensForUsdc = { 1: mainnetUsdc };
enabledChainIds.slice(1).forEach((chainId) => {
  l2TokensForWeth[chainId] = randomAddress();
  l2TokensForUsdc[chainId] = randomAddress();
});

// Configure thresholds percentages as 10% optimism, 5% polygon and 5% Arbitrum with a target being threshold +2%.
const inventoryConfig: InventoryConfig = {
  tokenConfig: {
    [mainnetWeth]: {
      10: { targetPct: toWei(0.12), thresholdPct: toWei(0.1) },
      137: { targetPct: toWei(0.07), thresholdPct: toWei(0.05) },
      42161: { targetPct: toWei(0.07), thresholdPct: toWei(0.05) },
    },

    [mainnetUsdc]: {
      10: { targetPct: toWei(0.12), thresholdPct: toWei(0.1) },
      137: { targetPct: toWei(0.07), thresholdPct: toWei(0.05) },
      42161: { targetPct: toWei(0.07), thresholdPct: toWei(0.05) },
    },
  },
  wrapEtherThreshold: toWei(1),
};

// Construct an initial distribution that keeps these values within the above thresholds.
const initialAllocation = {
  1: { [mainnetWeth]: toWei(100), [mainnetUsdc]: toMegaWei(10000) }, // seed 100 WETH and 10000 USDC on Mainnet
  10: { [mainnetWeth]: toWei(20), [mainnetUsdc]: toMegaWei(2000) }, // seed 20 WETH and 2000 USDC on Optimism
  137: { [mainnetWeth]: toWei(10), [mainnetUsdc]: toMegaWei(1000) }, // seed 10 WETH and 1000 USDC on Polygon
  42161: { [mainnetWeth]: toWei(10), [mainnetUsdc]: toMegaWei(1000) }, // seed 10 WETH and 1000 USDC on Arbitrum
};

describe("InventoryClient: Refund chain selection", function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spy, spyLogger } = createSpyLogger());

    const { hubPool, dai: l1Token } = await hubPoolFixture();
    const { configStore } = await deployConfigStore(owner, [l1Token]);

    const configStoreClient = new ConfigStoreClient(spyLogger, configStore);
    await configStoreClient.update();

    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    adapterManager = new MockAdapterManager(spyLogger, {}, hubPoolClient, []);
    tokenClient = new MockTokenClient(spyLogger, "", {}, hubPoolClient);
    bundleDataClient = new MockBundleDataClient(
      spyLogger,
      { hubPoolClient, configStoreClient, multiCallerClient: null as unknown as MultiCallerClient },
      {},
      []
    );

    crossChainTransferClient = new CrossChainTransferClient(spyLogger, enabledChainIds, adapterManager);
    inventoryClient = new InventoryClient(
      owner.address,
      spyLogger,
      inventoryConfig,
      tokenClient,
      enabledChainIds,
      hubPoolClient,
      bundleDataClient,
      adapterManager,
      crossChainTransferClient
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
      message: "0x",
    };
    hubPoolClient.setReturnedL1TokenForDeposit(mainnetWeth);
  });

  it("Correctly decides when to refund based on relay size", async function () {
    // To start with, consider a simple case where the relayer is filling small relays. The current allocation on the
    // target chain of Optimism for WETH is 20/140=14.2%. This is above the sum of targetL2Pct of 10% plus 2% buffer.
    // Construct a small mock deposit of side 1 WETH. Post relay Optimism should have (20-1)/(140-1)=13.6%. This is still
    // above the threshold of 12 and so the bot should choose to be refunded on L1.
    sampleDepositData.amount = toWei(1);
    expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.equal(1);
    expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"136690647482014388"')).to.be.true; // (20-1)/(140-1)=0.136

    // Now consider a case where the relayer is filling a marginally larger relay of size 5 WETH. Now the post relay
    // allocation on optimism would be (20-5)/(140-5)=11%. This now below the target plus buffer of 12%. Relayer should
    // choose to refund on the L2.
    sampleDepositData.amount = toWei(5);
    expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.equal(10);
    expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"111111111111111111"')).to.be.true; // (20-5)/(140-5)=0.11

    // Now consider a bigger relay that should force refunds on the L2 chain. Set the relay size to 10 WETH. now post
    // relay allocation would be (20-10)/(140-10)=0.076. This is below the target threshold of 10% and so the bot should
    // set the refund on L2.
    sampleDepositData.amount = toWei(10);
    expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.equal(10);
    expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"76923076923076923"')).to.be.true; // (20-10)/(140-10)=0.076
  });

  it("Correctly factors in cross chain transfers when deciding where to refund", async function () {
    // The relayer should correctly factor in pending cross-chain relays when thinking about shortfalls. Consider a large
    // fictitious relay that exceeds all outstanding liquidity on the target chain(Arbitrum) of 15 Weth (target only)
    // has 10 WETH in it.
    const largeRelayAmount = toWei(15);
    tokenClient.setTokenShortFallData(42161, l2TokensForWeth[42161], [6969], largeRelayAmount); // Mock the shortfall.
    // The expected cross chain transfer amount is (0.05+0.02-(10-15)/140)*140=14.8 // Mock the cross-chain transfer
    // leaving L1 to go to arbitrum by adding it to the mock cross chain transfers and removing from l1 balance.
    const bridgedAmount = toWei(14.8);
    adapterManager.setMockedOutstandingCrossChainTransfers(42161, owner.address, mainnetWeth, bridgedAmount);
    await inventoryClient.update();
    tokenClient.setTokenData(1, mainnetWeth, initialAllocation[1][mainnetWeth].sub(bridgedAmount));

    // Now, consider that the bot is run while these funds for the above deposit are in the canonical bridge and cant
    // be filled yet. When it runs it picks up a relay that it can do, of size 1.69 WETH. Each part of the computation
    // is broken down to explain how the bot chooses where to allocate funds:
    // 1. chainVirtualBalance: Considering the funds on the target chain we have a balance of 10 WETH, with an amount of
    //    14.8 that is currently coming over the bridge. This totals a "virtual" balance of (10+14.8)=24.8.
    // 2. chainVirtualBalanceWithShortfall: this is the virtual balance minus the shortfall. 24.9-15=9.8.
    // 3. chainVirtualBalanceWithShortfallPostRelay: virtual balance with shortfall minus the relay amount. 9.8-1.69=8.11.
    // 4. cumulativeVirtualBalance: total balance across all chains considering fund movement. funds moving over the bridge
    //    does not impact the balance; they are just "moving" so it should be 140-15+15=140
    // 5. cumulativeVirtualBalanceWithShortfall: cumulative virtual balance minus the shortfall. 140-15+15=140-15=125.
    // 6. cumulativeVirtualBalanceWithShortfallPostRelay: cumulative virtual balance with shortfall minus the relay amount
    //    125-1.69=124.31. This is total funds considering the shortfall and the relay amount that is to be executed.
    // 7. expectedPostRelayAllocation: the expected post relay allocation is the chainVirtualBalanceWithShortfallPostRelay
    //    divided by the cumulativeVirtualBalanceWithShortfallPostRelay. 8.11/123.31 = 0.0657.
    // This number is then used to decide on where funds should be allocated! If this number is above the threshold plus
    // the buffer then refund on L1. if it is below the threshold then refund on the target chain. As this number is
    // is below the buffer plus the threshold then the bot should refund on L2.

    sampleDepositData.destinationChainId = 42161;
    sampleDepositData.amount = toWei(1.69);
    expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.equal(42161);
    expect(lastSpyLogIncludes(spy, 'chainShortfall":"15000000000000000000"')).to.be.true;
    expect(lastSpyLogIncludes(spy, 'chainVirtualBalance":"24800000000000000000"')).to.be.true; // (10+14.8)=24.8
    expect(lastSpyLogIncludes(spy, 'chainVirtualBalanceWithShortfall":"9800000000000000000"')).to.be.true; // 24.8-15=9.8
    expect(lastSpyLogIncludes(spy, 'chainVirtualBalanceWithShortfallPostRelay":"8110000000000000000"')).to.be.true; // 9.8-1.69=8.11
    expect(lastSpyLogIncludes(spy, 'cumulativeVirtualBalance":"140000000000000000000')).to.be.true; // 140-15+15=140
    expect(lastSpyLogIncludes(spy, 'cumulativeVirtualBalanceWithShortfall":"125000000000000000000"')).to.be.true; // 140-15=125
    expect(lastSpyLogIncludes(spy, 'cumulativeVirtualBalanceWithShortfallPostRelay":"123310000000000000000"')).to.be
      .true; // 125-1.69=123.31
    expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"65769199578298597')).to.be.true; // 8.11/123.31 = 0.0657

    // Now consider if this small relay was larger to the point that we should be refunding on the L2. set it to 5 WETH.
    // Numerically we can shortcut some of the computations above to the following: chain virtual balance with shortfall
    // post relay is 9.8 - 5 = 4.8. cumulative virtual balance with shortfall post relay is 125 - 5 = 120. Expected post
    // relay allocation is 4.8/120 = 0.04. This is below the threshold of 0.05 so the bot should refund on the target.
    sampleDepositData.amount = toWei(5);
    expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.equal(42161);
    // Check only the final step in the computation.
    expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"40000000000000000"')).to.be.true; // 4.8/120 = 0.04

    // Consider that we manually send the relayer som funds while it's large transfer is currently in the bridge. This
    // is to validate that the module considers funds in transit correctly + dropping funds indirectly onto the L2 wallet.
    // Say we magically give the bot 10 WETH on Arbitrum and try to repeat the previous example. Now, we should a
    // chain virtual balance with shortfall post relay is 9.8 - 5 + 10 = 14.8. cumulative virtual balance with shortfall
    // post relay is 125 - 5 + 10 = 130. Expected post relay allocation is 14.8/130 = 0.11. This is above the threshold
    // of 0.05 so the bot should refund on L1.
    tokenClient.setTokenData(42161, l2TokensForWeth[42161], initialAllocation[42161][mainnetWeth].add(toWei(10)));
    expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.equal(1);
  });

  it("Correctly decides where to refund based on upcoming refunds", async function () {
    // Consider a case where the relayer is filling a marginally larger relay of size 5 WETH. Without refunds, the post relay
    // allocation on optimism would be (15-5)/(140-5)=7.4%. This would be below the target plus buffer of 12%. However, if we now
    // factor in 10 WETH in refunds (5 from pending and 5 from next bundle) that are coming to L2 and 5 more WETH refunds coming to L1,
    // the allocation should actually be (15-5+10)/(140-5+5+10)=~13.3%, which is above L2 target.
    // Therefore, the bot should choose refund on L1 instead of L2.
    sampleDepositData.amount = toWei(5);
    bundleDataClient.setReturnedPendingBundleRefunds({
      1: createRefunds(owner.address, toWei(5), mainnetWeth),
      10: createRefunds(owner.address, toWei(5), l2TokensForWeth[10]),
    });
    bundleDataClient.setReturnedNextBundleRefunds({
      10: createRefunds(owner.address, toWei(5), l2TokensForWeth[10]),
    });
    expect(await inventoryClient.determineRefundChainId(sampleDepositData)).to.equal(1);
    expect(lastSpyLogIncludes(spy, 'expectedPostRelayAllocation":"166666666666666666"')).to.be.true; // (20-5)/(140-5)=0.11
  });
});

function seedMocks(seedBalances: { [chainId: string]: { [token: string]: BigNumber } }) {
  hubPoolClient.addL1Token({ address: mainnetWeth, decimals: 18, symbol: "WETH" });
  hubPoolClient.addL1Token({ address: mainnetUsdc, decimals: 6, symbol: "USDC" });
  enabledChainIds.forEach((chainId) => {
    adapterManager.setMockedOutstandingCrossChainTransfers(chainId, owner.address, mainnetWeth, toBN(0));
    adapterManager.setMockedOutstandingCrossChainTransfers(chainId, owner.address, mainnetUsdc, toBN(0));
    tokenClient.setTokenData(chainId, l2TokensForWeth[chainId], seedBalances[chainId][mainnetWeth]);
    tokenClient.setTokenData(chainId, l2TokensForUsdc[chainId], seedBalances[chainId][mainnetUsdc]);
  });

  hubPoolClient.setL1TokensToDestinationTokens({ [mainnetWeth]: l2TokensForWeth, [mainnetUsdc]: l2TokensForUsdc });
}
