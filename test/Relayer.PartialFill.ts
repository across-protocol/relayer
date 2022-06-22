import {
  expect,
  deposit,
  ethers,
  Contract,
  SignerWithAddress,
  setupTokensForWallet,
  getLastBlockTime,
  lastSpyLogIncludes,
} from "./utils";
import { createSpyLogger, deployConfigStore, deployAndConfigureHubPool, winston } from "./utils";
import { deploySpokePoolWithToken, enableRoutesOnHubPool, destinationChainId, spyLogIncludes } from "./utils";
import { originChainId, sinon, toBNWei } from "./utils";
import { amountToLp, defaultTokenConfig, amountToDeposit } from "./constants";
import { SpokePoolClient, HubPoolClient, AcrossConfigStoreClient, MultiCallerClient } from "../src/clients";
import { TokenClient, ProfitClient } from "../src/clients";
import { MockInventoryClient } from "./mocks";

import { Relayer } from "../src/relayer/Relayer"; // Tested
import { toBN } from "../src/utils";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let hubPool: Contract, configStore: Contract, l1Token: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
let spy: sinon.SinonSpy, spyLogger: winston.Logger;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let configStoreClient: AcrossConfigStoreClient, hubPoolClient: HubPoolClient, tokenClient: TokenClient;
let relayerInstance: Relayer;
let multiCallerClient: MultiCallerClient, profitClient: ProfitClient, inventoryClient: MockInventoryClient;

describe("Relayer: Partial fills", async function () {
  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    ({ spokePool: spokePool_1, erc20: erc20_1 } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({ spokePool: spokePool_2, erc20: erc20_2 } = await deploySpokePoolWithToken(destinationChainId, originChainId));
    ({ hubPool, l1Token_1: l1Token } = await deployAndConfigureHubPool(owner, [
      { l2ChainId: destinationChainId, spokePool: spokePool_2 },
    ]));

    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token, destinationToken: erc20_1 },
      { destinationChainId: destinationChainId, l1Token, destinationToken: erc20_2 },
    ]);

    ({ spy, spyLogger } = createSpyLogger());
    ({ configStore } = await deployConfigStore(owner, [l1Token]));
    hubPoolClient = new HubPoolClient(spyLogger, hubPool);
    configStoreClient = new AcrossConfigStoreClient(spyLogger, configStore, hubPoolClient);

    multiCallerClient = new MultiCallerClient(spyLogger, null); // leave out the gasEstimator for now.

    spokePoolClient_1 = new SpokePoolClient(spyLogger, spokePool_1.connect(relayer), configStoreClient, originChainId);
    spokePoolClient_2 = new SpokePoolClient(
      spyLogger,
      spokePool_2.connect(relayer),
      configStoreClient,
      destinationChainId
    );
    const spokePoolClients = { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 };
    tokenClient = new TokenClient(spyLogger, relayer.address, spokePoolClients, hubPoolClient);
    profitClient = new ProfitClient(spyLogger, hubPoolClient, toBNWei(1)); // Set relayer discount to 100%.
    inventoryClient = new MockInventoryClient();
    relayerInstance = new Relayer(spyLogger, {
      spokePoolClients,
      hubPoolClient,
      configStoreClient,
      tokenClient,
      profitClient,
      multiCallerClient,
      inventoryClient,
    });

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

  // Unfilled amount <= partial fill threshold: sends either 100% fill or 1 wei fill
  // Unfilled amount > partial fill threshold:
  //     - If unfilled amount > partial fill amount, then send partial fill and record shortfall. Run again and test that no other fills are sent.
  //     - If unfilled amount <= partial fill amount, then we can just fill rest of deposit
  it("Partial fill amount is non 0 and < unfilled amount", async function () {
    // Unfilled amount > partial fill amount, so there is a shortfall and relayer will partially fill relay.
    inventoryClient.setPartialFillAmount(amountToDeposit.div(4));
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    const deposit1 = await deposit(
      spokePool_1,
      erc20_1,
      depositor,
      depositor,
      destinationChainId,
      amountToDeposit // Needs to be >= partial fill amount we set above
    );
    await updateAllClients();
    const startingRelayerBalance = await erc20_2.balanceOf(relayer.address);
    await relayerInstance.checkForUnfilledDepositsAndFill();

    expect(spyLogIncludes(spy, -2, "Partially filling")).to.be.true;
    expect(lastSpyLogIncludes(spy, "Insufficient balance to fill all deposits")).to.be.true;
    expect(multiCallerClient.transactionCount()).to.equal(1);

    const tx = await multiCallerClient.executeTransactionQueue();
    expect(tx.length).to.equal(1); // There should have been exactly one transaction.

    // Check the state change happened correctly on the smart contract. There should be exactly one fill on spokePool_2.
    const fillEvents2 = await spokePool_2.queryFilter(spokePool_2.filters.FilledRelay());
    expect(fillEvents2.length).to.equal(1);
    expect(fillEvents2[0].args.depositId).to.equal(deposit1.depositId);
    expect(fillEvents2[0].args.amount).to.equal(deposit1.amount);
    expect(fillEvents2[0].args.fillAmount).to.equal("27803583276807944721");
    // Partial fill amount returned by inventory client, which should be a bit more than the actual amount sent.
    expect(fillEvents2[0].args.destinationChainId).to.equal(Number(deposit1.destinationChainId));
    expect(fillEvents2[0].args.originChainId).to.equal(Number(deposit1.originChainId));
    expect(fillEvents2[0].args.relayerFeePct).to.equal(deposit1.relayerFeePct);
    expect(fillEvents2[0].args.depositor).to.equal(deposit1.depositor);
    expect(fillEvents2[0].args.recipient).to.equal(deposit1.recipient);

    // Expect a shortfall:
    expect(tokenClient.getTokenShortfall()).to.deep.equal({
      [destinationChainId]: {
        [erc20_2.address]: {
          deposits: [0],
          balance: startingRelayerBalance.sub(amountToDeposit.div(4)),
          needed: amountToDeposit.sub(amountToDeposit.div(4)),
          shortfall: amountToDeposit
            .sub(amountToDeposit.div(4))
            .sub(startingRelayerBalance.sub(amountToDeposit.div(4))),
        },
      },
    });

    // Re-run the execution loop and validate that no additional relays are sent.
    multiCallerClient.clearTransactionQueue();
    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(multiCallerClient.transactionCount()).to.equal(0);
  });
  it("Partial fill amount is non 0 and >= unfilled amount", async function () {
    // Unfilled amount <= partial fill amount, send full relay
    inventoryClient.setPartialFillAmount(amountToDeposit);
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    const deposit1 = await deposit(
      spokePool_1,
      erc20_1,
      depositor,
      depositor,
      destinationChainId,
      amountToDeposit // Needs to be >= partial fill amount we set above
    );
    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill();

    expect(spyLogIncludes(spy, -1, "Filling deposit")).to.be.true;
    expect(multiCallerClient.transactionCount()).to.equal(1);

    const tx = await multiCallerClient.executeTransactionQueue();
    expect(tx.length).to.equal(1); // There should have been exactly one transaction.

    // Check the state change happened correctly on the smart contract. There should be exactly one fill on spokePool_2.
    const fillEvents2 = await spokePool_2.queryFilter(spokePool_2.filters.FilledRelay());
    expect(fillEvents2.length).to.equal(1);
    expect(fillEvents2[0].args.depositId).to.equal(deposit1.depositId);
    expect(fillEvents2[0].args.amount).to.equal(deposit1.amount);
    expect(fillEvents2[0].args.fillAmount).to.equal(deposit1.amount);
    expect(fillEvents2[0].args.destinationChainId).to.equal(Number(deposit1.destinationChainId));
    expect(fillEvents2[0].args.originChainId).to.equal(Number(deposit1.originChainId));
    expect(fillEvents2[0].args.relayerFeePct).to.equal(deposit1.relayerFeePct);
    expect(fillEvents2[0].args.depositor).to.equal(deposit1.depositor);
    expect(fillEvents2[0].args.recipient).to.equal(deposit1.recipient);
  });
  it("Partial fill is 0", async function () {
    // send full relay if balance can full amount
    inventoryClient.setPartialFillAmount(toBN(0));
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    const deposit1 = await deposit(
      spokePool_1,
      erc20_1,
      depositor,
      depositor,
      destinationChainId,
      amountToDeposit // Needs to be >= partial fill amount we set above
    );
    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill();

    expect(spyLogIncludes(spy, -1, "Filling deposit")).to.be.true;
    expect(multiCallerClient.transactionCount()).to.equal(1);

    const tx = await multiCallerClient.executeTransactionQueue();
    expect(tx.length).to.equal(1); // There should have been exactly one transaction.

    // Check the state change happened correctly on the smart contract. There should be exactly one fill on spokePool_2.
    const fillEvents2 = await spokePool_2.queryFilter(spokePool_2.filters.FilledRelay());
    expect(fillEvents2.length).to.equal(1);
    expect(fillEvents2[0].args.depositId).to.equal(deposit1.depositId);
    expect(fillEvents2[0].args.amount).to.equal(deposit1.amount);
    expect(fillEvents2[0].args.fillAmount).to.equal(deposit1.amount);
    expect(fillEvents2[0].args.destinationChainId).to.equal(Number(deposit1.destinationChainId));
    expect(fillEvents2[0].args.originChainId).to.equal(Number(deposit1.originChainId));
    expect(fillEvents2[0].args.relayerFeePct).to.equal(deposit1.relayerFeePct);
    expect(fillEvents2[0].args.depositor).to.equal(deposit1.depositor);
    expect(fillEvents2[0].args.recipient).to.equal(deposit1.recipient);
  });
});

async function updateAllClients() {
  await hubPoolClient.update();
  await configStoreClient.update();
  await tokenClient.update();
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
}
