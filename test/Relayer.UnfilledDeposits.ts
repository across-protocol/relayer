import { AcrossApiClient, ConfigStoreClient, MultiCallerClient, TokenClient, UBAClient } from "../src/clients";
import {
  CHAIN_ID_TEST_LIST,
  amountToLp,
  defaultMinDepositConfirmations,
  modifyRelayHelper,
  originChainId,
  repaymentChainId,
} from "./constants";
import { MockInventoryClient, MockProfitClient, MockConfigStoreClient, MockedMultiCallerClient } from "./mocks";
import {
  Contract,
  SignerWithAddress,
  buildDepositStruct,
  buildFill,
  createSpyLogger,
  deployAndConfigureHubPool,
  deployConfigStore,
  deploySpokePoolWithToken,
  destinationChainId,
  enableRoutesOnHubPool,
  ethers,
  expect,
  getLastBlockTime,
  lastSpyLogIncludes,
  setupTokensForWallet,
  simpleDeposit,
  toBNWei,
} from "./utils";
import { clients } from "@across-protocol/sdk-v2";

// Tested
import { Relayer } from "../src/relayer/Relayer";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import { RelayerUnfilledDeposit, getUnfilledDeposits, toBN, utf8ToHex } from "../src/utils";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let hubPool: Contract, l1Token: Contract, configStore: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;

const { spy, spyLogger } = createSpyLogger();
let spokePoolClient_1: clients.SpokePoolClient, spokePoolClient_2: clients.SpokePoolClient;
let configStoreClient: MockConfigStoreClient, hubPoolClient: clients.HubPoolClient;
let multiCallerClient: MultiCallerClient, tokenClient: TokenClient;
let profitClient: MockProfitClient;
let spokePool1DeploymentBlock: number, spokePool2DeploymentBlock: number;

let relayerInstance: Relayer;
let unfilledDeposits: RelayerUnfilledDeposit[] = [];

let _getUnfilledDeposits: () => Promise<RelayerUnfilledDeposit[]>;

describe("Relayer: Unfilled Deposits", async function () {
  const sortableEventFields = [
    "blockNumber",
    "blockTimestamp",
    "quoteBlockNumber",
    "logIndex",
    "transactionIndex",
    "transactionHash",
  ];

  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    // Deploy the two spokePools and their associated tokens. Set the chainId to match to associated chainIds. The first
    // prop is the chainId set on the spoke pool. The second prop is the chain ID enabled in the route on the spokePool.
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
      { l2ChainId: originChainId, spokePool: spokePool_1 },
      { l2ChainId: destinationChainId, spokePool: spokePool_2 },
      { l2ChainId: repaymentChainId, spokePool: spokePool_2 },
      { l2ChainId: 1, spokePool: spokePool_2 },
    ]));

    ({ configStore } = await deployConfigStore(owner, [l1Token]));

    configStoreClient = new MockConfigStoreClient(spyLogger, configStore, undefined, undefined, CHAIN_ID_TEST_LIST);
    await configStoreClient.update();

    hubPoolClient = new clients.HubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    spokePoolClient_1 = new clients.SpokePoolClient(
      spyLogger,
      spokePool_1,
      hubPoolClient,
      originChainId,
      spokePool1DeploymentBlock
    );
    spokePoolClient_2 = new clients.SpokePoolClient(
      spyLogger,
      spokePool_2,
      hubPoolClient,
      destinationChainId,
      spokePool2DeploymentBlock,
      { fromBlock: 0, toBlock: null, maxBlockLookBack: 0 }
    );

    const spokePoolClients = { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 };
    multiCallerClient = new MockedMultiCallerClient(spyLogger);
    tokenClient = new TokenClient(spyLogger, relayer.address, spokePoolClients, hubPoolClient);
    profitClient = new MockProfitClient(spyLogger, hubPoolClient, spokePoolClients, []);
    profitClient.testInit();
    relayerInstance = new Relayer(
      relayer.address,
      spyLogger,
      {
        spokePoolClients,
        hubPoolClient,
        configStoreClient: configStoreClient as unknown as ConfigStoreClient,
        profitClient,
        tokenClient,
        multiCallerClient,
        inventoryClient: new MockInventoryClient(),
        acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, spokePoolClients),
        ubaClient: {} as unknown as UBAClient, // We don't need this for this test.
      },
      {
        relayerTokens: [],
        relayerDestinationChains: [],
        quoteTimeBuffer: 0,
        minDepositConfirmations: defaultMinDepositConfirmations,
        acceptInvalidFills: false,
      } as unknown as RelayerConfig
    );

    await setupTokensForWallet(spokePool_1, owner, [l1Token], null, 100); // seed the owner to LP.
    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], null, 100); // seed the depositor to LP.
    await setupTokensForWallet(spokePool_2, depositor, [erc20_2], null, 10);
    await setupTokensForWallet(spokePool_1, relayer, [erc20_1], null, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_2], null, 10);

    // Approve and add liquidity.
    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token, destinationToken: erc20_1 },
      { destinationChainId: destinationChainId, l1Token, destinationToken: erc20_2 },
    ]);
    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);

    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    await spokePool_2.setCurrentTime(await getLastBlockTime(spokePool_2.provider));
    await updateAllClients();

    _getUnfilledDeposits = async (): Promise<RelayerUnfilledDeposit[]> => {
      return await getUnfilledDeposits(relayerInstance.clients.spokePoolClients, hubPoolClient);
    };
    unfilledDeposits = [];
  });

  it("Correctly fetches unfilled deposits", async function () {
    expect(true).to.equal(true);
    const deposit1 = await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    const deposit2 = await simpleDeposit(spokePool_2, erc20_2, depositor, depositor, originChainId);
    await updateAllClients();
    const deposit1Complete = await buildDepositStruct(deposit1, hubPoolClient, l1Token);
    const deposit2Complete = await buildDepositStruct(deposit2, hubPoolClient, l1Token);

    unfilledDeposits = await _getUnfilledDeposits();
    expect(unfilledDeposits)
      .excludingEvery(sortableEventFields)
      .to.deep.equal([
        {
          unfilledAmount: deposit1.amount,
          deposit: deposit1Complete,
          fillCount: 0,
          invalidFills: [],
          version: configStoreClient.configStoreVersion,
        },
        {
          unfilledAmount: deposit2.amount,
          deposit: deposit2Complete,
          fillCount: 0,
          invalidFills: [],
          version: configStoreClient.configStoreVersion,
        },
      ]);
  });

  it("Correctly defers deposits with future quote timestamps", async function () {
    const delta = await spokePool_1.depositQuoteTimeBuffer(); // seconds

    const deposit1 = await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

    await spokePool_1.setCurrentTime(deposit1.quoteTimestamp + delta);
    const deposit2 = await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

    // One deposit is eligible.
    await spokePool_1.setCurrentTime(deposit1.quoteTimestamp);
    await updateAllClients();

    unfilledDeposits = await _getUnfilledDeposits();
    expect(unfilledDeposits.length).to.eq(1);
    expect(unfilledDeposits[0].deposit.depositId).to.equal(deposit1.depositId);

    // Still only one deposit.
    await spokePool_1.setCurrentTime(deposit2.quoteTimestamp - 1);
    await updateAllClients();

    unfilledDeposits = await _getUnfilledDeposits();
    expect(unfilledDeposits.length).to.equal(1);
    expect(unfilledDeposits[0].deposit.depositId).to.equal(deposit1.depositId);

    // Step slightly beyond the future quoteTimestamp; now both deposits are eligible.
    await spokePool_1.setCurrentTime(deposit2.quoteTimestamp);
    await updateAllClients();

    unfilledDeposits = await _getUnfilledDeposits();
    expect(unfilledDeposits.length).to.equal(2);
    expect(unfilledDeposits[0].deposit.depositId).to.equal(deposit1.depositId);
    expect(unfilledDeposits[1].deposit.depositId).to.equal(deposit2.depositId);
  });

  it("Correctly fetches partially filled deposits", async function () {
    expect(true).to.equal(true);

    const deposit1 = await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    const deposit2 = await simpleDeposit(spokePool_2, erc20_2, depositor, depositor, originChainId);

    // Partially fill the first deposit, which is sent to the second spoke pool, with one fill.
    const deposit1Complete = await buildDepositStruct(deposit1, hubPoolClient, l1Token);
    const deposit2Complete = await buildDepositStruct(deposit2, hubPoolClient, l1Token);

    const fill1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1Complete, 0.25);
    await updateAllClients();

    // Validate the relayer correctly computes the unfilled amount.
    unfilledDeposits = await _getUnfilledDeposits();
    expect(unfilledDeposits)
      .excludingEvery(sortableEventFields)
      .to.deep.equal([
        {
          unfilledAmount: deposit1.amount.sub(fill1.fillAmount),
          deposit: deposit1Complete,
          fillCount: 1,
          invalidFills: [],
          version: configStoreClient.configStoreVersion,
        },
        {
          unfilledAmount: deposit2.amount,
          deposit: deposit2Complete,
          fillCount: 0,
          invalidFills: [],
          version: configStoreClient.configStoreVersion,
        },
      ]);

    // Partially fill the same deposit another two times.
    const fill2 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1Complete, 0.25);
    const fill3 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1Complete, 0.25);
    await updateAllClients();
    // Deposit 1 should now be partially filled by all three fills. This should be correctly reflected.
    const unfilledAmount = deposit1.amount.sub(fill1.fillAmount.add(fill2.fillAmount).add(fill3.fillAmount));

    unfilledDeposits = await _getUnfilledDeposits();
    expect(unfilledDeposits)
      .excludingEvery(sortableEventFields)
      .to.deep.equal([
        {
          unfilledAmount: unfilledAmount,
          deposit: deposit1Complete,
          fillCount: 3,
          invalidFills: [],
          version: configStoreClient.configStoreVersion,
        },
        {
          unfilledAmount: deposit2.amount,
          deposit: deposit2Complete,
          fillCount: 0,
          invalidFills: [],
          version: configStoreClient.configStoreVersion,
        },
      ]);

    // Fill the reminding amount on the deposit. It should thus be removed from the unfilledDeposits list.
    const fill4 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1Complete, 1);
    expect(fill4.totalFilledAmount).to.equal(deposit1.amount); // should be 100% filled at this point.
    await updateAllClients();

    unfilledDeposits = await _getUnfilledDeposits();
    expect(unfilledDeposits)
      .excludingEvery(sortableEventFields)
      .to.deep.equal([
        {
          unfilledAmount: deposit2Complete.amount,
          deposit: deposit2Complete,
          fillCount: 0,
          invalidFills: [],
          version: configStoreClient.configStoreVersion,
        },
      ]);
  });

  it("Correctly excludes fills that are incorrectly applied to a deposit", async function () {
    expect(true).to.equal(true);
    const deposit1 = await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    const deposit1Complete = await buildDepositStruct(deposit1, hubPoolClient, l1Token);

    // Partially fill the deposit, incorrectly by setting the wrong deposit ID.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, { ...deposit1Complete, depositId: 1337 }, 0.25);
    await updateAllClients();

    // The deposit should show up as unfilled, since the fill was incorrectly applied to the wrong deposit.
    unfilledDeposits = await _getUnfilledDeposits();
    expect(unfilledDeposits)
      .excludingEvery(sortableEventFields)
      .to.deep.equal([
        {
          unfilledAmount: deposit1Complete.amount,
          deposit: deposit1Complete,
          fillCount: 0,
          invalidFills: [],
          version: configStoreClient.configStoreVersion,
        },
      ]);
  });

  it("Correctly selects unfilled deposit with updated fee", async function () {
    const delta = await spokePool_1.depositQuoteTimeBuffer(); // seconds

    // perform simple deposit
    const deposit1 = await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

    // Add an "early" deposit
    await spokePool_1.setCurrentTime(deposit1.quoteTimestamp + delta);
    const deposit2 = await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await spokePool_1.setCurrentTime(deposit1.quoteTimestamp);
    await updateAllClients();

    // update fee before either deposit is filled
    const newRelayFeePct = toBNWei(0.1337);
    for (const deposit of [deposit1, deposit2]) {
      const speedUpSignature = await modifyRelayHelper(
        newRelayFeePct,
        deposit.depositId.toString(),
        deposit.originChainId.toString(),
        depositor,
        deposit.recipient,
        "0x"
      );
      await spokePool_1.speedUpDeposit(
        depositor.address,
        newRelayFeePct,
        deposit.depositId,
        deposit.recipient,
        "0x",
        speedUpSignature.signature
      );
    }
    await spokePoolClient_1.update();

    unfilledDeposits = await _getUnfilledDeposits();
    // expect only one unfilled deposit
    expect(unfilledDeposits.length).to.eq(1);
    expect(unfilledDeposits[0].deposit.depositId).to.equal(deposit1.depositId);
    // expect unfilled deposit to have new relay fee
    expect(unfilledDeposits[0].deposit.newRelayerFeePct).to.deep.eq(newRelayFeePct);
    // Old relayer fee pct is unchanged as this is what's included in relay hash
    expect(unfilledDeposits[0].deposit.relayerFeePct).to.deep.eq(deposit1.relayerFeePct);

    // Cycle forward to the next deposit
    await spokePool_1.setCurrentTime(deposit2.quoteTimestamp);
    await updateAllClients();

    unfilledDeposits = await _getUnfilledDeposits();
    expect(unfilledDeposits.length).to.eq(2);
    expect(unfilledDeposits[1].deposit.depositId).to.equal(deposit2.depositId);
    // The new relayer fee was still applied to the early deposit.
    expect(unfilledDeposits[1].deposit.relayerFeePct).to.deep.eq(deposit2.relayerFeePct);
    expect(unfilledDeposits[1].deposit.newRelayerFeePct).to.deep.eq(newRelayFeePct);
  });

  it("Does not double fill deposit when updating fee after fill", async function () {
    const deposit1 = await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    const deposit1Complete = await buildDepositStruct(deposit1, hubPoolClient, l1Token);
    const fill1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1Complete, 0.25);
    await updateAllClients();

    unfilledDeposits = await _getUnfilledDeposits();
    expect(unfilledDeposits)
      .excludingEvery(sortableEventFields)
      .to.deep.equal([
        {
          unfilledAmount: deposit1.amount.sub(fill1.fillAmount),
          deposit: deposit1Complete,
          fillCount: 1,
          invalidFills: [],
          version: configStoreClient.configStoreVersion,
        },
      ]);

    // Speed up deposit, and check that unfilled amount is still the same.
    const newRelayerFeePct = toBNWei(0.1337);
    const speedUpSignature = await modifyRelayHelper(
      newRelayerFeePct,
      deposit1.depositId.toString(),
      deposit1.originChainId.toString(),
      depositor,
      deposit1.recipient,
      "0x"
    );
    await spokePool_1.speedUpDeposit(
      depositor.address,
      newRelayerFeePct,
      deposit1.depositId,
      deposit1.recipient,
      "0x",
      speedUpSignature.signature
    );
    await updateAllClients();
    const depositWithSpeedUp = {
      ...deposit1Complete,
      newRelayerFeePct,
      updatedRecipient: deposit1.recipient,
      updatedMessage: "0x",
      speedUpSignature: speedUpSignature.signature,
    };

    unfilledDeposits = await _getUnfilledDeposits();
    expect(unfilledDeposits)
      .excludingEvery(sortableEventFields)
      .to.deep.equal([
        {
          unfilledAmount: deposit1.amount.sub(fill1.fillAmount),
          deposit: depositWithSpeedUp,
          fillCount: 1,
          invalidFills: [],
          version: configStoreClient.configStoreVersion,
        },
      ]);
  });

  it("Skip invalid fills from the same relayer", async function () {
    const deposit = await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    const depositComplete = await buildDepositStruct(deposit, hubPoolClient, l1Token);
    // Send a fill with a different relayer fee pct from the deposit's. This fill should be considered an invalid fill
    // and getUnfilledDeposits should log it.
    const fill = await buildFill(
      spokePool_2,
      erc20_2,
      depositor,
      relayer,
      { ...depositComplete, relayerFeePct: toBN(2) },
      0.25
    );
    await updateAllClients();

    // getUnfilledDeposit still returns the deposit as unfilled but with the invalid fill.
    const unfilledDeposit = (await _getUnfilledDeposits())[0];
    expect(unfilledDeposit === undefined).to.be.false;
    expect(unfilledDeposit.unfilledAmount).to.equal(deposit.amount);
    expect(unfilledDeposit.deposit.depositId).to.equal(deposit.depositId);
    expect(unfilledDeposit.invalidFills.length).to.equal(1);
    expect(unfilledDeposit.invalidFills[0].amount).to.equal(toBN(fill.amount));
    expect(lastSpyLogIncludes(spy, "Invalid fills found")).to.be.true;

    await relayerInstance.checkForUnfilledDepositsAndFill();
    // Relayer shouldn't try to relay the fill even though it's unfilled as there has been one invalid fill from this
    // same relayer.

    expect(lastSpyLogIncludes(spy, "Skipping deposit with invalid fills from the same relayer")).to.be.true;
    expect(multiCallerClient.transactionCount()).to.equal(0);
  });

  it("Skip deposits we don't have updated config store version for", async function () {
    const highVersion = 1;
    // Set up test so that the latest version in the config store contract is higher than
    // the version in the config store client.
    const update = await configStore.updateGlobalConfig(utf8ToHex("VERSION"), `${highVersion}`);
    const updateTime = (await configStore.provider.getBlock(update.blockNumber)).timestamp;
    configStoreClient.setConfigStoreVersion(highVersion - 1);

    // Now send a deposit after the update time. This deposit should be skipped as we don't have the latest
    // version at the quote timestamp.
    await spokePool_1.setCurrentTime(updateTime + 1);
    await updateAllClients();
    await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await updateAllClients();

    let unfilledDeposits: RelayerUnfilledDeposit[];
    unfilledDeposits = await _getUnfilledDeposits();
    expect(unfilledDeposits.length).to.equal(1);
    expect(unfilledDeposits[0].version).to.equal(highVersion);

    // Relayer class should filter out based on its highest supported version.
    unfilledDeposits = await relayerInstance.getUnfilledDeposits();
    expect(unfilledDeposits.length).to.equal(0);

    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(multiCallerClient.transactionCount()).to.equal(0);
  });
});

async function updateAllClients() {
  await configStoreClient.update();
  await hubPoolClient.update();
  await tokenClient.update();
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
}
