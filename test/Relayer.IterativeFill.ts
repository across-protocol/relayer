import { deployAndConfigureHubPool, deployIterativeSpokePoolsAndToken, createSpyLogger, lastSpyLogIncludes } from "./utils";
import { expect, deposit, ethers, Contract, getLastBlockTime, contractAt, addLiquidity } from "./utils";
import { SignerWithAddress, setupTokensForWallet, deployConfigStore, winston, sinon, toBNWei } from "./utils";
import { amountToLp, defaultTokenConfig } from "./constants";
import { HubPoolClient, AcrossConfigStoreClient, MultiCallerClient } from "../src/clients";
import { TokenClient, ProfitClient } from "../src/clients";

import { Relayer } from "../src/relayer/Relayer"; // Tested

let relayer_signer: SignerWithAddress, hubPool: Contract, mockAdapter: Contract, configStore: Contract;
let hubPoolClient: HubPoolClient, configStoreClient: AcrossConfigStoreClient, tokenClient: TokenClient;
let spy: sinon.SinonSpy, spyLogger: winston.Logger;

let spokePools, l1TokenToL2Tokens;
let relayer: Relayer, multiCallerClient: MultiCallerClient, profitClient: ProfitClient;

describe("Relayer: Iterative fill", async function () {
  beforeEach(async function () {
    [relayer_signer] = await ethers.getSigners(); // note we use relayer_signer as the owner as well to simplify the test.
    ({ hubPool, mockAdapter } = await deployAndConfigureHubPool(relayer_signer, []));
  });
  it("One token on multiple chains", async function () {
    const [, , depositor] = await ethers.getSigners();
    const numChainsToDeploySpokePoolsTo = 5;
    const numTokensToDeployPerChain = 1;

    ({ spy, spyLogger } = createSpyLogger());
    ({ configStore } = await deployConfigStore(relayer_signer, []));
    hubPoolClient = new HubPoolClient(spyLogger, hubPool);
    configStoreClient = new AcrossConfigStoreClient(spyLogger, configStore, hubPoolClient);
    multiCallerClient = new MultiCallerClient(spyLogger, null); // leave out the gasEstimator for now.

    ({ spokePools, l1TokenToL2Tokens } = await deployIterativeSpokePoolsAndToken(
      spyLogger,
      relayer_signer,
      mockAdapter,
      configStoreClient,
      numChainsToDeploySpokePoolsTo,
      numTokensToDeployPerChain
    ));

    const l1Token = await contractAt("ExpandedERC20", relayer_signer, Object.keys(l1TokenToL2Tokens)[0]);

    await configStore.updateTokenConfig(l1Token.address, defaultTokenConfig);

    await addLiquidity(relayer_signer, hubPool, l1Token, amountToLp);

    let spokePoolClients = {};
    spokePools.forEach((spokePool) => {
      spokePoolClients[spokePool.spokePoolClient.chainId] = spokePool.spokePoolClient;
    });

    tokenClient = new TokenClient(spyLogger, relayer_signer.address, spokePoolClients, hubPoolClient);
    profitClient = new ProfitClient(spyLogger, hubPoolClient, toBNWei(1)); // Set relayer discount to 100%.
    await updateAllClients();
    relayer = new Relayer(spyLogger, {
      spokePoolClients,
      hubPoolClient,
      configStoreClient,
      tokenClient,
      profitClient,
      multiCallerClient,
    });

    let depositCount = 0;

    // Seed the depositor and relayer for each chain and do one deposit to each of the other chain's spokePool.
    for (let i = 0; i < spokePools.length; i++) {
      const { spokePool, spokePoolClient } = spokePools[i];
      // Seed wallets. Note we are selecting the associated token to seed for the given spokePool. i.e the ith element
      // in the l1TokenToL2Tokens[l1Token] is the token associated with this chain
      await setupTokensForWallet(spokePool, relayer_signer, l1TokenToL2Tokens[l1Token.address], null, 100);
      await setupTokensForWallet(spokePool, depositor, [l1TokenToL2Tokens[l1Token.address][i]], null, 10);

      // Execute deposits to all other chainIds. Deposit from chain i to chain j. Leave deposit amount and relayer fees default.
      for (let j = 1; j < spokePools.length + 1; j++) {
        if (spokePoolClient.chainId === j) continue;
        await spokePool.setCurrentTime(await getLastBlockTime(spokePool.provider));
        await deposit(spokePool, l1TokenToL2Tokens[l1Token.address][i], depositor, depositor, j);
        depositCount++;
      }
    }

    // There should be a total of 20 deposits: each chain can send to each other chain, totalling 4 * 5 = 20.
    expect(depositCount).to.equal(20);

    // Update all clients and run the relayer. Relayer should fill all 20 deposits.
    await updateAllClients();
    await relayer.checkForUnfilledDepositsAndFill();
    expect(multiCallerClient.transactionCount()).to.equal(20); // 20 transactions, filling each relay.
    const txs = await multiCallerClient.executeTransactionQueue();
    expect(lastSpyLogIncludes(spy, "Multicall batch sent")).to.be.true;
    expect(txs.length).to.equal(5); // There should have been exactly 5 bundles, one to each target chainId.
    // Re-run the execution loop and validate that no additional relays are sent.
    multiCallerClient.clearTransactionQueue();
    await updateAllClients();
    await relayer.checkForUnfilledDepositsAndFill();
    expect(multiCallerClient.transactionCount()).to.equal(0); // no Transactions to send.
    expect(lastSpyLogIncludes(spy, "No unfilled deposits")).to.be.true;
  });
});

async function updateAllClients() {
  await hubPoolClient.update();
  await configStoreClient.update();
  await tokenClient.update();
  for (const spokePool of spokePools) {
    await spokePool.spokePoolClient.update();
  }
}
