import { hubPoolFixture, deployIterativeSpokePoolsAndToken, createSpyLogger, lastSpyLogIncludes } from "./utils";
import { expect, deposit, ethers, Contract, SignerWithAddress, setupTokensForWallet, winston, sinon } from "./utils";

import { HubPoolEventClient } from "../src/HubPoolEventClient";
import { Relayer } from "../src/Relayer";
import { MulticallBundler } from "../src/MulticallBundler";

let relayer_signer: SignerWithAddress, hubPool: Contract, mockAdapter: Contract, hubPoolClient: HubPoolEventClient;

let spy: sinon.SinonSpy, spyLogger: winston.Logger;

let spokePools, l1TokenToL2Tokens;
let relayer: Relayer, multicallBundler: MulticallBundler;

describe("Relayer: Iterative fill", async function () {
  beforeEach(async function () {
    [relayer_signer] = await ethers.getSigners();

    ({ hubPool, mockAdapter } = await hubPoolFixture());
    hubPoolClient = new HubPoolEventClient(hubPool);
    ({ spy, spyLogger } = createSpyLogger());
    multicallBundler = new MulticallBundler(spyLogger, null); // leave out the gasEstimator for now.
  });
  it.only("One token on multiple chains", async function () {
    const [, , depositor] = await ethers.getSigners();
    const numChainsToDeploySpokePoolsTo = 5;
    const numTokensToDeployPerChain = 1;
    ({ spokePools, l1TokenToL2Tokens } = await deployIterativeSpokePoolsAndToken(
      relayer_signer,
      mockAdapter,
      hubPool,
      numChainsToDeploySpokePoolsTo,
      numTokensToDeployPerChain
    ));
    let spokePoolEventClients = {};
    spokePools.forEach((spokePool) => {
      spokePoolEventClients[spokePool.spokePoolClient.chainId] = spokePool.spokePoolClient;
    });
    relayer = new Relayer(spyLogger, spokePoolEventClients, hubPoolClient, multicallBundler);

    const l1Token = Object.keys(l1TokenToL2Tokens)[0];
    let depositCount = 0;

    // Seed the depositor and relayer for each chain and do one deposit to each of the other chain's spokePool.
    for (let i = 0; i < spokePools.length; i++) {
      const { spokePool, spokePoolClient } = spokePools[i];
      // Seed wallets. Note we are selecting the associated token to seed for the given spokePool. i.e the ith element
      // in the l1TokenToL2Tokens[l1Token] is the token associated with this chain
      await setupTokensForWallet(spokePool, relayer_signer, l1TokenToL2Tokens[l1Token], null, 50);
      await setupTokensForWallet(spokePool, depositor, [l1TokenToL2Tokens[l1Token][i]], null, 10);

      // Execute deposits to all other chainIds. Deposit from chain i to chain j. Leave deposit amount and relayer fees default.
      for (let j = 1; j < spokePools.length + 1; j++) {
        if (spokePoolClient.chainId === j) continue;
        await deposit(spokePool, l1TokenToL2Tokens[l1Token][i], depositor, depositor, j);
        depositCount++;
      }
    }

    // There should be a total of 20 deposits: each chain can send to each other chain, totalling 4 * 5 = 20.
    expect(depositCount).to.equal(20);

    // Update all clients and run the relayer. Relayer should fill all 20 deposits.
    await Promise.all([...spokePools.map((spokePool) => spokePool.spokePoolClient.update()), hubPoolClient.update()]);
    await relayer.checkForUnfilledDepositsAndFill();
    expect(multicallBundler.transactionCount()).to.equal(20); // 20 transactions, filling each relay.

    const txs = await multicallBundler.executeTransactionQueue();
    expect(lastSpyLogIncludes(spy, "All transactions executed")).to.be.true;
    expect(txs.length).to.equal(20); // There should have been exactly 20 transaction.

    // Re-run the execution loop and validate that no additional relays are sent.
    multicallBundler.clearTransactionQueue();
    await Promise.all([...spokePools.map((spokePool) => spokePool.spokePoolClient.update()), hubPoolClient.update()]);
    await relayer.checkForUnfilledDepositsAndFill();
    expect(multicallBundler.transactionCount()).to.equal(0); // no Transactions to send.
    expect(lastSpyLogIncludes(spy, "No unfilled deposits")).to.be.true;
  });
});
