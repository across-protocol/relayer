import { deploySpokePoolWithToken, enableRoutesOnHubPool, destinationChainId, originChainId, sinon } from "./utils";
import { expect, deposit, ethers, Contract, SignerWithAddress, setupTokensForWallet, getLastBlockTime } from "./utils";
import { lastSpyLogIncludes, toBNWei, createSpyLogger, deployConfigStore } from "./utils";
import { deployAndConfigureHubPool, winston } from "./utils";
import { amountToLp, l1TokenTransferThreshold, sampleRateModel, defaultTokenConfig } from "./constants";
import {
  SpokePoolClient,
  HubPoolClient,
  AcrossConfigStoreClient,
  MultiCallerClient,
  ProfitClient,
} from "../src/clients";
import { TokenClient } from "../src/clients";

import { Relayer } from "../src/relayer/Relayer"; // Tested

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let hubPool: Contract, configStore: Contract, l1Token: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
let spy: sinon.SinonSpy, spyLogger: winston.Logger;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let configStoreClient: AcrossConfigStoreClient, hubPoolClient: HubPoolClient, tokenClient: TokenClient;
let relayerInstance: Relayer;
let multiCallerClient: MultiCallerClient, profitClient: ProfitClient;

describe("Relayer: Token balance shortfall", async function () {
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
    tokenClient = new TokenClient(spyLogger, relayer.address, spokePoolClients);
    profitClient = new ProfitClient(spyLogger, hubPoolClient, toBNWei(1)); // Set the profit discount to 1 (ignore relay cost.)
    relayerInstance = new Relayer(spyLogger, {
      spokePoolClients,
      hubPoolClient,
      configStoreClient,
      tokenClient,
      profitClient,
      multiCallerClient,
    });

    // Seed Owner and depositor wallets but dont seed relayer to test how the relayer handles being out of funds.
    await setupTokensForWallet(spokePool_1, owner, [l1Token], null, 100); // Seed owner to LP.
    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], null, 10);
    await setupTokensForWallet(spokePool_2, depositor, [erc20_2], null, 10);

    // Execute large approval so we dont need to worry about this.
    await erc20_1.connect(relayer).approve(spokePool_1.address, toBNWei(100000));
    await erc20_2.connect(relayer).approve(spokePool_2.address, toBNWei(100000));

    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);
    await configStore.updateTokenConfig(l1Token.address, defaultTokenConfig);

    await updateAllClients();
  });

  it("Produces expected logs based on insufficient single token balance", async function () {
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    // Deposit 100 tokens to be relayed, two times.
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

    // Seed the relayer with 50 tokens. This is insufficient to fill the relay and should produce the expected log.
    await erc20_2.mint(relayer.address, toBNWei(50));

    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill();

    expect(lastSpyLogIncludes(spy, "Insufficient balance to fill all deposits")).to.be.true;
    expect(lastSpyLogIncludes(spy, "Shortfall on Hardhat2:")).to.be.true;
    expect(lastSpyLogIncludes(spy, `${await l1Token.symbol()} cumulative shortfall of 150.00`)).to.be.true;
    expect(lastSpyLogIncludes(spy, "blocking deposits: 1,0")).to.be.true;

    // At the end of the execution the tokenClient should have correctly flushed.
    expect(tokenClient.anyCapturedShortFallFills()).to.be.false;

    // Submitting another relay should increment the shortfall and log accordingly. Total shortfall of 250 now.
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(lastSpyLogIncludes(spy, `${await l1Token.symbol()} cumulative shortfall of 250.00`)).to.be.true;
    expect(lastSpyLogIncludes(spy, "blocking deposits: 2,1,0")).to.be.true;

    // Mint more tokens to the relayer to fill the shortfall. Mint enough to just cover the most recent relay. The
    // Other relays should not be filled.
    await erc20_2.mint(relayer.address, toBNWei(60));
    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(lastSpyLogIncludes(spy, `${await l1Token.symbol()} cumulative shortfall of 190.00`)).to.be.true;
    expect(lastSpyLogIncludes(spy, "blocking deposits: 1,0")).to.be.true;

    const tx = await multiCallerClient.executeTransactionQueue();
    expect(lastSpyLogIncludes(spy, "Multicall batch sent")).to.be.true;
    expect(lastSpyLogIncludes(spy, "Relayed depositId 2")).to.be.true;
    expect(tx.length).to.equal(1); // There should have been exactly one transaction.
  });
  it("Produces expected logs based on insufficient multiple token balance", async function () {
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    await spokePool_2.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    // Deposit 100 tokens to be relayed of each token type.
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await deposit(spokePool_2, erc20_2, depositor, depositor, originChainId);

    await updateAllClients();

    await relayerInstance.checkForUnfilledDepositsAndFill();

    expect(lastSpyLogIncludes(spy, "Insufficient balance to fill all deposits")).to.be.true;
    expect(lastSpyLogIncludes(spy, "Shortfall on Hardhat1:")).to.be.true; // both networks should show shortfalls.
    expect(lastSpyLogIncludes(spy, "Shortfall on Hardhat2:")).to.be.true;
    expect(lastSpyLogIncludes(spy, `${await l1Token.symbol()} cumulative shortfall of 100.00`)).to.be.true;
    expect(lastSpyLogIncludes(spy, "blocking deposits: 0")).to.be.true;
  });
});

async function updateAllClients() {
  await hubPoolClient.update();
  await configStoreClient.update();
  await tokenClient.update();
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
}
