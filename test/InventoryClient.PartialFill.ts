import { expect, ethers, SignerWithAddress, createSpyLogger, winston, BigNumber } from "./utils";
import { toBN, toWei, randomAddress } from "./utils";

import { InventoryConfig, Deposit } from "../src/interfaces";
import { MockBundleDataClient, MockHubPoolClient, MockAdapterManager, MockTokenClient } from "./mocks";
import { InventoryClient } from "../src/clients"; // Tested

let hubPoolClient: MockHubPoolClient, adapterManager: MockAdapterManager, tokenClient: MockTokenClient;
let bundleDataClient: MockBundleDataClient;
let owner: SignerWithAddress, spyLogger: winston.Logger;
let inventoryClient: InventoryClient; // tested
let sampleDepositData: Deposit;

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
      10: {
        targetPct: toWei(0.12),
        thresholdPct: toWei(0.1),
        partialFillAmountPct: toWei(0.5),
        partialFillThresholdPct: toWei(0.3),
      },
      137: {
        targetPct: toWei(0.07),
        thresholdPct: toWei(0.05),
        partialFillAmountPct: toWei(0.5),
        partialFillThresholdPct: toWei(0.3),
      },
      42161: { targetPct: toWei(0.07), thresholdPct: toWei(0.05) },
    },
  },
  wrapEtherThreshold: toWei(1),
};

// Construct an initial distribution that keeps these values within the above thresholds.
const initialAllocation = {
  1: { [mainnetWeth]: toWei(100) },
  10: { [mainnetWeth]: toWei(20) },
  137: { [mainnetWeth]: toWei(10) },
  42161: { [mainnetWeth]: toWei(10) },
};

describe("InventoryClient: Partial fill parameters", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spyLogger } = createSpyLogger());

    hubPoolClient = new MockHubPoolClient(null, null);
    adapterManager = new MockAdapterManager(null, null, null, null);
    tokenClient = new MockTokenClient(null, null, null, null);
    bundleDataClient = new MockBundleDataClient(null, null, null, null);

    inventoryClient = new InventoryClient(
      owner.address,
      spyLogger,
      inventoryConfig,
      tokenClient,
      enabledChainIds,
      hubPoolClient,
      bundleDataClient,
      adapterManager
    );
    seedMocks(initialAllocation);

    sampleDepositData = {
      depositId: 0,
      depositor: owner.address,
      recipient: owner.address,
      originToken: mainnetWeth,
      destinationToken: l2TokensForWeth[10],
      realizedLpFeePct: toWei(0),
      amount: toWei(200),
      originChainId: 1,
      destinationChainId: 10,
      relayerFeePct: toBN(1337),
      quoteTimestamp: 1234,
    };
    hubPoolClient.setReturnedL1TokenForDeposit(mainnetWeth);
  });

  it("Inventory config not set for token", async function () {
    sampleDepositData.destinationChainId = 42161; // Chain with no partial fill config set
    const result = inventoryClient.getPartialFillAmount(sampleDepositData, sampleDepositData.amount);
    expect(result).to.equal(toBN(0));
  });
  it("Allocation % including unfilled amount is above partial fill trigger %", async function () {
    // Initial allocation to chain 10 is 20 out of 140 WETH
    // If we set the relayer allocation on chain 10 equal to 100, then a 10 WETH unfilled amount will still keep it
    // over the threshold 30% < ( 100 - 10 ) / (100+100+10+10) ~= 40%
    tokenClient.setTokenData(sampleDepositData.destinationChainId, sampleDepositData.destinationToken, toWei(100));
    expect(inventoryClient.getPartialFillAmount(sampleDepositData, toWei(10))).to.equal(toBN(0));
  });
  it("Allocation % including unfilled amount is below partial fill trigger %", async function () {
    // With the allocation for chain 10 = 20, if the unfilled amount is 5, then the new allocation %
    // will be below the threshold 30% > (20 - 5) / (140) ~= 10%. So, we'll send the partial fill amount %
    // of the relayer's balance: 50% of 20 = 10.
    expect(inventoryClient.getPartialFillAmount(sampleDepositData, toWei(5))).to.equal(toWei(10));
  });
});

function seedMocks(seedBalances: { [chainId: string]: { [token: string]: BigNumber } }) {
  hubPoolClient.addL1Token({ address: mainnetWeth, decimals: 18, symbol: "WETH" });
  enabledChainIds.forEach((chainId) => {
    adapterManager.setMockedOutstandingCrossChainTransfers(chainId, mainnetWeth, toBN(0));
    tokenClient.setTokenData(chainId, l2TokensForWeth[chainId], seedBalances[chainId][mainnetWeth], toBN(0));
  });

  hubPoolClient.setL1TokensToDestinationTokens({ [mainnetWeth]: l2TokensForWeth });
}
