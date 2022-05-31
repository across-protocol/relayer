import { expect, ethers, SignerWithAddress, createSpyLogger, winston, BigNumber, lastSpyLogIncludes } from "./utils";
import { toBN, toWei, randomAddress, spyLogIncludes } from "./utils";

import { InventoryConfig } from "../src/interfaces";
import { MockHubPoolClient, MockAdapterManager, MockTokenClient } from "./mocks/";
import { InventoryClient } from "../src/clients"; // Tested

const toMegaWei = (num: string | number | BigNumber) => ethers.utils.parseUnits(num.toString(), 6);

let hubPoolClient: MockHubPoolClient, adapterManager: MockAdapterManager, tokenClient: MockTokenClient;
let owner: SignerWithAddress, spy: sinon.SinonSpy, spyLogger: winston.Logger;
let inventoryClient: InventoryClient; // tested

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
  targetL2PctOfTotal: { "1": toWei(0.8), "10": toWei(0.01), "137": toWei(0.05), "42161": toWei(0.05) },
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

describe("InventoryClient: Rebalancing inventory", async function () {
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
  });

  it("Accessors work as expected", async function () {
    expect(inventoryClient.getEnabledChains()).to.deep.equal(enabledChainIds);
    expect(inventoryClient.getL1Tokens()).to.deep.equal(inventoryConfig.managedL1Tokens);
    expect(inventoryClient.getEnabledL2Chains()).to.deep.equal([10, 137, 42161]);

    expect(inventoryClient.getCumulativeBalance(mainnetWeth)).to.equal(initialWethTotal);
    expect(inventoryClient.getCumulativeBalance(mainnetUsdc)).to.equal(initialUsdcTotal);

    // Check the allocation matches to what is expected in the seed state of the mock. Check more complex matchers.
    const tokenDistribution = inventoryClient.getTokenDistributionPerL1Token();
    for (const chainId of enabledChainIds) {
      for (const l1Token of inventoryConfig.managedL1Tokens) {
        expect(inventoryClient.getBalanceOnChainForL1Token(chainId, l1Token)).to.equal(
          initialAllocation[chainId][l1Token]
        );
        expect(inventoryClient.getOutstandingCrossChainTransferAmount(chainId, l1Token)).to.equal(toBN(0)); // For now no cross-chain transfers

        const expectedShare = initialAllocation[chainId][l1Token].mul(toWei(1)).div(initialTotals[l1Token]);
        expect(tokenDistribution[l1Token][chainId]).to.equal(expectedShare);
      }
    }
  });
  it("Correctly decides when to execute rebalances: allocation too low", async function () {
    // As each chain is at the expected amounts there should be no rebalance.
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, `No rebalances required`)).to.be.true;

    // Now, simulate the re-allocation of funds. Say that the USDC on arbitrum is half used up. This will leave arbitrum
    // with 500 USDC, giving a percentage of 500/14000 = 0.035. This is below the threshold of 0.5 so we should see
    // a re-balance executed in size of the target allocation + overshoot percentage.
    expect(tokenClient.getBalance(42161, l2TokensForUsdc[42161])).to.equal(toMegaWei(1000));
    const withdrawAmount = toMegaWei(500);
    tokenClient.decrementLocalBalance(42161, l2TokensForUsdc[42161], withdrawAmount);
    expect(tokenClient.getBalance(42161, l2TokensForUsdc[42161])).to.equal(withdrawAmount);

    // The allocation of this should now be below the threshold of 5% so the inventory client should instruct a rebalance.
    const expectedAlloc = withdrawAmount.mul(toWei(1)).div(initialUsdcTotal.sub(withdrawAmount));
    expect(inventoryClient.getCurrentAllocationPctConsideringShortfall(mainnetUsdc, 42161)).to.equal(expectedAlloc);

    // Execute rebalance. Check logs and enqueued transaction in Adapter manager. Given the total amount over all chains
    // and the amount still on arbitrum we would expect the module to instruct the relayer to send over:
    // (0.05 + 0.02) * (14000 - 500) - 500 = 445. Note the -500 component is there as arbitrum already has 500. our left
    // post previous relay.
    const expectedBridgedAmount = toMegaWei(445);
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, `Executed Inventory rebalances`)).to.be.true;
    expect(lastSpyLogIncludes(spy, `Rebalances sent to Arbitrum`)).to.be.true;
    expect(lastSpyLogIncludes(spy, `445.00 USDC rebalanced`)).to.be.true; // cast to formatting expected by client.
    expect(lastSpyLogIncludes(spy, `This represents the target allocation of 5.00%`)).to.be.true; // config from client.

    // The mock adapter manager should have been called with the expected transaction.
    expect(adapterManager.tokensSentCrossChain[42161][mainnetUsdc].amount).to.equal(expectedBridgedAmount);

    // Now, mock these funds having entered the canonical bridge.
    adapterManager.setMockedOutstandingCrossChainTransfers(42161, mainnetUsdc, expectedBridgedAmount);

    // Now that funds are "in the bridge" re-running the rebalance should not execute any transactions.
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, `No rebalances required`)).to.be.true;
    expect(spyLogIncludes(spy, -2, "Zero filling")).to.be.true;
  });

  it("Correctly decides when to execute rebalances: token shortfall", async function () {
    // Construct
    expect(tokenClient.getBalance(42161, l2TokensForUsdc[42161])).to.equal(toMegaWei(1000));
    const withdrawAmount = toMegaWei(500);
    tokenClient.decrementLocalBalance(42161, l2TokensForUsdc[42161], withdrawAmount);
    expect(tokenClient.getBalance(42161, l2TokensForUsdc[42161])).to.equal(withdrawAmount);

    // The allocation of this should now be below the threshold of 5% so the inventory client should instruct a rebalance.
    const expectedAlloc = withdrawAmount.mul(toWei(1)).div(initialUsdcTotal.sub(withdrawAmount));
    expect(inventoryClient.getCurrentAllocationPctConsideringShortfall(mainnetUsdc, 42161)).to.equal(expectedAlloc);

    // Execute rebalance. Check logs and enqueued transaction in Adapter manager. Given the total amount over all chains
    // and the amount still on arbitrum we would expect the module to instruct the relayer to send over:
    // (0.05 + 0.02) * (14000 - 500) - 500 = 445. Note the -500 component is there as arbitrum already has 500. our left
    // post previous relay.
    const expectedBridgedAmount = toMegaWei(445);
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, `Executed Inventory rebalances`)).to.be.true;
    expect(lastSpyLogIncludes(spy, `Rebalances sent to Arbitrum`)).to.be.true;
    expect(lastSpyLogIncludes(spy, `445.00 USDC rebalanced`)).to.be.true; // cast to formatting expected by client.
    expect(lastSpyLogIncludes(spy, `This represents the target allocation of 5.00%`)).to.be.true; // config from client.

    // The mock adapter manager should have been called with the expected transaction.
    expect(adapterManager.tokensSentCrossChain[42161][mainnetUsdc].amount).to.equal(expectedBridgedAmount);

    // Now, mock these funds having entered the canonical bridge.
    adapterManager.setMockedOutstandingCrossChainTransfers(42161, mainnetUsdc, expectedBridgedAmount);

    // Now that funds are "in the bridge" re-running the rebalance should not execute any transactions.
    await inventoryClient.update();
    await inventoryClient.rebalanceInventoryIfNeeded();
    expect(lastSpyLogIncludes(spy, `No rebalances required`)).to.be.true;
    expect(spyLogIncludes(spy, -2, "Zero filling")).to.be.true;
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
