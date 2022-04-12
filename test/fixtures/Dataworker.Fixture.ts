import { deploySpokePoolWithToken, enableRoutesOnHubPool, Contract, hre, enableRoutes } from "../utils";
import { SignerWithAddress, setupTokensForWallet, getLastBlockTime } from "../utils";
import { createSpyLogger, winston, deployAndConfigureHubPool, deployRateModelStore } from "../utils";
import { SpokePoolClient, HubPoolClient, RateModelClient, MultiCallBundler } from "../../src/clients";
import { amountToLp, destinationChainId, originChainId } from "../constants";

import { Dataworker } from "../../src/dataworker/Dataworker"; // Tested

export const dataworkerFixture = hre.deployments.createFixture(async ({ ethers }) => {
  return await setupDataworker(ethers);
});

export async function setupDataworker(ethers: any): Promise<{
  spokePool_1: Contract;
  erc20_1: Contract;
  spokePool_2: Contract;
  erc20_2: Contract;
  l1Token_1: Contract;
  l1Token_2: Contract;
  spokePoolClient_1: SpokePoolClient;
  spokePoolClient_2: SpokePoolClient;
  rateModelClient: RateModelClient;
  hubPoolClient: HubPoolClient;
  dataworkerInstance: Dataworker;
  spyLogger: winston.Logger;
  multiCallBundler: MultiCallBundler;
  owner: SignerWithAddress;
  depositor: SignerWithAddress;
  relayer: SignerWithAddress;
}> {
  const [owner, depositor, relayer] = await ethers.getSigners();
  const { spokePool: spokePool_1, erc20: erc20_1 } = await deploySpokePoolWithToken(originChainId, destinationChainId);
  const { spokePool: spokePool_2, erc20: erc20_2 } = await deploySpokePoolWithToken(destinationChainId, originChainId);

  // Only set cross chain contracts for one spoke pool to begin with.
  const { hubPool, l1Token_1, l1Token_2 } = await deployAndConfigureHubPool(owner, [
    { l2ChainId: destinationChainId, spokePool: spokePool_2 },
  ]);

  // Enable deposit routes for second L2 tokens so relays can be sent between spoke pool 1 <--> 2.
  await enableRoutes(spokePool_1, [{ originToken: erc20_2.address, destinationChainId: destinationChainId }]);
  await enableRoutes(spokePool_2, [{ originToken: erc20_1.address, destinationChainId: originChainId }]);
  
  // For each chain, enable routes to both erc20's so that we can fill relays
  await enableRoutesOnHubPool(hubPool, [
    { destinationChainId: originChainId, l1Token: l1Token_1, destinationToken: erc20_1 },
    { destinationChainId: destinationChainId, l1Token: l1Token_1, destinationToken: erc20_2 },
    { destinationChainId: originChainId, l1Token: l1Token_2, destinationToken: erc20_2 },
    { destinationChainId: destinationChainId, l1Token: l1Token_2, destinationToken: erc20_1 },
  ]);

  const { spyLogger } = createSpyLogger();
  const { rateModelStore } = await deployRateModelStore(owner, [l1Token_1, l1Token_2]);
  const hubPoolClient = new HubPoolClient(spyLogger, hubPool);
  const rateModelClient = new RateModelClient(spyLogger, rateModelStore, hubPoolClient);

  const multiCallBundler = new MultiCallBundler(spyLogger, null); // leave out the gasEstimator for now.

  const spokePoolClient_1 = new SpokePoolClient(
    spyLogger,
    spokePool_1.connect(relayer),
    rateModelClient,
    originChainId
  );
  const spokePoolClient_2 = new SpokePoolClient(
    spyLogger,
    spokePool_2.connect(relayer),
    rateModelClient,
    destinationChainId
  );

  const dataworkerInstance = new Dataworker(
    spyLogger,
    { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 },
    hubPoolClient,
    multiCallBundler
  );

  // Give owner tokens to LP on HubPool with.
  await setupTokensForWallet(spokePool_1, owner, [l1Token_1, l1Token_2], null, 100); // Seed owner to LP.
  await l1Token_1.approve(hubPool.address, amountToLp);
  await l1Token_2.approve(hubPool.address, amountToLp);
  await hubPool.addLiquidity(l1Token_1.address, amountToLp);
  await hubPool.addLiquidity(l1Token_2.address, amountToLp);

  // Give depositors the tokens they'll deposit into spoke pools:
  await setupTokensForWallet(spokePool_1, depositor, [erc20_1, erc20_2], null, 10);
  await setupTokensForWallet(spokePool_2, depositor, [erc20_2, erc20_1], null, 10);

  // Give relayers the tokens they'll need to relay on spoke pools:
  await setupTokensForWallet(spokePool_1, relayer, [erc20_1, erc20_2, l1Token_1, l1Token_2], null, 10);
  await setupTokensForWallet(spokePool_2, relayer, [erc20_1, erc20_2, l1Token_1, l1Token_2], null, 10);

  // Set the spokePool's time to the provider time. This is done to enable the block utility time finder identify a
  // "reasonable" block number based off the block time when looking at quote timestamps.
  await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
  await spokePool_2.setCurrentTime(await getLastBlockTime(spokePool_2.provider));

  return {
    spokePool_1,
    erc20_1,
    spokePool_2,
    erc20_2,
    l1Token_1,
    l1Token_2,
    spokePoolClient_1,
    spokePoolClient_2,
    rateModelClient,
    hubPoolClient,
    dataworkerInstance,
    spyLogger,
    multiCallBundler,
    owner,
    depositor,
    relayer,
  };
}
