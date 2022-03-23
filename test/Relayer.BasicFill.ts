import { deploySpokePoolWithToken, enableRoutesOnHubPool, destinationChainId, originChainId, sinon } from "./utils";
import { expect, deposit, ethers, Contract, SignerWithAddress, setupTokensForWallet, getLastBlockTime } from "./utils";
import { lastSpyLogIncludes, createSpyLogger, deployRateModelStore, deployAndConfigureHubPool, winston } from "./utils";
import { randomLl1Token, amountToLp } from "./constants";

import { SpokePoolEventClient } from "../src/SpokePoolEventClient";
import { HubPoolEventClient } from "../src/HubPoolEventClient";
import { Relayer } from "../src/Relayer";
import { MulticallBundler } from "../src/MulticallBundler";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let hubPool: Contract, mockAdapter: Contract, rateModelStore: Contract, l1Token: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer_signer: SignerWithAddress;
let spy: sinon.SinonSpy, spyLogger: winston.Logger;

let spokePoolClient_1: SpokePoolEventClient, spokePoolClient_2: SpokePoolEventClient, hubPoolClient: HubPoolEventClient;
let relayer: Relayer;
let multicallBundler: MulticallBundler;

describe("Relayer: Check for Unfilled Deposits and Fill", async function () {
  beforeEach(async function () {
    [owner, depositor, relayer_signer] = await ethers.getSigners();

    ({ spokePool: spokePool_1, erc20: erc20_1 } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({ spokePool: spokePool_2, erc20: erc20_2 } = await deploySpokePoolWithToken(destinationChainId, originChainId));

    ({ hubPool, dai: l1Token } = await deployAndConfigureHubPool([
      { l2ChainId: destinationChainId, spokePool: spokePool_2 },
    ]));

    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token, destinationToken: erc20_1 },
      { destinationChainId: destinationChainId, l1Token, destinationToken: erc20_2 },
    ]);

    spokePoolClient_1 = new SpokePoolEventClient(spokePool_1.connect(relayer_signer), originChainId);
    spokePoolClient_2 = new SpokePoolEventClient(spokePool_2.connect(relayer_signer), destinationChainId);

    ({ rateModelStore } = await deployRateModelStore(owner, [l1Token]));
    hubPoolClient = new HubPoolEventClient(hubPool, rateModelStore);
    ({ spy, spyLogger } = createSpyLogger());

    multicallBundler = new MulticallBundler(spyLogger, null); // leave out the gasEstimator for now.

    relayer = new Relayer(
      spyLogger,
      { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 },
      hubPoolClient,
      multicallBundler
    );

    await setupTokensForWallet(spokePool_1, owner, [l1Token], null, 100); // Seed owner to LP.
    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], null, 10);
    await setupTokensForWallet(spokePool_2, depositor, [erc20_2], null, 10);
    await setupTokensForWallet(spokePool_1, relayer_signer, [erc20_1, erc20_2], null, 10);
    await setupTokensForWallet(spokePool_2, relayer_signer, [erc20_1, erc20_2], null, 10);

    // Approve and add liquidity.
    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);
  });

  it("Correctly fetches single unfilled deposit and fills it", async function () {
    // Set the spokePool's time to the provider time. This is done to enable the block utility time finder identify a
    // "reasonable" block number based off the block time when looking at quote timestamps.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    const deposit1 = await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
    await relayer.checkForUnfilledDepositsAndFill();
    expect(lastSpyLogIncludes(spy, "Filling deposit")).to.be.true;
    expect(multicallBundler.transactionCount()).to.equal(1); // One transaction, filling the one deposit.

    const tx = await multicallBundler.executeTransactionQueue();
    expect(lastSpyLogIncludes(spy, "All transactions executed")).to.be.true;
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

    // There should be no fill events on the origin spoke pool.
    expect((await spokePool_1.queryFilter(spokePool_1.filters.FilledRelay())).length).to.equal(0);

    // Re-run the execution loop and validate that no additional relays are sent.
    multicallBundler.clearTransactionQueue();
    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
    await relayer.checkForUnfilledDepositsAndFill();
    expect(multicallBundler.transactionCount()).to.equal(0); // no Transactions to send.
    expect(lastSpyLogIncludes(spy, "No unfilled deposits")).to.be.true;
  });
});
