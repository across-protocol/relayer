import {
  AcrossApiClient,
  ConfigStoreClient,
  HubPoolClient,
  MultiCallerClient,
  Rebalance,
  SpokePoolClient,
  TokenClient,
} from "../src/clients";
import { CONFIG_STORE_VERSION } from "../src/common";
import { bnZero } from "../src/utils";
import {
  CHAIN_ID_TEST_LIST,
  amountToDeposit,
  amountToLp,
  defaultMinDepositConfirmations,
  defaultTokenConfig,
  originChainId,
  destinationChainId,
  repaymentChainId,
} from "./constants";
import { MockInventoryClient } from "./mocks";
import {
  Contract,
  SignerWithAddress,
  createSpyLogger,
  deployAndConfigureHubPool,
  deployConfigStore,
  deploySpokePoolWithToken,
  depositV2,
  depositV3,
  enableRoutesOnHubPool,
  ethers,
  expect,
  getLastBlockTime,
  getV3RelayHash,
  lastSpyLogIncludes,
  setupTokensForWallet,
  sinon,
  spyLogIncludes,
  winston,
} from "./utils";

import { Relayer } from "../src/relayer/Relayer";
import { RelayerConfig } from "../src/relayer/RelayerConfig"; // Tested
import { MockedMultiCallerClient } from "./mocks/MockMultiCallerClient";
import { MockProfitClient } from "./mocks/MockProfitClient";
import { MockCrossChainTransferClient } from "./mocks/MockCrossChainTransferClient";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let hubPool: Contract, configStore: Contract, l1Token: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
let spy: sinon.SinonSpy, spyLogger: winston.Logger;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let configStoreClient: ConfigStoreClient, hubPoolClient: HubPoolClient, tokenClient: TokenClient;
let relayerInstance: Relayer, mockCrossChainTransferClient: MockCrossChainTransferClient;
let multiCallerClient: MultiCallerClient, profitClient: MockProfitClient, mockInventoryClient: MockInventoryClient;
let spokePool1DeploymentBlock: number, spokePool2DeploymentBlock: number;

describe("Relayer: Initiates slow fill requests", async function () {
  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    ({
      spokePool: spokePool_1,
      erc20: erc20_1,
      deploymentBlock: spokePool1DeploymentBlock,
    } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({
      spokePool: spokePool_2,
      erc20: erc20_2,
      deploymentBlock: spokePool2DeploymentBlock,
    } = await deploySpokePoolWithToken(destinationChainId, originChainId));
    ({ hubPool, l1Token_1: l1Token } = await deployAndConfigureHubPool(owner, [
      { l2ChainId: destinationChainId, spokePool: spokePool_2 },
      { l2ChainId: originChainId, spokePool: spokePool_1 },
      { l2ChainId: repaymentChainId, spokePool: spokePool_1 },
      { l2ChainId: 1, spokePool: spokePool_1 },
    ]));

    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token, destinationToken: erc20_1 },
      { destinationChainId: destinationChainId, l1Token, destinationToken: erc20_2 },
    ]);

    ({ spy, spyLogger } = createSpyLogger());
    ({ configStore } = await deployConfigStore(
      owner,
      [l1Token],
      undefined,
      undefined,
      undefined,
      undefined,
      CHAIN_ID_TEST_LIST
    ));

    configStoreClient = new ConfigStoreClient(spyLogger, configStore, { fromBlock: 0 }, CONFIG_STORE_VERSION);
    await configStoreClient.update();

    hubPoolClient = new HubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    multiCallerClient = new MockedMultiCallerClient(spyLogger); // leave out the gasEstimator for now.

    spokePoolClient_1 = new SpokePoolClient(
      spyLogger,
      spokePool_1.connect(relayer),
      hubPoolClient,
      originChainId,
      spokePool1DeploymentBlock
    );
    spokePoolClient_2 = new SpokePoolClient(
      spyLogger,
      spokePool_2.connect(relayer),
      hubPoolClient,
      destinationChainId,
      spokePool2DeploymentBlock
    );
    const spokePoolClients = { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 };
    tokenClient = new TokenClient(spyLogger, relayer.address, spokePoolClients, hubPoolClient);
    profitClient = new MockProfitClient(spyLogger, hubPoolClient, spokePoolClients, [], relayer.address);
    for (const erc20 of [l1Token]) {
      await profitClient.initToken(erc20);
    }

    mockCrossChainTransferClient = new MockCrossChainTransferClient();
    mockInventoryClient = new MockInventoryClient(mockCrossChainTransferClient);
    relayerInstance = new Relayer(
      relayer.address,
      spyLogger,
      {
        spokePoolClients,
        hubPoolClient,
        configStoreClient,
        tokenClient,
        profitClient,
        multiCallerClient,
        inventoryClient: mockInventoryClient,
        acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, spokePoolClients),
      },
      {
        relayerTokens: [],
        slowDepositors: [],
        relayerDestinationChains: [],
        minDepositConfirmations: defaultMinDepositConfirmations,
      } as unknown as RelayerConfig
    );

    await setupTokensForWallet(spokePool_1, owner, [l1Token], null, 100); // Seed owner to LP.
    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], null, 10);
    await setupTokensForWallet(spokePool_2, depositor, [erc20_2], null, 10);
    await setupTokensForWallet(spokePool_1, relayer, [erc20_1, erc20_2], null, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_1, erc20_2], null, 10);

    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);
    await configStore.updateTokenConfig(l1Token.address, defaultTokenConfig);

    await updateAllClients();
  });

  it("Correctly sends 1wei sized fill for v2 Deposits if insufficient token balance", async function () {
    // Transfer away a lot of the relayers funds to simulate the relayer having insufficient funds.
    const balance = await erc20_1.balanceOf(relayer.address);
    await erc20_1.connect(relayer).transfer(owner.address, balance.sub(amountToDeposit));
    await erc20_2.connect(relayer).transfer(owner.address, balance.sub(amountToDeposit));
    // The relayer wallet was seeded with 5x the deposit amount. Make the deposit 6x this size.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    const deposit1 = await depositV2(
      spokePool_1,
      erc20_1,
      depositor,
      depositor,
      destinationChainId,
      amountToDeposit.mul(2) // 2x the normal deposit size. Bot only has 1x the deposit amount.
    );
    expect(deposit1).to.exist;

    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(spyLogIncludes(spy, -2, "Zero filling")).to.be.true;
    expect(lastSpyLogIncludes(spy, "Insufficient balance to fill all deposits")).to.be.true;
    expect(multiCallerClient.transactionCount()).to.equal(1); // One transaction, 1wei filling the one deposit.

    const tx = await multiCallerClient.executeTransactionQueue();
    expect(tx.length).to.equal(1); // There should have been exactly one transaction.

    // Check the state change happened correctly on the smart contract. There should be exactly one fill on spokePool_2.
    const fillEvent = (await spokePool_2.queryFilter(spokePool_2.filters.FilledRelay())).at(-1);
    const args = fillEvent?.args;
    expect(args).to.exist;
    expect(args?.depositId).to.exist;
    expect(args?.depositId).to.equal(deposit1?.depositId);
    expect(args?.relayerFeePct).to.exist;
    expect(args?.relayerFeePct.eq(deposit1?.relayerFeePct)).to.be.true;
    expect(args?.fillAmount).to.exist;
    expect(args?.fillAmount).to.equal(1); // 1wei fill size

    // Re-run the execution loop and validate that no additional relays are sent.
    multiCallerClient.clearTransactionQueue();
    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(multiCallerClient.transactionCount()).to.equal(0); // no Transactions to send.
    expect(lastSpyLogIncludes(spy, "Insufficient balance to fill all deposits")).to.be.true;
  });

  it("Correctly requests slow fill for v3 Deposits if insufficient token balance", async function () {
    // Transfer away a lot of the relayers funds to simulate the relayer having insufficient funds.
    const balance = await erc20_1.balanceOf(relayer.address);
    await erc20_2.connect(relayer).transfer(depositor.address, balance.sub(amountToDeposit));

    const inputToken = erc20_1.address;
    const inputAmount = await erc20_1.balanceOf(depositor.address);
    const outputToken = erc20_2.address;
    const outputAmount = balance.sub(1);

    const relayerBalance = await erc20_2.connect(relayer).balanceOf(relayer.address);
    expect(relayerBalance.lt(outputAmount)).to.be.true;

    // The relayer wallet was seeded with 5x the deposit amount. Make the deposit 6x this size.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    expect(deposit).to.exist;

    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(multiCallerClient.transactionCount()).to.equal(1); // Should be requestV3SlowFill()
    expect(spyLogIncludes(spy, -2, "Enqueuing slow fill request.")).to.be.true;
    expect(lastSpyLogIncludes(spy, "Insufficient balance to fill all deposits")).to.be.true;

    const tx = await multiCallerClient.executeTransactionQueue();
    expect(tx.length).to.equal(1);

    // Verify that the slowFill request was received by the destination SpokePoolClient.
    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
    let slowFillRequest = spokePoolClient_2.getSlowFillRequest(deposit);
    expect(slowFillRequest).to.exist;
    slowFillRequest = slowFillRequest!; // tsc coersion

    expect(getV3RelayHash(slowFillRequest, slowFillRequest.destinationChainId)).to.equal(
      getV3RelayHash(deposit, deposit.destinationChainId)
    );

    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(multiCallerClient.transactionCount()).to.equal(0); // no Transactions to send.
    expect(lastSpyLogIncludes(spy, "Insufficient balance to fill all deposits")).to.be.true;
  });

  // @note: v3 slow fill requests don't affect repayment chain selection, so they can be rebalance-agnostic.
  // This functionality is a candidate for removal once v2 is removed.
  describe("Sends zero fills only if it won't rebalance to fast fill deposit", function () {
    let deposit1: Record<string, unknown> | null = null;
    let partialRebalance: Pick<Rebalance, "thresholdPct" | "targetPct" | "currentAllocPct" | "cumulativeBalance">;
    beforeEach(async function () {
      // Transfer away a lot of the relayers funds to simulate the relayer having insufficient funds.
      const balance = await erc20_1.balanceOf(relayer.address);
      await erc20_1.connect(relayer).transfer(owner.address, balance.sub(amountToDeposit));
      await erc20_2.connect(relayer).transfer(owner.address, balance.sub(amountToDeposit));
      // The relayer wallet was seeded with 5x the deposit amount. Make the deposit 6x this size.
      await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
      deposit1 = await depositV2(
        spokePool_1,
        erc20_1,
        depositor,
        depositor,
        destinationChainId,
        amountToDeposit.mul(2) // 2x the normal deposit size. Bot only has 1x the deposit amount.
      );
      await updateAllClients();

      partialRebalance = {
        // These parameters don't matter, as the relayer only checks that the rebalance matches
        // the deposit destination chain and L1 token. The amount must be greater than the unfilled
        // deposit amount too.
        thresholdPct: bnZero,
        targetPct: bnZero,
        currentAllocPct: bnZero,
        cumulativeBalance: await l1Token.balanceOf(relayer.address),
      };
    });
    it("Skips zero fill if there is a rebalance that will fast fill the deposit", async function () {
      // Add a rebalance to the inventory client to trick relayer into thinking it will be able to fill
      // the deposit post rebalance.
      mockInventoryClient.addPossibleRebalance({
        ...partialRebalance,
        balance: deposit1.amount,
        amount: deposit1.amount,
        chainId: deposit1.destinationChainId,
        l1Token: l1Token.address,
      });

      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(multiCallerClient.transactionCount()).to.equal(0);
    });

    // @note: v3 slow fill requests don't affect repayment chain selection, so they can be rebalance-agnostic.
    // This functionality is a candidate for removal once v2 is removed.
    describe("Sends zero fill if no rebalance for deposit", function () {
      it("rebalance amount is too low", async function () {
        mockInventoryClient.addPossibleRebalance({
          ...partialRebalance,
          balance: bnZero, // No balance
          amount: deposit1.amount,
          chainId: deposit1.destinationChainId,
          l1Token: l1Token.address,
        });
        await relayerInstance.checkForUnfilledDepositsAndFill();
        expect(multiCallerClient.transactionCount()).to.equal(1);
      });
      it("rebalance doesn't match deposit", async function () {
        mockInventoryClient.addPossibleRebalance({
          ...partialRebalance,
          amount: deposit1.amount,
          chainId: deposit1.originChainId, // Wrong chain
          l1Token: l1Token.address,
        });
        await relayerInstance.checkForUnfilledDepositsAndFill();
        expect(multiCallerClient.transactionCount()).to.equal(1);
      });
      it("Skips zero fill if outstanding transfer amount is greater than deposit amount", async function () {
        mockInventoryClient.setBalanceOnChainForL1Token(deposit1.amount);
        await relayerInstance.checkForUnfilledDepositsAndFill();
        expect(multiCallerClient.transactionCount()).to.equal(0);
      });
    });
  });
});

async function updateAllClients() {
  await configStoreClient.update();
  await hubPoolClient.update();
  await tokenClient.update();
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
}
