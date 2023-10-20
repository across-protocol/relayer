import { random } from "lodash";
import { AcrossApiClient, ConfigStoreClient, MultiCallerClient, TokenClient } from "../src/clients";
import { CONFIG_STORE_VERSION, UBA_MIN_CONFIG_STORE_VERSION } from "../src/common";
import { Deposit } from "../src/interfaces";
import { Relayer } from "../src/relayer/Relayer";
import { RelayerConfig } from "../src/relayer/RelayerConfig"; // Tested
import {
  amountToLp,
  defaultMinDepositConfirmations,
  defaultTokenConfig,
  modifyRelayHelper,
  randomAddress,
  repaymentChainId,
  utf8ToHex,
} from "./constants";
import { MockConfigStoreClient, MockInventoryClient, MockProfitClient, MockUBAClient } from "./mocks";
import { MockedMultiCallerClient } from "./mocks/MockMultiCallerClient";
import {
  Contract,
  SignerWithAddress,
  buildDeposit,
  createSpyLogger,
  deployAndConfigureHubPool,
  deployConfigStore,
  deploySpokePoolWithToken,
  deposit,
  destinationChainId,
  enableRoutesOnHubPool,
  ethers,
  expect,
  getLastBlockTime,
  lastSpyLogIncludes,
  spyLogIncludes,
  originChainId,
  setupTokensForWallet,
  sinon,
  toBNWei,
  winston,
} from "./utils";
import { generateNoOpSpokePoolClientsForDefaultChainIndices } from "./utils/UBAUtils";
import { clients, utils as sdkUtils } from "@across-protocol/sdk-v2";

const { bnOne } = sdkUtils;

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
let ubaClient: MockUBAClient;

describe("Relayer: Check for Unfilled Deposits and Fill", async function () {
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

    ubaClient = new MockUBAClient(
      hubPoolClient.getL1Tokens().map((x) => x.symbol),
      hubPoolClient,
      generateNoOpSpokePoolClientsForDefaultChainIndices(spokePoolClients)
    );
    tokenClient = new TokenClient(spyLogger, relayer.address, spokePoolClients, hubPoolClient);
    profitClient = new MockProfitClient(spyLogger, hubPoolClient, spokePoolClients, []);
    profitClient.setTokenPrice(l1Token.address, bnOne);

    relayerInstance = new Relayer(
      relayer.address,
      spyLogger,
      {
        spokePoolClients,
        hubPoolClient,
        configStoreClient,
        ubaClient,
        tokenClient,
        profitClient,
        multiCallerClient,
        inventoryClient: new MockInventoryClient(),
        acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, spokePoolClients),
      },
      {
        relayerTokens: [],
        minDepositConfirmations: defaultMinDepositConfirmations,
        quoteTimeBuffer: 0,
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

  it("Correctly fetches single unfilled deposit and fills it", async function () {
    const deposit1 = await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

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
    expect(lastSpyLogIncludes(spy, "No unfilled deposits")).to.be.true;
  });

  it("Ignores deposits older than min deposit confirmation threshold", async function () {
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

    // Set MDC such that the deposit is is ignored. The profit client will return a fill USD amount of $0,
    // so we need to set the MDC for the `0` threshold to be large enough such that the deposit would be ignored.
    relayerInstance = new Relayer(
      relayer.address,
      spyLogger,
      {
        spokePoolClients,
        hubPoolClient,
        configStoreClient,
        ubaClient,
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
        quoteTimeBuffer: 0,
        sendingRelaysEnabled: false,
      } as unknown as RelayerConfig
    );

    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(lastSpyLogIncludes(spy, "No unfilled deposits")).to.be.true;
  });

  it("Ignores deposits with quote times in future", async function () {
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

    // Set a non-zero quote time buffer, so that deposit quote time + buffer is > latest timestamp in
    // the HubPool.
    relayerInstance = new Relayer(
      relayer.address,
      spyLogger,
      {
        spokePoolClients,
        hubPoolClient,
        configStoreClient,
        ubaClient,
        tokenClient,
        profitClient,
        multiCallerClient,
        inventoryClient: new MockInventoryClient(),
        acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, spokePoolClients),
      },
      {
        relayerTokens: [],
        minDepositConfirmations: defaultMinDepositConfirmations,
        quoteTimeBuffer: 100,
        sendingRelaysEnabled: false,
      } as unknown as RelayerConfig
    );

    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(lastSpyLogIncludes(spy, "No unfilled deposits")).to.be.true;
  });

  it("Ignores deposit with non-empty message", async function () {
    await buildDeposit(
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token,
      depositor,
      destinationChainId,
      undefined, // amount
      undefined, // relayerFeePct
      undefined, // quoteTimestamp,
      "0x0000" // message
    );

    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(lastSpyLogIncludes(spy, "Skipping fill for deposit with message")).to.be.true;
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
    expect(lastSpyLogIncludes(spy, "Skipping fill for deposit with message")).to.be.true;
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
    expect(lastSpyLogIncludes(spy, "No unfilled deposits")).to.be.true;
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
    expect(lastSpyLogIncludes(spy, "Skipping fill for deposit with message")).to.be.true;
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
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

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
        ubaClient,
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
        quoteTimeBuffer: 0,
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
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(spyLogIncludes(spy, -3, "Skipping 1 deposits from or to disabled chains.")).to.be.true;
  });

  it("UBA: Doesn't crash if client cannot support version bump", async function () {
    // Client is out of sync with on chain version, should crash.
    await configStore.updateGlobalConfig(utf8ToHex("VERSION"), `${UBA_MIN_CONFIG_STORE_VERSION ?? 2}`);

    // "reasonable" block number based off the block time when looking at quote timestamps.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

    await updateAllClients();
  });

  it("UBA: Uses UBA fee model after version bump", async function () {
    const version = UBA_MIN_CONFIG_STORE_VERSION;
    configStoreClient = new ConfigStoreClient(spyLogger, configStore, { fromBlock: 0 }, version);
    await configStoreClient.update();
    hubPoolClient = new clients.HubPoolClient(
      spyLogger,
      hubPool,
      configStoreClient as unknown as clients.AcrossConfigStoreClient
    );
    relayerInstance = new Relayer(
      relayer.address,
      spyLogger,
      {
        configStoreClient,
        hubPoolClient,
        spokePoolClients,
        ubaClient,
        tokenClient,
        profitClient,
        multiCallerClient,
        inventoryClient: new MockInventoryClient(),
        acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, spokePoolClients),
      },
      {
        relayerTokens: [],
        relayerDestinationChains: [originChainId, destinationChainId],
        minDepositConfirmations: defaultMinDepositConfirmations,
        quoteTimeBuffer: 0,
      } as unknown as RelayerConfig
    );
    await configStore.updateGlobalConfig(utf8ToHex("VERSION"), `${UBA_MIN_CONFIG_STORE_VERSION ?? 2}`);
    await updateAllClients();

    // "reasonable" block number based off the block time when looking at quote timestamps.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    const deposit1 = await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await updateAllClients();

    // In UBA Mode, realized Lp fee is not set during update(), so we need to manually overwrite it.
    const ubaRealizedLpFeePct = toBNWei("0.1");
    spokePoolClient_1.updateDepositRealizedLpFeePct(deposit1 as Deposit, ubaRealizedLpFeePct);

    // Set the deposit balancing fee.
    const expectedBalancingFeePct = toBNWei(random(0, 0.249999).toPrecision(9));
    const expectedLpFeePct = toBNWei(random(0, 0.249999).toPrecision(9));
    const expectedSystemFeePct = expectedBalancingFeePct.add(expectedLpFeePct);
    ubaClient.setBalancingFee(originChainId, expectedBalancingFeePct);
    ubaClient.setLpFee(originChainId, expectedLpFeePct);

    // Fish the DepositWithBlock directly out of the SpokePoolClient;
    // confirm that the realizedLpFeePct is _not_ the UBA systemFee.
    const _deposit = spokePoolClients[originChainId].getDepositsForDestinationChain(destinationChainId)[0];
    expect(_deposit.depositId).to.eq(deposit1?.depositId);
    expect(_deposit.realizedLpFeePct.gt(0)).to.be.true;
    expect(_deposit.realizedLpFeePct.eq(expectedSystemFeePct)).to.be.false;

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
    expect(fillEvents2[0].args.realizedLpFeePct).to.equal(expectedSystemFeePct);

    // There should be no fill events on the origin spoke pool.
    expect((await spokePool_1.queryFilter(spokePool_1.filters.FilledRelay())).length).to.equal(0);

    // Re-run the execution loop and validate that no additional relays are sent.
    multiCallerClient.clearTransactionQueue();
    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(multiCallerClient.transactionCount()).to.equal(0); // no Transactions to send.
    expect(lastSpyLogIncludes(spy, "No unfilled deposits")).to.be.true;
  });

  it("UBA: Skips pre UBA deposits", async function () {
    // In this test we activate the UBA version in the config store but the relayer doesn't have the required version.
    await configStore.updateGlobalConfig(utf8ToHex("VERSION"), `${UBA_MIN_CONFIG_STORE_VERSION ?? 2}`);
    await updateAllClients();

    // "reasonable" block number based off the block time when looking at quote timestamps.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await updateAllClients();

    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(lastSpyLogIncludes(spy, "No unfilled deposits")).to.be.true;
  });
});

async function updateAllClients() {
  await configStoreClient.update();
  await hubPoolClient.update();
  await tokenClient.update();
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
}
