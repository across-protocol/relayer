import { clients, constants, utils as sdkUtils } from "@across-protocol/sdk";
import hre from "hardhat";
import { AcrossApiClient, ConfigStoreClient, MultiCallerClient, TokenClient } from "../src/clients";
import { FillStatus, Deposit, RelayData } from "../src/interfaces";
import { CONFIG_STORE_VERSION } from "../src/common";
import {
  averageBlockTime,
  bnZero,
  bnOne,
  bnUint256Max,
  getNetworkName,
  getAllUnfilledDeposits,
  getMessageHash,
} from "../src/utils";
import { Relayer } from "../src/relayer/Relayer";
import { RelayerConfig } from "../src/relayer/RelayerConfig"; // Tested
import {
  amountToLp,
  defaultMinDepositConfirmations,
  defaultTokenConfig,
  depositRelayerFeePct,
  originChainId,
  destinationChainId,
  repaymentChainId,
} from "./constants";
import { MockConfigStoreClient, MockInventoryClient, MockProfitClient, SimpleMockHubPoolClient } from "./mocks";
import { MockedMultiCallerClient } from "./mocks/MockMultiCallerClient";
import {
  BigNumber,
  Contract,
  SignerWithAddress,
  createSpyLogger,
  deployAndConfigureHubPool,
  deployConfigStore,
  deploySpokePoolWithToken,
  depositV3,
  enableRoutesOnHubPool,
  ethers,
  expect,
  fillV3Relay,
  getLastBlockTime,
  lastSpyLogIncludes,
  MAX_SAFE_ALLOWANCE,
  spyLogIncludes,
  randomAddress,
  setupTokensForWallet,
  sinon,
  toBNWei,
  updateDeposit,
  winston,
} from "./utils";

describe("Relayer: Check for Unfilled Deposits and Fill", async function () {
  const [srcChain, dstChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];
  const { EMPTY_MESSAGE } = constants;
  const { fixedPointAdjustment: fixedPoint } = sdkUtils;

  let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
  let hubPool: Contract, configStore: Contract, l1Token: Contract;
  let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
  let spy: sinon.SinonSpy, spyLogger: winston.Logger;

  let spokePoolClient_1: clients.SpokePoolClient, spokePoolClient_2: clients.SpokePoolClient;
  let spokePoolClients: { [chainId: number]: clients.SpokePoolClient };
  let configStoreClient: ConfigStoreClient, hubPoolClient: clients.HubPoolClient, tokenClient: TokenClient;
  let relayerInstance: Relayer;
  let multiCallerClient: MultiCallerClient, profitClient: MockProfitClient;
  let tryMulticallClient: MultiCallerClient;
  let spokePool1DeploymentBlock: number, spokePool2DeploymentBlock: number;

  let chainIds: number[];

  const updateAllClients = async (): Promise<void> => {
    await configStoreClient.update();
    await hubPoolClient.update();
    await tokenClient.update();
    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update()]);
  };

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
    ({ configStore } = await deployConfigStore(owner, [l1Token]));

    configStoreClient = new MockConfigStoreClient(
      spyLogger,
      configStore,
      { fromBlock: 0 },
      CONFIG_STORE_VERSION,
      [originChainId, destinationChainId],
      originChainId,
      false
    ) as unknown as ConfigStoreClient;
    await configStoreClient.update();

    hubPoolClient = new SimpleMockHubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    multiCallerClient = new MockedMultiCallerClient(spyLogger);
    tryMulticallClient = new MockedMultiCallerClient(spyLogger);

    spokePoolClient_1 = new clients.SpokePoolClient(
      spyLogger,
      spokePool_1.connect(relayer),
      hubPoolClient,
      originChainId,
      spokePool1DeploymentBlock
    );
    spokePoolClient_2 = new clients.SpokePoolClient(
      spyLogger,
      spokePool_2.connect(relayer),
      hubPoolClient,
      destinationChainId,
      spokePool2DeploymentBlock
    );
    spokePoolClients = {
      [originChainId]: spokePoolClient_1,
      [destinationChainId]: spokePoolClient_2,
    };

    // Update all SpokePoolClient instances.
    await Promise.all(Object.values(spokePoolClients).map((spokePoolClient) => spokePoolClient.update()));

    // We will need to update the config store client at least once
    await configStoreClient.update();

    tokenClient = new TokenClient(spyLogger, relayer.address, spokePoolClients, hubPoolClient);
    profitClient = new MockProfitClient(spyLogger, hubPoolClient, spokePoolClients, []);
    for (const erc20 of [l1Token]) {
      await profitClient.initToken(erc20);
    }

    chainIds = Object.values(spokePoolClients).map(({ chainId }) => chainId);
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
        inventoryClient: new MockInventoryClient(null, null, null, null, null, hubPoolClient),
        acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, chainIds),
        tryMulticallClient,
      },
      {
        relayerTokens: [],
        minDepositConfirmations: defaultMinDepositConfirmations,
        sendingRelaysEnabled: true,
        tryMulticallChains: [],
        loggingInterval: -1,
      } as unknown as RelayerConfig
    );

    const weth = undefined;
    await setupTokensForWallet(spokePool_1, owner, [l1Token], weth, 100); // Seed owner to LP.
    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], weth, 10);
    await setupTokensForWallet(spokePool_2, depositor, [erc20_2], weth, 10);
    await setupTokensForWallet(spokePool_1, relayer, [erc20_1, erc20_2], weth, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_1, erc20_2], weth, 10);
    (hubPoolClient as SimpleMockHubPoolClient).mapTokenInfo(erc20_1.address, await l1Token.symbol());
    (hubPoolClient as SimpleMockHubPoolClient).mapTokenInfo(erc20_2.address, await l1Token.symbol());

    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);
    await configStore.updateTokenConfig(l1Token.address, defaultTokenConfig);

    await updateAllClients();

    // Set the spokePool's time to the provider time. This is done to enable the block utility time finder identify a
    // "reasonable" block number based off the block time when looking at quote timestamps.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
  });

  describe("Relayer: Check for Unfilled v3 Deposits and Fill", async function () {
    // Helper for quickly computing fill amounts.
    const getFillAmount = (relayData: RelayData, tokenPrice: BigNumber): BigNumber =>
      relayData.outputAmount.mul(tokenPrice).div(fixedPoint);

    const findOriginChainLimitIdx = (
      limits: { fromBlock: number; limit: BigNumber }[],
      blockNumber: number
    ): number => {
      return limits.findIndex(({ fromBlock }) => fromBlock <= blockNumber);
    };

    // Helper for verifying relayer deposit confirmation logic.
    const isChainOvercommitted = (limits: { limit: BigNumber }[]): boolean =>
      limits.some(({ limit }) => limit.lt(bnZero));

    const randomNumber = (ceil = 1_000_000) => Math.floor(Math.random() * ceil);

    let inputToken: string, outputToken: string;
    let inputAmount: BigNumber, outputAmount: BigNumber;

    beforeEach(async function () {
      inputToken = erc20_1.address;
      inputAmount = await erc20_1.balanceOf(depositor.address);
      outputToken = erc20_2.address;
      outputAmount = inputAmount.sub(depositRelayerFeePct.mul(inputAmount).div(fixedPoint));
    });

    it("Correctly fetches single unfilled deposit and fills it", async function () {
      const deposit = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );

      await updateAllClients();
      let txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      expect((await txnReceipts[destinationChainId]).length).to.equal(1);
      expect(lastSpyLogIncludes(spy, "Filled v3 deposit")).to.be.true;

      await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
      const fill = spokePoolClient_2.getFillsForOriginChain(deposit.originChainId).at(-1);
      expect(fill).to.exist;

      // Re-run the execution loop and validate that no additional relays are sent.
      multiCallerClient.clearTransactionQueue();
      txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      for (const receipts of Object.values(txnReceipts)) {
        expect((await receipts).length).to.equal(0);
      }
      expect(lastSpyLogIncludes(spy, "0 unfilled deposits")).to.be.true;
    });

    it("Internally tracks fill status", async function () {
      const deposit = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );

      await updateAllClients();
      const depositHash = spokePoolClients[deposit.destinationChainId].getDepositHash(deposit);

      // Force the fillStatus -> filled; the relayer should not try to fill the deposit.
      relayerInstance.fillStatus[depositHash] = FillStatus.Filled;
      expect(relayerInstance.fillStatus[depositHash]).to.equal(FillStatus.Filled);
      let txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      expect((await txnReceipts[destinationChainId]).length).to.equal(0);

      // Force the fillStatus -> unfilled; the relayer should try to fill the deposit.
      relayerInstance.fillStatus[depositHash] = FillStatus.Unfilled;
      expect(relayerInstance.fillStatus[depositHash]).to.equal(FillStatus.Unfilled);
      txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      expect((await txnReceipts[destinationChainId]).length).to.equal(1);

      // Verify that the relayer updated the fill status.
      expect(relayerInstance.fillStatus[depositHash]).to.equal(FillStatus.Filled);
    });

    it("Shouldn't double fill a deposit", async function () {
      await depositV3(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount);

      await updateAllClients();
      let txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      expect((await txnReceipts[destinationChainId]).length).to.equal(1);
      expect(lastSpyLogIncludes(spy, "Filled v3 deposit")).to.be.true;

      // The first fill is still pending but if we rerun the relayer loop, it shouldn't try to fill a second time.
      await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
      txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      for (const receipts of Object.values(txnReceipts)) {
        expect((await receipts).length).to.equal(0);
      }
    });

    it("Queries the latest onchain fill status for all deposits", async function () {
      const deposit = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );
      await updateAllClients();
      let unfilledDeposits = getAllUnfilledDeposits(spokePoolClients, hubPoolClient);
      expect(Object.values(unfilledDeposits).flat().length).to.equal(1);

      // Run the relayer in simulation mode so it doesn't fill the relay.
      const simulate = true;
      let txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill(false, simulate);
      for (const receipts of Object.values(txnReceipts)) {
        expect((await receipts).length).to.equal(0);
      }
      expect(spyLogIncludes(spy, -2, "Filled v3 deposit")).is.true;

      // Verify that the deposit is still unfilled (relayer didn't execute it).
      unfilledDeposits = getAllUnfilledDeposits(spokePoolClients, hubPoolClient);
      expect(Object.values(unfilledDeposits).flat().length).to.equal(1);

      // Fill the deposit and immediately check for unfilled deposits (without SpokePoolClient update).
      // There will still be 1 unfilled deposit because the SpokePoolClient has not been updated.
      await fillV3Relay(spokePool_2, deposit, relayer);
      unfilledDeposits = getAllUnfilledDeposits(spokePoolClients, hubPoolClient);
      expect(Object.values(unfilledDeposits).flat().length).to.equal(1);

      // Verify that the relayer now sees that the deposit has been filled.
      txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      for (const receipts of Object.values(txnReceipts)) {
        expect((await receipts).length).to.equal(0);
      }
      expect(lastSpyLogIncludes(spy, "0 unfilled deposits found")).to.be.true;
    });

    it("Respects configured relayer routes", async function () {
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
          tryMulticallClient,
          inventoryClient: new MockInventoryClient(),
          acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, chainIds),
        },
        {
          relayerTokens: [],
          relayerOriginChains: [destinationChainId],
          relayerDestinationChains: [originChainId],
          minDepositConfirmations: defaultMinDepositConfirmations,
          tryMulticallChains: [],
        } as unknown as RelayerConfig
      );

      // Test the underlying route validation logic.
      const routes = [
        { from: originChainId, to: destinationChainId, enabled: false },
        { from: originChainId, to: originChainId, enabled: false },
        { from: destinationChainId, to: originChainId, enabled: true },
        { from: destinationChainId, to: destinationChainId, enabled: false },
      ];
      routes.forEach(({ from, to, enabled }) => expect(relayerInstance.routeEnabled(from, to)).to.equal(enabled));

      // Deposit on originChainId, destined for destinationChainId => expect ignored.
      await depositV3(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount);
      await updateAllClients();
      const txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      for (const receipts of Object.values(txnReceipts)) {
        expect((await receipts).length).to.equal(0);
      }
    });

    it("Ignores expired deposits", async function () {
      const spokePoolTime = (await spokePool_2.getCurrentTime()).toNumber();
      const fillDeadline = spokePoolTime + 60;

      // Make a deposit and then increment SpokePool time beyond it.
      await depositV3(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount, {
        fillDeadline,
      });
      await spokePool_2.setCurrentTime(fillDeadline);
      const txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      for (const receipts of Object.values(txnReceipts)) {
        expect((await receipts).length).to.equal(0);
      }
      expect(multiCallerClient.transactionCount()).to.equal(0);
    });

    it("Ignores exclusive deposits", async function () {
      const exclusivityDeadline = 7200;
      const deposits: Deposit[] = [];
      const { fillStatus, relayerAddress } = relayerInstance;

      // Make two deposits - one with the relayer as exclusiveRelayer, and one with a random address.
      // Verify that the relayer can immediately fill the first deposit, and both after the exclusivity window.
      for (const exclusiveRelayer of [randomAddress(), relayerAddress]) {
        const deposit = await depositV3(
          spokePool_1,
          destinationChainId,
          depositor,
          inputToken,
          inputAmount.div(2),
          outputToken,
          outputAmount.div(2),
          { exclusivityDeadline, exclusiveRelayer }
        );
        deposits.push(deposit);
      }

      await updateAllClients();
      let txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      expect((await txnReceipts[destinationChainId]).length).to.equal(1);
      expect(lastSpyLogIncludes(spy, "Filled v3 deposit")).to.be.true;

      deposits.forEach((deposit) => {
        const depositHash = spokePoolClients[deposit.destinationChainId].getDepositHash(deposit);
        const status = deposit.exclusiveRelayer === relayerAddress ? FillStatus.Filled : FillStatus.Unfilled;
        expect(fillStatus[depositHash] ?? FillStatus.Unfilled).to.equal(status);
      });

      txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      expect((await txnReceipts[destinationChainId]).length).to.equal(0);
      expect(lastSpyLogIncludes(spy, "0 unfilled deposits found")).to.be.true;

      const exclusiveDeposit = deposits.find(({ exclusiveRelayer }) => exclusiveRelayer !== relayerAddress);
      expect(exclusiveDeposit).to.exist;
      await spokePool_2.setCurrentTime(exclusiveDeposit!.exclusivityDeadline + 1);
      await updateAllClients();

      // Relayer can unconditionally fill after the exclusivityDeadline.
      txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      expect((await txnReceipts[destinationChainId]).length).to.equal(1);
      expect(lastSpyLogIncludes(spy, "Filled v3 deposit")).to.be.true;

      deposits.forEach((deposit) => {
        const depositHash = spokePoolClients[deposit.destinationChainId].getDepositHash(deposit);
        expect(fillStatus[depositHash]).to.equal(FillStatus.Filled);
      });
    });

    it("Ignores deposits younger than min deposit confirmation threshold", async function () {
      await depositV3(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount);

      // Set MDC such that the deposit is ignored. The profit client will return a fill USD amount of $0,
      // so we need to set the MDC for the `0` threshold to be large enough such that the deposit would be ignored.
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
          tryMulticallClient,
          inventoryClient: new MockInventoryClient(null, null, null, null, null, hubPoolClient),
          acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, chainIds),
        },
        {
          relayerTokens: [],
          minDepositConfirmations: {
            [originChainId]: [{ usdThreshold: bnUint256Max, minConfirmations: 3 }],
          },
          sendingRelaysEnabled: true,
          tryMulticallChains: [],
        } as unknown as RelayerConfig
      );

      await updateAllClients();
      const txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      for (const receipts of Object.values(txnReceipts)) {
        expect((await receipts).length).to.equal(0);
      }
      expect(spyLogIncludes(spy, -2, "due to insufficient deposit confirmations.")).to.be.true;
      expect(lastSpyLogIncludes(spy, "0 unfilled deposits found.")).to.be.true;
    });

    it("Correctly defers destination chain fills", async function () {
      const { average: avgBlockTime } = await averageBlockTime(spokePool_2.provider);
      const minDepositAgeBlocks = 4; // Fill after deposit has aged this # of blocks.
      const minFillTime = Math.ceil(minDepositAgeBlocks * avgBlockTime);

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
          inventoryClient: new MockInventoryClient(null, null, null, null, null, hubPoolClient),
          acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, chainIds),
          tryMulticallClient,
        },
        {
          minFillTime: { [destinationChainId]: minFillTime },
          relayerTokens: [],
          minDepositConfirmations: defaultMinDepositConfirmations,
          sendingRelaysEnabled: true,
          tryMulticallChains: [],
        } as unknown as RelayerConfig
      );

      await depositV3(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount);
      await updateAllClients();
      let txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      for (const receipts of Object.values(txnReceipts)) {
        expect((await receipts).length).to.equal(0);
      }
      expect(lastSpyLogIncludes(spy, "due to insufficient fill time for")).to.be.true;

      // Mine enough blocks such that the deposit has aged sufficiently.
      for (let i = 0; i < minFillTime * minDepositAgeBlocks * 10; i++) {
        await hre.network.provider.send("evm_mine");
      }
      await updateAllClients();
      txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      const receipts = await txnReceipts[destinationChainId];
      expect(receipts.length).to.equal(1);
    });

    it("Correctly tracks origin chain fill commitments", async function () {
      await erc20_2.connect(relayer).approve(spokePool_2.address, MAX_SAFE_ALLOWANCE);

      const outputAmount = toBNWei("0.5");
      const inputAmount = outputAmount.sub(bnOne);
      const tokenPrice = toBNWei(1);
      profitClient.setTokenPrice(l1Token.address, tokenPrice);

      const deposit1 = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );
      const fillAmount = profitClient.getFillAmountInUsd(deposit1)!;
      expect(fillAmount).to.exist;

      // Simple escalating confirmation requirements; cap off with a default upper limit.
      const originChainConfirmations = [1, 4, 8].map((n) => ({
        usdThreshold: fillAmount.mul(100).div(100),
        minConfirmations: n,
      }));
      originChainConfirmations.push({
        usdThreshold: bnUint256Max,
        minConfirmations: originChainConfirmations.length + 1,
      });

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
          inventoryClient: new MockInventoryClient(null, null, null, null, null, hubPoolClient),
          acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, chainIds),
          tryMulticallClient,
        },
        {
          relayerTokens: [],
          minDepositConfirmations: {
            [originChainId]: originChainConfirmations,
            [destinationChainId]: [{ usdThreshold: bnUint256Max, minConfirmations: 1 }],
          },
          sendingRelaysEnabled: true,
          tryMulticallChains: [],
        } as unknown as RelayerConfig
      );

      let originChainCommitment = relayerInstance.computeOriginChainCommitment(
        originChainId,
        0,
        Number.MAX_SAFE_INTEGER
      );
      expect(originChainCommitment.eq(bnZero)).to.be.true;

      // Fill the deposit and verify that the commitment is updated.
      await fillV3Relay(spokePool_2, deposit1, relayer);
      await updateAllClients();

      originChainCommitment = relayerInstance.computeOriginChainCommitment(originChainId, 0, Number.MAX_SAFE_INTEGER);
      expect(originChainCommitment.eq(getFillAmount(deposit1, tokenPrice))).to.be.true;

      let originChainLimits = relayerInstance.computeOriginChainLimits(originChainId);
      expect(isChainOvercommitted(originChainLimits)).to.be.false;

      // Identify the residual limit for the origin chain.
      let limitIdx = findOriginChainLimitIdx(originChainLimits, deposit1.blockNumber);
      const { limit } = originChainLimits[limitIdx];
      expect(limit.gte(bnZero)).to.be.true;

      // Make another fill -> overcommit by `fillAmount`.
      const limitAmount = limit.mul(fixedPoint).div(tokenPrice); // Convert back from USD to token units.
      const deposit2 = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        limitAmount.add(fillAmount),
        outputToken,
        limitAmount.add(fillAmount)
      );
      await fillV3Relay(spokePool_2, deposit2, relayer);
      await updateAllClients();

      originChainLimits = relayerInstance.computeOriginChainLimits(originChainId);
      expect(isChainOvercommitted(originChainLimits)).to.be.true;

      limitIdx = findOriginChainLimitIdx(originChainLimits, deposit1.blockNumber);
      expect(limitIdx).to.not.equal(-1);
      const { fromBlock } = originChainLimits[limitIdx];
      expect(fromBlock).to.be.lessThan(Number.MAX_SAFE_INTEGER);

      while (isChainOvercommitted(relayerInstance.computeOriginChainLimits(originChainId))) {
        // Make a deposit to crank the chain forward.
        await depositV3(spokePool_1, destinationChainId, depositor, inputToken, bnZero, outputToken, bnZero);
        await updateAllClients();
      }

      // The complete chain commitment should correspond to the first 2 fills.
      originChainCommitment = relayerInstance.computeOriginChainCommitment(originChainId, 0, Number.MAX_SAFE_INTEGER);
      expect(originChainCommitment.eq(getFillAmount(deposit1, tokenPrice).add(getFillAmount(deposit2, tokenPrice)))).to
        .be.true;

      // Narrow the search to the 2nd fill and verify it sums the commitment correctly.
      originChainCommitment = relayerInstance.computeOriginChainCommitment(
        originChainId,
        deposit2.blockNumber,
        Number.MAX_SAFE_INTEGER
      );
      expect(originChainCommitment.eq(getFillAmount(deposit2, tokenPrice))).to.be.true;

      // Verify that the limits are correctly formatted and passed back via fillLimits().
      originChainLimits = relayerInstance.computeOriginChainLimits(originChainId);
      const fillLimits = relayerInstance.computeFillLimits();
      expect(fillLimits[originChainId]).to.deep.equal(originChainLimits);

      // Make a large fill and verify that the relevant fillLimits go negative.
      const deposit3 = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        fillAmount.mul(4),
        outputToken,
        fillAmount.mul(4)
      );
      await fillV3Relay(spokePool_2, deposit3, relayer);
      await updateAllClients();
      originChainLimits = relayerInstance.computeOriginChainLimits(originChainId);
      expect(originChainLimits.slice(0, -1).every(({ limit }) => limit.lt(bnZero))).to.be.true;
    });

    it("Ignores deposits with quote times in future", async function () {
      await erc20_2.connect(relayer).approve(spokePool_2.address, MAX_SAFE_ALLOWANCE);

      const outputAmount = toBNWei("0.5");
      const inputAmount = outputAmount.mul(101).div(100); // Relayers gotta eat.
      const tokenPrice = toBNWei(1);
      profitClient.setTokenPrice(l1Token.address, tokenPrice);

      // Simple escalating confirmation requirements; cap off with a default upper limit.
      const fillAmount = outputAmount.mul(tokenPrice).div(fixedPoint);
      const originChainConfirmations = [1, 4, 8].map((n) => ({ usdThreshold: fillAmount.mul(n), minConfirmations: n }));
      originChainConfirmations.push({
        usdThreshold: bnUint256Max,
        minConfirmations: originChainConfirmations.length + 1,
      });

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
          inventoryClient: new MockInventoryClient(null, null, null, null, null, hubPoolClient),
          acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, chainIds),
          tryMulticallClient,
        },
        {
          relayerTokens: [],
          minDepositConfirmations: {
            [originChainId]: originChainConfirmations,
            [destinationChainId]: [{ usdThreshold: bnUint256Max, minConfirmations: 1 }],
          },
          sendingRelaysEnabled: true,
          tryMulticallChains: [],
        } as unknown as RelayerConfig
      );

      // Make a deposit; the relayer should refuse to fill it until it is no longer overcommitted.
      const deposit1 = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );
      await updateAllClients();

      let txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      let fills = await (txnReceipts[destinationChainId] ?? Promise.resolve([]));
      expect(fills.length).to.equal(0);

      // And a 2nd deposit; the relayer should defer filling this one after the first deposit.
      const deposit2 = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );
      await updateAllClients();

      // Make an invalid fills to crank the chain forward until the initial deposit has enough confirmations.
      while (
        originChainConfirmations[0].minConfirmations >
        spokePoolClient_2.latestBlockSearched - deposit1.blockNumber
      ) {
        await fillV3Relay(
          spokePool_2,
          { ...deposit1, depositId: BigNumber.from(randomNumber()), outputAmount: bnZero },
          relayer
        );
        await updateAllClients();
      }
      const originChainLimits = relayerInstance.computeOriginChainLimits(originChainId);

      // Verify that the relayer now fills the latest deposit.
      txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      fills = await (txnReceipts[destinationChainId] ?? Promise.resolve([]));
      expect(fills.length).to.equal(1);

      await updateAllClients();

      // Verify the updated limits. Skip the first index because it's already in the past.
      relayerInstance
        .computeOriginChainLimits(originChainId)
        .slice(1)
        .forEach(({ limit: newLimit }, idx) => {
          const { limit: oldLimit } = originChainLimits.slice(1)[idx];
          expect(newLimit.eq(oldLimit.sub(fillAmount))).to.be.true;
        });

      // Make an invalid fills to crank the chain forward until the 2nd deposit has enough confirmations.
      while (
        originChainConfirmations[0].minConfirmations >
        spokePoolClient_2.latestBlockSearched - deposit2.blockNumber
      ) {
        await fillV3Relay(
          spokePool_2,
          { ...deposit2, depositId: BigNumber.from(randomNumber()), outputAmount: bnZero },
          relayer
        );
        await updateAllClients();
      }

      // Verify that the relayer now fills the latest deposit.
      txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      fills = await (txnReceipts[destinationChainId] ?? Promise.resolve([]));
      expect(fills.length).to.equal(1);

      await updateAllClients();

      // Verify the updated limits. Skip the first index because it's already in the past.
      relayerInstance
        .computeOriginChainLimits(originChainId)
        .slice(1)
        .forEach(({ limit: newLimit }, idx) => {
          const { limit: oldLimit } = originChainLimits.slice(1)[idx];
          expect(newLimit.eq(oldLimit.sub(fillAmount.mul(2)))).to.be.true;
        });
    });

    it("Ignores deposits with quote times in future", async function () {
      const { quoteTimestamp } = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );

      // Override hub pool client timestamp to make deposit look like its in the future
      await updateAllClients();
      hubPoolClient.currentTime = quoteTimestamp - 100;
      let txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      for (const receipts of Object.values(txnReceipts)) {
        expect((await receipts).length).to.equal(0);
      }
      expect(lastSpyLogIncludes(spy, "0 unfilled deposits")).to.be.true;

      // If we reset the timestamp to within the block lag buffer, the relayer will fill the deposit:
      hubPoolClient.currentTime = quoteTimestamp - 1;
      txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      expect((await txnReceipts[destinationChainId]).length).to.equal(1);
      expect(lastSpyLogIncludes(spy, "Filled v3 deposit")).to.be.true;
    });

    it("Ignores deposit with non-empty message", async function () {
      const { profitClient } = relayerInstance.clients;
      inputAmount = inputAmount.div(2); // Permit 2 deposits.

      for (const sendingMessageRelaysEnabled of [false, true]) {
        relayerInstance.config.sendingMessageRelaysEnabled = sendingMessageRelaysEnabled;
        profitClient.clearUnprofitableFills();

        await depositV3(
          spokePool_1,
          destinationChainId,
          depositor,
          inputToken,
          inputAmount,
          outputToken,
          outputAmount,
          { message: "0x0000" }
        );

        await updateAllClients();
        const txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
        for (const receipts of Object.values(txnReceipts)) {
          expect((await receipts).length).to.equal(0);
        }

        // Dynamic fill simulation fails in test, so the deposit will
        // appear as unprofitable when message filling is enabled.
        expect(spy.getCalls().find(({ lastArg }) => lastArg.message.includes("Skipping fill for deposit with message")))
          .to.not.be.undefined;
        expect(profitClient.anyCapturedUnprofitableFills()).to.equal(sendingMessageRelaysEnabled);
      }
    });

    it("Ignores deposit from preconfigured addresses", async function () {
      relayerInstance.config.ignoredAddresses = new Set([depositor.address]);

      await depositV3(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount);
      await updateAllClients();

      const txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      for (const receipts of Object.values(txnReceipts)) {
        expect((await receipts).length).to.equal(0);
      }

      expect(
        spy
          .getCalls()
          .find(({ lastArg }) => lastArg.message.includes(`Ignoring ${srcChain} deposit destined for ${dstChain}.`))
      ).to.not.be.undefined;
    });

    it("Uses lowest outputAmount on updated deposits", async function () {
      const deposit = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );

      // Relayer will ignore any deposit with a non empty message. Test this by first modifying the deposit's
      // message to be non-empty. Then, reset it to 0x and check that it ignores it.
      // Send 3 updates. Check that only the one with the lowest updated outputAmount is used.
      const updates = [
        { ignored: true, outputAmount: outputAmount.sub(1), recipient: randomAddress(), message: "0x12" },
        { ignored: true, outputAmount: outputAmount.sub(1), recipient: randomAddress(), message: "0x1212" },
        { ignored: false, outputAmount: outputAmount.sub(2), recipient: randomAddress(), message: EMPTY_MESSAGE },
      ];

      for (const update of updates) {
        await updateDeposit(
          spokePool_1,
          {
            ...deposit,
            updatedRecipient: update.recipient,
            updatedOutputAmount: update.outputAmount,
            updatedMessage: update.message,
          },
          depositor
        );

        await relayerInstance.runMaintenance(); // Flush any ignored deposits.
        await updateAllClients();
        const txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
        if (update.ignored) {
          for (const receipts of Object.values(txnReceipts)) {
            expect((await receipts).length).to.equal(0);
          }

          expect(
            spy.getCalls().find(({ lastArg }) => lastArg.message.includes("Skipping fill for deposit with message"))
          ).to.not.be.undefined;
        } else {
          // Now speed up deposit again with a higher fee and a message of 0x. This should be filled.
          expect((await txnReceipts[destinationChainId]).length).to.equal(1);
          expect(lastSpyLogIncludes(spy, "Filled v3 deposit")).to.be.true;

          await spokePoolClient_2.update();
          let fill = spokePoolClient_2.getFillsForRelayer(relayer.address).at(-1);
          expect(fill).to.exist;
          fill = fill!;

          expect(fill.relayExecutionInfo.updatedOutputAmount.eq(deposit.outputAmount)).to.be.false;
          expect(fill.relayExecutionInfo.updatedOutputAmount.eq(update.outputAmount)).to.be.true;

          expect(fill.relayExecutionInfo.updatedRecipient).to.not.equal(deposit.recipient);
          expect(fill.relayExecutionInfo.updatedRecipient).to.equal(update.recipient);

          expect(fill.relayExecutionInfo.updatedMessageHash).to.equal(deposit.messageHash);
          expect(fill.relayExecutionInfo.updatedMessageHash.toString()).to.equal(getMessageHash(update.message));
        }
      }

      // Re-run the execution loop and validate that no additional relays are sent.
      multiCallerClient.clearTransactionQueue();
      await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
      const txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      for (const receipts of Object.values(txnReceipts)) {
        expect((await receipts).length).to.equal(0);
      }
      expect(lastSpyLogIncludes(spy, "0 unfilled deposits")).to.be.true;
    });

    it("Selects the correct message in an updated deposit", async function () {
      // Initial deposit without a message.
      const deposit = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );

      // Deposit is followed by an update that adds a message.
      let updatedOutputAmount = deposit.outputAmount.sub(bnOne);
      let updatedMessage = "0x1234";
      const updatedRecipient = randomAddress();
      await updateDeposit(
        spokePool_1,
        { ...deposit, updatedRecipient, updatedOutputAmount, updatedMessage },
        depositor
      );

      await updateAllClients();
      let txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      for (const receipts of Object.values(txnReceipts)) {
        expect((await receipts).length).to.equal(0);
      }
      expect(spy.getCalls().find(({ lastArg }) => lastArg.message.includes("Skipping fill for deposit with message")))
        .to.not.be.undefined;

      // Deposit is updated again with a nullified message.
      updatedOutputAmount = updatedOutputAmount.sub(bnOne);
      updatedMessage = EMPTY_MESSAGE;
      await updateDeposit(
        spokePool_1,
        { ...deposit, updatedRecipient, updatedOutputAmount, updatedMessage },
        depositor
      );

      await updateAllClients();
      await relayerInstance.runMaintenance(); // Flush any ignored deposits.
      txnReceipts = await relayerInstance.checkForUnfilledDepositsAndFill();
      expect((await txnReceipts[destinationChainId]).length).to.equal(1);
      expect(lastSpyLogIncludes(spy, "Filled v3 deposit")).to.be.true;
    });
  });
});
