import {
  createSpyLogger,
  deployAndConfigureHubPool,
  enableRoutesOnHubPool,
  buildDepositStruct,
  signForSpeedUp,
  lastSpyLogIncludes,
} from "./utils";
import {
  deploySpokePoolWithToken,
  destinationChainId,
  deployConfigStore,
  getLastBlockTime,
  expect,
  toBNWei,
} from "./utils";
import { simpleDeposit, fillRelay, ethers, Contract, SignerWithAddress, setupTokensForWallet } from "./utils";
import { amountToLp, originChainId, amountToRelay, defaultMinDepositConfirmations } from "./constants";
import {
  SpokePoolClient,
  HubPoolClient,
  AcrossConfigStoreClient,
  ProfitClient,
  MultiCallerClient,
  TokenClient,
} from "../src/clients";
import { MockInventoryClient } from "./mocks";

// Tested
import { Relayer } from "../src/relayer/Relayer";
import { getUnfilledDeposits, toBN } from "../src/utils";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import { BigNumber } from "ethers";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let hubPool: Contract, l1Token: Contract, configStore: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;

const { spy, spyLogger } = createSpyLogger();
let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let configStoreClient: AcrossConfigStoreClient, hubPoolClient: HubPoolClient;
let multiCallerClient: MultiCallerClient, tokenClient: TokenClient;

let relayerInstance: Relayer;

describe("Relayer: Unfilled Deposits", async function () {
  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    // Deploy the two spokePools and their associated tokens. Set the chainId to match to associated chainIds. The first
    // prop is the chainId set on the spoke pool. The second prop is the chain ID enabled in the route on the spokePool.
    ({ spokePool: spokePool_1, erc20: erc20_1 } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({ spokePool: spokePool_2, erc20: erc20_2 } = await deploySpokePoolWithToken(destinationChainId, originChainId));
    ({ hubPool, l1Token_1: l1Token } = await deployAndConfigureHubPool(owner, [
      { l2ChainId: originChainId, spokePool: spokePool_1 },
      { l2ChainId: destinationChainId, spokePool: spokePool_2 },
    ]));

    ({ configStore } = await deployConfigStore(owner, [l1Token]));
    hubPoolClient = new HubPoolClient(spyLogger, hubPool);
    configStoreClient = new AcrossConfigStoreClient(spyLogger, configStore, hubPoolClient);
    spokePoolClient_1 = new SpokePoolClient(spyLogger, spokePool_1, configStoreClient, originChainId);
    spokePoolClient_2 = new SpokePoolClient(
      spyLogger,
      spokePool_2,
      configStoreClient,
      destinationChainId,
      { fromBlock: 0, toBlock: null, maxBlockLookBack: 0 },
      0
    );

    const spokePoolClients = { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 };
    multiCallerClient = new MultiCallerClient(spyLogger);
    tokenClient = new TokenClient(spyLogger, relayer.address, spokePoolClients, hubPoolClient);
    relayerInstance = new Relayer(
      relayer.address,
      spyLogger,
      {
        spokePoolClients,
        hubPoolClient,
        configStoreClient,
        profitClient: new ProfitClient(spyLogger, hubPoolClient, spokePoolClients, true, []),
        tokenClient,
        multiCallerClient,
        inventoryClient: new MockInventoryClient(),
      },
      {
        relayerTokens: [],
        relayerDestinationChains: [],
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

    await updateAllClients();

    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    await spokePool_2.setCurrentTime(await getLastBlockTime(spokePool_2.provider));
  });

  it("Correctly fetches unfilled deposits", async function () {
    expect(true).to.equal(true);
    const deposit1 = await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    const deposit2 = await simpleDeposit(spokePool_2, erc20_2, depositor, depositor, originChainId);
    await updateAllClients();
    const deposit1Complete = await buildDepositStruct(deposit1, hubPoolClient, configStoreClient, l1Token);
    const deposit2Complete = await buildDepositStruct(deposit2, hubPoolClient, configStoreClient, l1Token);

    expect(getUnfilledDeposits(relayerInstance.clients.spokePoolClients))
      .excludingEvery(["blockNumber", "originBlockNumber"])
      .to.deep.equal([
        { unfilledAmount: deposit1.amount, deposit: deposit1Complete, fillCount: 0, invalidFills: [] },
        { unfilledAmount: deposit2.amount, deposit: deposit2Complete, fillCount: 0, invalidFills: [] },
      ]);
  });

  it("Correctly fetches partially filled deposits", async function () {
    expect(true).to.equal(true);

    const deposit1 = await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    const deposit2 = await simpleDeposit(spokePool_2, erc20_2, depositor, depositor, originChainId);

    // Partially fill the first deposit, which is sent to the second spoke pool, with one fill.
    const deposit1Complete = await buildDepositStruct(deposit1, hubPoolClient, configStoreClient, l1Token);
    const deposit2Complete = await buildDepositStruct(deposit2, hubPoolClient, configStoreClient, l1Token);

    const fill1 = await fillWithRealizedLpFeePct(spokePool_2, relayer, depositor, deposit1Complete);
    await updateAllClients();
    // Validate the relayer correctly computes the unfilled amount.
    expect(getUnfilledDeposits(relayerInstance.clients.spokePoolClients))
      .excludingEvery(["blockNumber", "originBlockNumber"])
      .to.deep.equal([
        {
          unfilledAmount: deposit1.amount.sub(fill1.fillAmount),
          deposit: deposit1Complete,
          fillCount: 1,
          invalidFills: [],
        },
        { unfilledAmount: deposit2.amount, deposit: deposit2Complete, fillCount: 0, invalidFills: [] },
      ]);

    // Partially fill the same deposit another two times.
    const fill2 = await fillWithRealizedLpFeePct(spokePool_2, relayer, depositor, deposit1Complete);
    const fill3 = await fillWithRealizedLpFeePct(spokePool_2, relayer, depositor, deposit1Complete);
    await updateAllClients();
    // Deposit 1 should now be partially filled by all three fills. This should be correctly reflected.
    const unfilledAmount = deposit1.amount.sub(fill1.fillAmount.add(fill2.fillAmount).add(fill3.fillAmount));
    expect(getUnfilledDeposits(relayerInstance.clients.spokePoolClients))
      .excludingEvery(["blockNumber", "originBlockNumber"])
      .to.deep.equal([
        { unfilledAmount: unfilledAmount, deposit: deposit1Complete, fillCount: 3, invalidFills: [] },
        { unfilledAmount: deposit2.amount, deposit: deposit2Complete, fillCount: 0, invalidFills: [] },
      ]);

    // Fill the reminding amount on the deposit. It should thus be removed from the unfilledDeposits list.
    const fill4 = await fillWithRealizedLpFeePct(spokePool_2, relayer, depositor, deposit1Complete, unfilledAmount);
    expect(fill4.totalFilledAmount).to.equal(deposit1.amount); // should be 100% filled at this point.
    await updateAllClients();
    expect(getUnfilledDeposits(relayerInstance.clients.spokePoolClients))
      .excludingEvery(["blockNumber", "originBlockNumber"])
      .to.deep.equal([
        { unfilledAmount: deposit2Complete.amount, deposit: deposit2Complete, fillCount: 0, invalidFills: [] },
      ]);
  });

  it("Correctly excludes fills that are incorrectly applied to a deposit", async function () {
    expect(true).to.equal(true);
    const deposit1 = await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    const deposit1Complete = await buildDepositStruct(deposit1, hubPoolClient, configStoreClient, l1Token);

    // Partially fill the deposit, incorrectly by setting the wrong deposit ID.
    await fillWithRealizedLpFeePct(spokePool_2, relayer, depositor, { ...deposit1Complete, depositId: 1337 });
    await updateAllClients();
    // The deposit should show up as unfilled, since the fill was incorrectly applied to the wrong deposit.
    expect(getUnfilledDeposits(relayerInstance.clients.spokePoolClients))
      .excludingEvery(["blockNumber", "originBlockNumber"])
      .to.deep.equal([
        { unfilledAmount: deposit1Complete.amount, deposit: deposit1Complete, fillCount: 0, invalidFills: [] },
      ]);
  });

  it("Correctly selects unfilled deposit with updated fee", async function () {
    // perform simple deposit
    const deposit1 = await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await updateAllClients();

    // update fee before deposit filled
    const newRelayFeePct = toBNWei(0.1337);
    const speedUpSignature = await signForSpeedUp(depositor, deposit1, newRelayFeePct);
    await spokePool_1.speedUpDeposit(depositor.address, newRelayFeePct, deposit1.depositId, speedUpSignature);
    await updateAllClients();

    const unfilledDeposits = getUnfilledDeposits(relayerInstance.clients.spokePoolClients);
    // expect only one unfilled deposit
    expect(unfilledDeposits.length).to.eq(1);
    // expect unfilled deposit to have new relay fee
    expect(unfilledDeposits[0].deposit.newRelayerFeePct).to.deep.eq(newRelayFeePct);
    // Old relayer fee pct is unchanged as this is what's included in relay hash
    expect(unfilledDeposits[0].deposit.relayerFeePct).to.deep.eq(deposit1.relayerFeePct);
  });

  it("Does not double fill deposit when updating fee after fill", async function () {
    const deposit1 = await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    const deposit1Complete = await buildDepositStruct(deposit1, hubPoolClient, configStoreClient, l1Token);
    const fill1 = await fillWithRealizedLpFeePct(spokePool_2, relayer, depositor, deposit1Complete);
    await updateAllClients();
    expect(getUnfilledDeposits(relayerInstance.clients.spokePoolClients))
      .excludingEvery(["blockNumber", "originBlockNumber"])
      .to.deep.equal([
        {
          unfilledAmount: deposit1.amount.sub(fill1.fillAmount),
          deposit: deposit1Complete,
          fillCount: 1,
          invalidFills: [],
        },
      ]);

    // Speed up deposit, and check that unfilled amount is still the same.
    const newRelayerFeePct = toBNWei(0.1337);
    const speedUpSignature = await signForSpeedUp(depositor, deposit1, newRelayerFeePct);
    await spokePool_1.speedUpDeposit(depositor.address, newRelayerFeePct, deposit1.depositId, speedUpSignature);
    await updateAllClients();
    const depositWithSpeedUp = { ...deposit1Complete, newRelayerFeePct, speedUpSignature };
    expect(getUnfilledDeposits(relayerInstance.clients.spokePoolClients))
      .excludingEvery(["blockNumber", "originBlockNumber"])
      .to.deep.equal([
        {
          unfilledAmount: deposit1.amount.sub(fill1.fillAmount),
          deposit: depositWithSpeedUp,
          fillCount: 1,
          invalidFills: [],
        },
      ]);
  });

  it("Skip invalid fills from the same relayer", async function () {
    const deposit = await simpleDeposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    const depositComplete = await buildDepositStruct(deposit, hubPoolClient, configStoreClient, l1Token);
    // Send a fill with a different relayer fee pct from the deposit's. This fill should be considered an invalid fill
    // and getUnfilledDeposits should log it.
    const fill = await fillWithRealizedLpFeePct(
      spokePool_2,
      relayer,
      depositor,
      depositComplete,
      amountToRelay,
      toBN(2)
    );
    await updateAllClients();

    // getUnfilledDeposit still returns the deposit as unfilled but with the invalid fill.
    const unfilledDeposit = getUnfilledDeposits(relayerInstance.clients.spokePoolClients)[0];
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
});

async function updateAllClients() {
  await hubPoolClient.update();
  await configStoreClient.update();
  await tokenClient.update();
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
}

async function fillWithRealizedLpFeePct(
  spokePool,
  relayer,
  depositor,
  deposit,
  relayAmount = amountToRelay,
  relayerFeePct: BigNumber = undefined
) {
  const realizedLpFeePctForDeposit = (await configStoreClient.computeRealizedLpFeePct(deposit, l1Token.address))
    .realizedLpFeePct;
  return await fillRelay(
    spokePool,
    deposit.destinationToken,
    depositor,
    depositor,
    relayer,
    deposit.depositId,
    deposit.originChainId,
    deposit.amount,
    relayAmount,
    realizedLpFeePctForDeposit,
    relayerFeePct
  );
}
