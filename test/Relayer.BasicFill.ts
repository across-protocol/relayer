import { clients, constants, utils as sdkUtils } from "@across-protocol/sdk-v2";
import { AcrossApiClient, ConfigStoreClient, MultiCallerClient, TokenClient } from "../src/clients";
import { V2FillWithBlock, V3FillWithBlock } from "../src/interfaces";
import { CONFIG_STORE_VERSION } from "../src/common";
import { bnZero, bnOne, delay, getCurrentTime } from "../src/utils";
import { Relayer } from "../src/relayer/Relayer";
import { RelayerConfig } from "../src/relayer/RelayerConfig"; // Tested
import {
  amountToDeposit,
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
  buildDeposit,
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
  getUpdatedV3DepositSignature,
  getV3RelayHash,
  lastSpyLogIncludes,
  modifyRelayHelper,
  randomAddress,
  setupTokensForWallet,
  sinon,
  toBNWei,
  winston,
} from "./utils";

describe("Relayer: Check for Unfilled Deposits and Fill", async function () {
  // The relayer references host time; spin the wheels until the deposit expires. This is annoying because hre time
  // runs ahead of host time and the SpokePoolClient doesn't permit chain time to move backwards, so the test takes
  // a few seconds. This should only be visible when tests aren't run in parallel (--parallel). @todo: improve!
  const waitForHostTime = async (timestamp: number): Promise<void> => {
    do {
      await delay(1);
    } while (getCurrentTime() < timestamp);
  };

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

    await setupTokensForWallet(spokePool_1, owner, [l1Token], null, 100); // Seed owner to LP.
    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], null, 10);
    await setupTokensForWallet(spokePool_2, depositor, [erc20_2], null, 10);
    await setupTokensForWallet(spokePool_1, relayer, [erc20_1, erc20_2], null, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_1, erc20_2], null, 10);

    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);
    await configStore.updateTokenConfig(l1Token.address, defaultTokenConfig);

    await updateAllClients();

    // Set the spokePool's time to the provider time. This is done to enable the block utility time finder identify a
    // "reasonable" block number based off the block time when looking at quote timestamps.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
  });

  describe("Across v2", async function () {
    it("Correctly fetches single unfilled deposit and fills it", async function () {
      const deposit1 = await depositV2(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

      await updateAllClients();
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(lastSpyLogIncludes(spy, "Filling deposit")).to.be.true;
      expect(multiCallerClient.transactionCount()).to.equal(1); // One transaction, filling the one deposit.

      const tx = await multiCallerClient.executeTransactionQueue();
      expect(tx.length).to.equal(1); // There should have been exactly one transaction.

      // Check the state change happened correctly on the smart contract. There should be exactly one fill on spokePool_2.
      const fillEvents2 = await spokePool_2.queryFilter(spokePool_2.filters.FilledRelay());
      expect(fillEvents2.length).to.equal(1);
      expect(fillEvents2[0].args.depositId).to.equal(deposit1.depositId);
      expect(fillEvents2[0].args.amount).to.equal(deposit1.amount);
      expect(fillEvents2[0].args.destinationChainId).to.equal(Number(deposit1.destinationChainId));
      expect(fillEvents2[0].args.originChainId).to.equal(Number(deposit1.originChainId));
      expect(fillEvents2[0].args.relayerFeePct).to.equal(deposit1.relayerFeePct);
      expect(fillEvents2[0].args.depositor).to.equal(deposit1.depositor);
      expect(fillEvents2[0].args.recipient).to.equal(deposit1.recipient);
      expect(fillEvents2[0].args.updatableRelayData.relayerFeePct).to.equal(deposit1.relayerFeePct);

      // There should be no fill events on the origin spoke pool.
      expect((await spokePool_1.queryFilter(spokePool_1.filters.FilledRelay())).length).to.equal(0);

      // Re-run the execution loop and validate that no additional relays are sent.
      multiCallerClient.clearTransactionQueue();
      await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(multiCallerClient.transactionCount()).to.equal(0); // no Transactions to send.
      expect(lastSpyLogIncludes(spy, "0 unfilled deposits")).to.be.true;
    });

    it("Correctly validates self-relays", async function () {
      const relayerFeePct = bnZero;
      for (const testDepositor of [depositor, relayer]) {
        await depositV2(
          spokePool_1,
          erc20_1,
          relayer,
          testDepositor,
          destinationChainId,
          amountToDeposit,
          relayerFeePct
        );

        await updateAllClients();
        await relayerInstance.checkForUnfilledDepositsAndFill();
        const expectedTransactions = testDepositor.address === relayer.address ? 1 : 0;
        expect(multiCallerClient.transactionCount()).to.equal(expectedTransactions);
      }
    });

    it("Ignores deposits older than min deposit confirmation threshold", async function () {
      await depositV2(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

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
      expect(lastSpyLogIncludes(spy, "0 unfilled deposits")).to.be.true;
    });

    it("Ignores deposits with quote times in future", async function () {
      const { quoteTimestamp } = await depositV2(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

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
      const quoteTimestamp = await spokePool_1.getCurrentTime();
      const { profitClient } = relayerInstance.clients;

      for (const sendingMessageRelaysEnabled of [false, true]) {
        relayerInstance.config.sendingMessageRelaysEnabled = sendingMessageRelaysEnabled;
        profitClient.clearUnprofitableFills();

        await buildDeposit(
          hubPoolClient,
          spokePool_1,
          erc20_1,
          l1Token,
          depositor,
          destinationChainId,
          bnOne, // amount
          bnOne, // relayerFeePct
          quoteTimestamp,
          "0x0000" // message
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

      await depositV2(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
      await updateAllClients();
      await relayerInstance.checkForUnfilledDepositsAndFill();

      expect(spy.getCalls().find(({ lastArg }) => lastArg.message.includes("Ignoring deposit"))).to.not.be.undefined;
      expect(multiCallerClient.transactionCount()).to.equal(0);
    });

    it("Uses new relayer fee pct on updated deposits", async function () {
      const deposit1 = await buildDeposit(hubPoolClient, spokePool_1, erc20_1, l1Token, depositor, destinationChainId);

      // Relayer will ignore any deposit with a non empty message. Test this by first modifying the deposit's
      // message to be non-empty. Then, reset it to 0x and check that it ignores it.
      const newRelayerFeePct = toBNWei(0.1337);
      const newMessage = "0x12";
      const newRecipient = randomAddress();
      const { signature: speedUpSignature } = await modifyRelayHelper(
        newRelayerFeePct,
        deposit1.depositId.toString(),
        deposit1.originChainId.toString(),
        depositor,
        newRecipient,
        newMessage
      );

      const unusedSpeedUp = {
        relayerFeePct: toBNWei(0.1),
        message: "0x1212",
        recipient: randomAddress(),
      };
      const { signature: unusedSpeedUpSignature } = await modifyRelayHelper(
        unusedSpeedUp.relayerFeePct,
        deposit1.depositId.toString(),
        deposit1.originChainId.toString(),
        depositor,
        unusedSpeedUp.recipient,
        unusedSpeedUp.message
      );
      // Send 3 speed ups. Check that only the one with the higher updated relayer fee % is used.
      await spokePool_1.speedUpDeposit(
        depositor.address,
        unusedSpeedUp.relayerFeePct,
        deposit1.depositId,
        unusedSpeedUp.recipient,
        unusedSpeedUp.message,
        unusedSpeedUpSignature
      );
      await spokePool_1.speedUpDeposit(
        depositor.address,
        newRelayerFeePct,
        deposit1.depositId,
        newRecipient,
        newMessage,
        speedUpSignature
      );
      await spokePool_1.speedUpDeposit(
        depositor.address,
        unusedSpeedUp.relayerFeePct,
        deposit1.depositId,
        unusedSpeedUp.recipient,
        unusedSpeedUp.message,
        unusedSpeedUpSignature
      );
      await updateAllClients();
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(spy.getCalls().find(({ lastArg }) => lastArg.message.includes("Skipping fill for deposit with message")))
        .to.not.be.undefined;
      expect(multiCallerClient.transactionCount()).to.equal(0);

      // Now speed up deposit again with a higher fee and a message of 0x. This should be filled.
      const emptyMessageSpeedUp = {
        relayerFeePct: toBNWei(0.2),
        message: "0x",
        recipient: randomAddress(),
      };
      const emptyMessageSpeedUpSignature = await modifyRelayHelper(
        emptyMessageSpeedUp.relayerFeePct,
        deposit1.depositId.toString(),
        deposit1.originChainId.toString(),
        depositor,
        emptyMessageSpeedUp.recipient,
        emptyMessageSpeedUp.message
      );
      await spokePool_1.speedUpDeposit(
        depositor.address,
        emptyMessageSpeedUp.relayerFeePct,
        deposit1.depositId,
        emptyMessageSpeedUp.recipient,
        emptyMessageSpeedUp.message,
        emptyMessageSpeedUpSignature.signature
      );
      await updateAllClients();
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(lastSpyLogIncludes(spy, "Filling deposit")).to.be.true;
      expect(multiCallerClient.transactionCount()).to.equal(1); // One transaction, filling the one deposit.

      const tx = await multiCallerClient.executeTransactionQueue();
      expect(tx.length).to.equal(1); // There should have been exactly one transaction.

      // Check the state change happened correctly on the smart contract. There should be exactly one fill on spokePool_2.
      const fillEvents2 = await spokePool_2.queryFilter(spokePool_2.filters.FilledRelay());
      expect(fillEvents2.length).to.equal(1);
      expect(fillEvents2[0].args.depositId).to.equal(deposit1.depositId);
      expect(fillEvents2[0].args.amount).to.equal(deposit1.amount);
      expect(fillEvents2[0].args.destinationChainId).to.equal(Number(deposit1.destinationChainId));
      expect(fillEvents2[0].args.originChainId).to.equal(Number(deposit1.originChainId));
      expect(fillEvents2[0].args.relayerFeePct).to.equal(deposit1.relayerFeePct);
      expect(fillEvents2[0].args.depositor).to.equal(deposit1.depositor);
      expect(fillEvents2[0].args.recipient).to.equal(deposit1.recipient);

      // This specific line differs from the above test: the emitted event's appliedRelayerFeePct is
      // now !== relayerFeePct.
      expect(fillEvents2[0].args.updatableRelayData.relayerFeePct).to.equal(emptyMessageSpeedUp.relayerFeePct);
      expect(fillEvents2[0].args.updatableRelayData.recipient).to.equal(emptyMessageSpeedUp.recipient);
      expect(fillEvents2[0].args.updatableRelayData.message).to.equal(emptyMessageSpeedUp.message);

      // There should be no fill events on the origin spoke pool.
      expect((await spokePool_1.queryFilter(spokePool_1.filters.FilledRelay())).length).to.equal(0);

      // Re-run the execution loop and validate that no additional relays are sent.
      multiCallerClient.clearTransactionQueue();
      await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(multiCallerClient.transactionCount()).to.equal(0); // no Transactions to send.
      expect(lastSpyLogIncludes(spy, "0 unfilled deposits")).to.be.true;
    });

    it("Selects the correct message in an updated deposit", async function () {
      // Initial deposit without a message.
      const deposit = await buildDeposit(
        hubPoolClient,
        spokePool_1,
        erc20_1,
        l1Token,
        depositor,
        destinationChainId,
        undefined, // amount
        undefined, // relayerFeePct
        undefined, // quoteTimestamp
        "0x" // message
      );

      // Deposit is followed by an update that adds a message.
      let newRelayerFeePct = deposit.relayerFeePct.add(1);
      let newMessage = "0x1234";
      const newRecipient = randomAddress();
      let { signature } = await modifyRelayHelper(
        newRelayerFeePct,
        deposit.depositId.toString(),
        deposit.originChainId.toString(),
        depositor,
        newRecipient,
        newMessage
      );

      await spokePool_1.speedUpDeposit(
        depositor.address,
        newRelayerFeePct,
        deposit.depositId,
        newRecipient,
        newMessage,
        signature
      );

      await updateAllClients();
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(spy.getCalls().find(({ lastArg }) => lastArg.message.includes("Skipping fill for deposit with message")))
        .to.not.be.undefined;
      expect(multiCallerClient.transactionCount()).to.equal(0);

      // Deposit is updated again with a nullified message.
      newRelayerFeePct = newRelayerFeePct.add(1);
      newMessage = "0x";
      ({ signature } = await modifyRelayHelper(
        newRelayerFeePct,
        deposit.depositId.toString(),
        deposit.originChainId.toString(),
        depositor,
        newRecipient,
        newMessage
      ));

      await spokePool_1.speedUpDeposit(
        depositor.address,
        newRelayerFeePct,
        deposit.depositId,
        newRecipient,
        newMessage,
        signature
      );

      await updateAllClients();
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(lastSpyLogIncludes(spy, "Filling deposit")).to.be.true;
      expect(multiCallerClient.transactionCount()).to.equal(1);
    });

    it("Shouldn't double fill a deposit", async function () {
      await depositV2(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

      await updateAllClients();
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(lastSpyLogIncludes(spy, "Filling deposit")).to.be.true;
      expect(multiCallerClient.transactionCount()).to.equal(1); // One transaction, filling the one deposit.

      // The first fill is still pending but if we rerun the relayer loop, it shouldn't try to fill a second time.
      await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(multiCallerClient.transactionCount()).to.equal(0); // no new transactions were enqueued.
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
      await depositV2(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
      await updateAllClients();
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(
        spy.getCalls().find(({ lastArg }) => lastArg.message.includes("Skipping deposit from or to disabled chains"))
      ).to.not.be.undefined;
    });
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
      const fills = spokePoolClient_2
        .getFillsForOriginChain(deposit.originChainId)
        .filter(sdkUtils.isV3Fill<V3FillWithBlock, V2FillWithBlock>);
      expect(fills.length).to.equal(1);
      const fill = fills.at(-1)!;

      expect(getV3RelayHash(fill, fill.destinationChainId)).to.equal(
        getV3RelayHash(deposit, deposit.destinationChainId)
      );

      // Re-run the execution loop and validate that no additional relays are sent.
      multiCallerClient.clearTransactionQueue();
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(multiCallerClient.transactionCount()).to.equal(0); // no Transactions to send.
      expect(lastSpyLogIncludes(spy, "0 unfilled deposits")).to.be.true;
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
      const currentTime = (await spokePool_2.getCurrentTime()).toNumber();
      const fillDeadline = currentTime + 1;
      expect(fillDeadline > getCurrentTime()).to.be.true; // Sanity check

      await depositV3(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount, {
        fillDeadline,
      });
      await updateAllClients();

      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(multiCallerClient.transactionCount()).to.equal(1);
      multiCallerClient.clearTransactionQueue();

      await waitForHostTime(fillDeadline);

      expect(multiCallerClient.transactionCount()).to.equal(0);
      await relayerInstance.checkForUnfilledDepositsAndFill();
      expect(multiCallerClient.transactionCount()).to.equal(0);
    });

    it("Ignores exclusive deposits", async function () {
      const currentTime = (await spokePool_2.getCurrentTime()).toNumber();
      const exclusivityDeadline = currentTime + 1;
      expect(exclusivityDeadline > getCurrentTime()).to.be.true; // Sanity check

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
        const relayerIsExclusive = relayerInstance.relayerAddress === exclusiveRelayer;

        await updateAllClients();

        await relayerInstance.checkForUnfilledDepositsAndFill();
        expect(multiCallerClient.transactionCount()).to.equal(relayerIsExclusive ? 1 : 0);

        if (relayerIsExclusive) {
          continue;
        }

        multiCallerClient.clearTransactionQueue();
        await waitForHostTime(exclusivityDeadline);

        // Relayer can unconditionally fill after the exclusivityDeadline.
        expect(multiCallerClient.transactionCount()).to.equal(0);
        await relayerInstance.checkForUnfilledDepositsAndFill();
        expect(multiCallerClient.transactionCount()).to.equal(1);
      }
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
      expect(lastSpyLogIncludes(spy, "0 unfilled deposits")).to.be.true;
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
        const signature = await getUpdatedV3DepositSignature(
          depositor,
          deposit.depositId,
          originChainId,
          update.outputAmount,
          update.recipient,
          update.message
        );

        await spokePool_1
          .connect(depositor)
          .speedUpV3Deposit(
            depositor.address,
            deposit.depositId,
            update.outputAmount,
            update.recipient,
            update.message,
            signature
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
          const fills = spokePoolClient_2
            .getFillsForRelayer(relayer.address)
            .filter(sdkUtils.isV3Fill<V3FillWithBlock, V2FillWithBlock>);
          expect(fills.length).to.equal(1);
          const fill = fills.at(-1)!;

          expect(sdkUtils.isV3Fill(fill)).to.be.true;
          expect(getV3RelayHash(fill, fill.destinationChainId)).to.equal(
            getV3RelayHash(deposit, deposit.destinationChainId)
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
  });
});
