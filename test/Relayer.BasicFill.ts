import { clients, constants, utils as sdkUtils } from "@across-protocol/sdk-v2";
import { AcrossApiClient, ConfigStoreClient, MultiCallerClient, TokenClient } from "../src/clients";
import { CONFIG_STORE_VERSION } from "../src/common";
import { bnOne, getUnfilledDeposits } from "../src/utils";
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
import { MockConfigStoreClient, MockInventoryClient, MockProfitClient } from "./mocks";
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
  getRelayDataHash,
  lastSpyLogIncludes,
  randomAddress,
  setupTokensForWallet,
  sinon,
  updateDeposit,
  winston,
} from "./utils";

describe("Relayer: Check for Unfilled Deposits and Fill", async function () {
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
  let spokePool1DeploymentBlock: number, spokePool2DeploymentBlock: number;

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

    hubPoolClient = new clients.HubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    multiCallerClient = new MockedMultiCallerClient(spyLogger);

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
        inventoryClient: new MockInventoryClient(),
        acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, spokePoolClients),
      },
      {
        relayerTokens: [],
        minDepositConfirmations: defaultMinDepositConfirmations,
      } as unknown as RelayerConfig
    );

    const weth = undefined;
    await setupTokensForWallet(spokePool_1, owner, [l1Token], weth, 100); // Seed owner to LP.
    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], weth, 10);
    await setupTokensForWallet(spokePool_2, depositor, [erc20_2], weth, 10);
    await setupTokensForWallet(spokePool_1, relayer, [erc20_1, erc20_2], weth, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_1, erc20_2], weth, 10);

    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);
    await configStore.updateTokenConfig(l1Token.address, defaultTokenConfig);

    await updateAllClients();

    // Set the spokePool's time to the provider time. This is done to enable the block utility time finder identify a
    // "reasonable" block number based off the block time when looking at quote timestamps.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
  });

  describe("Relayer: Check for Unfilled v3 Deposits and Fill", async function () {
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
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(lastSpyLogIncludes(spy, "Filling v3 deposit")).to.be.true;
      expect(multiCallerClient.transactionCount()).to.equal(1); // One transaction, filling the one deposit.

      const tx = await multiCallerClient.executeTransactionQueue();
      expect(tx.length).to.equal(1); // There should have been exactly one transaction.

      await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
      let fill = spokePoolClient_2.getFillsForOriginChain(deposit.originChainId).at(-1);
      expect(fill).to.exist;
      fill = fill!;

      expect(getRelayDataHash(fill, fill.destinationChainId)).to.equal(
        getRelayDataHash(deposit, deposit.destinationChainId)
      );

      // Re-run the execution loop and validate that no additional relays are sent.
      multiCallerClient.clearTransactionQueue();
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(multiCallerClient.transactionCount()).to.equal(0); // no Transactions to send.
      expect(lastSpyLogIncludes(spy, "0 unfilled deposits")).to.be.true;
    });

    it("Shouldn't double fill a deposit", async function () {
      await depositV3(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount);

      await updateAllClients();
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(lastSpyLogIncludes(spy, "Filling v3 deposit")).to.be.true;
      expect(multiCallerClient.transactionCount()).to.equal(1); // One transaction, filling the one deposit.
      await multiCallerClient.executeTxnQueues();

      // The first fill is still pending but if we rerun the relayer loop, it shouldn't try to fill a second time.
      await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(multiCallerClient.transactionCount()).to.equal(0); // no new transactions were enqueued.
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
      let unfilledDeposits = await getUnfilledDeposits(spokePoolClients, hubPoolClient);
      expect(Object.values(unfilledDeposits).flat().length).to.equal(1);

      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(lastSpyLogIncludes(spy, "Filling v3 deposit")).to.be.true;
      expect(multiCallerClient.transactionCount()).to.equal(1); // One transaction, filling the one deposit.

      // Verify that the deposit is still unfilled (relayer didn't execute it).
      unfilledDeposits = await getUnfilledDeposits(spokePoolClients, hubPoolClient);
      expect(Object.values(unfilledDeposits).flat().length).to.equal(1);

      // Fill the deposit and immediately check for unfilled deposits (without SpokePoolClient update).
      await fillV3Relay(spokePool_2, deposit, relayer);
      unfilledDeposits = await getUnfilledDeposits(spokePoolClients, hubPoolClient);
      expect(Object.values(unfilledDeposits).flat().length).to.equal(0);

      // Verify that the relayer now sees that the deposit has been filled.
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(lastSpyLogIncludes(spy, "0 unfilled deposits")).to.be.true;
      expect(multiCallerClient.transactionCount()).to.equal(0);
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
          inventoryClient: new MockInventoryClient(),
          acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, spokePoolClients),
        },
        {
          relayerTokens: [],
          relayerOriginChains: [destinationChainId],
          relayerDestinationChains: [originChainId],
          minDepositConfirmations: defaultMinDepositConfirmations,
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
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(
        spy.getCalls().find(({ lastArg }) => lastArg.message.includes("Skipping deposit from or to disabled chains"))
      ).to.not.be.undefined;
    });

    it("Correctly validates self-relays", async function () {
      outputAmount = inputAmount.sub(bnOne);
      for (const testDepositor of [depositor, relayer]) {
        await depositV3(
          spokePool_1,
          destinationChainId,
          testDepositor,
          inputToken,
          inputAmount,
          outputToken,
          outputAmount
        );

        await updateAllClients();
        await relayerInstance.checkForUnfilledDepositsAndFill();
        const expectedTransactions = testDepositor.address === relayer.address ? 1 : 0;
        expect(multiCallerClient.transactionCount()).to.equal(expectedTransactions);
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
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(multiCallerClient.transactionCount()).to.equal(0);
    });

    it("Ignores exclusive deposits", async function () {
      const currentTime = (await spokePool_2.getCurrentTime()).toNumber();
      const exclusivityDeadline = currentTime + 7200;

      // Make two deposits - one with the relayer as exclusiveRelayer, and one with a random address.
      // Verify that the relayer can immediately fill the first deposit, and both after the exclusivity window.
      for (const exclusiveRelayer of [randomAddress(), relayerInstance.relayerAddress]) {
        await depositV3(
          spokePool_1,
          destinationChainId,
          depositor,
          inputToken,
          inputAmount.div(2),
          outputToken,
          outputAmount.div(2),
          { exclusivityDeadline, exclusiveRelayer }
        );
      }

      await updateAllClients();
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(multiCallerClient.transactionCount()).to.equal(1);

      await spokePool_2.setCurrentTime(exclusivityDeadline + 1);
      await updateAllClients();

      // Relayer can unconditionally fill after the exclusivityDeadline.
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(multiCallerClient.transactionCount()).to.equal(2);
    });

    it("Ignores deposits older than min deposit confirmation threshold", async function () {
      await depositV3(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount);

      // Set MDC such that the deposit is is ignored. The profit client will return a fill USD amount of $0,
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
          inventoryClient: new MockInventoryClient(),
          acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, spokePoolClients),
        },
        {
          relayerTokens: [],
          minDepositConfirmations: {
            default: { [originChainId]: 10 }, // This needs to be set large enough such that the deposit is ignored.
          },
          sendingRelaysEnabled: false,
        } as unknown as RelayerConfig
      );

      await updateAllClients();
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(lastSpyLogIncludes(spy, "due to insufficient deposit confirmations")).to.be.true;
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
      hubPoolClient.currentTime = quoteTimestamp - 1;
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(lastSpyLogIncludes(spy, "0 unfilled deposits")).to.be.true;

      // If we reset the timestamp, the relayer will fill the deposit:
      hubPoolClient.currentTime = quoteTimestamp;
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(multiCallerClient.transactionCount()).to.equal(1);
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
        await relayerInstance.checkForUnfilledDepositsAndFill();

        // Dynamic fill simulation fails in test, so the deposit will
        // appear as unprofitable when message filling is enabled.
        expect(spy.getCalls().find(({ lastArg }) => lastArg.message.includes("Skipping fill for deposit with message")))
          .to.not.be.undefined;
        expect(profitClient.anyCapturedUnprofitableFills()).to.equal(sendingMessageRelaysEnabled);
        expect(multiCallerClient.transactionCount()).to.equal(0);
      }
    });

    it("Ignores deposit from preconfigured addresses", async function () {
      relayerInstance.config.ignoredAddresses = [depositor.address];

      await depositV3(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount);
      await updateAllClients();
      await relayerInstance.checkForUnfilledDepositsAndFill();

      expect(spy.getCalls().find(({ lastArg }) => lastArg.message.includes("Ignoring deposit"))).to.not.be.undefined;
      expect(multiCallerClient.transactionCount()).to.equal(0);
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

        await updateAllClients();
        await relayerInstance.checkForUnfilledDepositsAndFill();
        if (update.ignored) {
          expect(
            spy.getCalls().find(({ lastArg }) => lastArg.message.includes("Skipping fill for deposit with message"))
          ).to.not.be.undefined;
          expect(multiCallerClient.transactionCount()).to.equal(0);
        } else {
          // Now speed up deposit again with a higher fee and a message of 0x. This should be filled.
          expect(lastSpyLogIncludes(spy, "Filling v3 deposit")).to.be.true;
          expect(multiCallerClient.transactionCount()).to.equal(1); // One transaction, filling the one deposit.

          const tx = await multiCallerClient.executeTransactionQueue();
          expect(tx.length).to.equal(1); // There should have been exactly one transaction.

          await spokePoolClient_2.update();
          let fill = spokePoolClient_2.getFillsForRelayer(relayer.address).at(-1);
          expect(fill).to.exist;
          fill = fill!;

          expect(getRelayDataHash(fill, fill.destinationChainId)).to.equal(
            getRelayDataHash(deposit, deposit.destinationChainId)
          );

          expect(fill.relayExecutionInfo.updatedOutputAmount.eq(deposit.outputAmount)).to.be.false;
          expect(fill.relayExecutionInfo.updatedOutputAmount.eq(update.outputAmount)).to.be.true;

          expect(fill.relayExecutionInfo.updatedRecipient).to.not.equal(deposit.recipient);
          expect(fill.relayExecutionInfo.updatedRecipient).to.equal(update.recipient);

          expect(fill.relayExecutionInfo.updatedMessage).to.equal(deposit.message);
          expect(fill.relayExecutionInfo.updatedMessage.toString()).to.equal(update.message);
        }
      }

      // Re-run the execution loop and validate that no additional relays are sent.
      multiCallerClient.clearTransactionQueue();
      await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(multiCallerClient.transactionCount()).to.equal(0); // no Transactions to send.
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
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(spy.getCalls().find(({ lastArg }) => lastArg.message.includes("Skipping fill for deposit with message")))
        .to.not.be.undefined;
      expect(multiCallerClient.transactionCount()).to.equal(0);

      // Deposit is updated again with a nullified message.
      updatedOutputAmount = updatedOutputAmount.sub(bnOne);
      updatedMessage = EMPTY_MESSAGE;
      await updateDeposit(
        spokePool_1,
        { ...deposit, updatedRecipient, updatedOutputAmount, updatedMessage },
        depositor
      );

      await updateAllClients();
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(lastSpyLogIncludes(spy, "Filling v3 deposit")).to.be.true;
      expect(multiCallerClient.transactionCount()).to.equal(1);
    });
  });
});
