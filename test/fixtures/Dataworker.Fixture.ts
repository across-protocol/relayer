import * as utils from "@across-protocol/contracts-v2/dist/test-utils";
import { umaEcosystemFixture } from "@across-protocol/contracts-v2/dist/test/fixtures/UmaEcosystem.Fixture";
import { deploySpokePoolWithToken, enableRoutesOnHubPool, Contract, hre, enableRoutes } from "../utils";
import { SignerWithAddress, setupTokensForWallet, getLastBlockTime } from "../utils";
import { createSpyLogger, winston, deployAndConfigureHubPool, deployRateModelStore } from "../utils";
import {
  SpokePoolClient,
  HubPoolClient,
  RateModelClient,
  MultiCallerClient,
  ConfigStoreClient,
} from "../../src/clients";
import { amountToLp, destinationChainId, originChainId, MAX_REFUNDS_PER_LEAF, repaymentChainId } from "../constants";

import { Dataworker } from "../../src/dataworker/Dataworker"; // Tested

export const dataworkerFixture = hre.deployments.createFixture(async ({ ethers }, maxRefundLeaf: number) => {
  return await setupDataworker(ethers, maxRefundLeaf);
});

// Sets up all contracts neccessary to build and execute leaves in dataworker merkle roots: relayer refund, slow relay,
// and pool rebalance roots.
export async function setupDataworker(
  ethers: any,
  maxRefundLeaf: number
): Promise<{
  hubPool: Contract;
  spokePool_1: Contract;
  erc20_1: Contract;
  spokePool_2: Contract;
  erc20_2: Contract;
  l1Token_1: Contract;
  l1Token_2: Contract;
  timer: Contract;
  spokePoolClient_1: SpokePoolClient;
  spokePoolClient_2: SpokePoolClient;
  rateModelClient: RateModelClient;
  hubPoolClient: HubPoolClient;
  dataworkerInstance: Dataworker;
  spyLogger: winston.Logger;
  multiCallerClient: MultiCallerClient;
  owner: SignerWithAddress;
  depositor: SignerWithAddress;
  relayer: SignerWithAddress;
  dataworker: SignerWithAddress;
  updateAllClients: () => Promise<void>;
}> {
  const [owner, depositor, relayer, dataworker] = await ethers.getSigners();

  // Deploy UMA system and link Finder with HubPool, which we'll need to execute roots.
  const parentFixture = await umaEcosystemFixture();

  const { spokePool: spokePool_1, erc20: erc20_1 } = await deploySpokePoolWithToken(originChainId, destinationChainId);
  const { spokePool: spokePool_2, erc20: erc20_2 } = await deploySpokePoolWithToken(destinationChainId, originChainId);

  // Only set cross chain contracts for one spoke pool to begin with.
  const { hubPool, l1Token_1, l1Token_2 } = await deployAndConfigureHubPool(
    owner,
    [{ l2ChainId: destinationChainId, spokePool: spokePool_2 }],
    parentFixture.finder.address,
    parentFixture.timer.address
  );

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

  // Enable cross chain contracts so that pool rebalance leaves can be executed.
  const mockAdapter = await (await utils.getContractFactory("Mock_Adapter", owner)).deploy();
  await hubPool.setCrossChainContracts(destinationChainId, mockAdapter.address, spokePool_1.address);
  await hubPool.setCrossChainContracts(originChainId, mockAdapter.address, spokePool_2.address);

  // Set bond currency on hub pool so that roots can be proposed.
  await parentFixture.collateralWhitelist.addToWhitelist(l1Token_1.address);
  await parentFixture.store.setFinalFee(l1Token_1.address, { rawValue: "0" });
  await hubPool.setBond(l1Token_1.address, "1"); // We set to 1 Wei since we can't set to 0.

  // Give dataworker final fee bond to propose roots with:
  await setupTokensForWallet(hubPool, dataworker, [l1Token_1], null, 100);

  const { spyLogger } = createSpyLogger();
  const { rateModelStore } = await deployRateModelStore(owner, [l1Token_1, l1Token_2]);
  const hubPoolClient = new HubPoolClient(spyLogger, hubPool);
  const rateModelClient = new RateModelClient(spyLogger, rateModelStore, hubPoolClient);

  const multiCallerClient = new MultiCallerClient(spyLogger, null); // leave out the gasEstimator for now.
  const configStoreClient = new ConfigStoreClient(spyLogger, maxRefundLeaf);

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

  const dataworkerInstance = new Dataworker(spyLogger, {
    spokePoolClients: { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 },
    hubPoolClient,
    rateModelClient,
    multiCallerClient,
    configStoreClient,
  });

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
    hubPool,
    spokePool_1,
    erc20_1,
    spokePool_2,
    erc20_2,
    l1Token_1,
    l1Token_2,
    timer: parentFixture.timer,
    spokePoolClient_1,
    spokePoolClient_2,
    rateModelClient,
    hubPoolClient,
    dataworkerInstance,
    spyLogger,
    multiCallerClient,
    owner,
    depositor,
    relayer,
    dataworker,
    updateAllClients: async () => {
      await hubPoolClient.update();
      await configStoreClient.update();
      await rateModelClient.update();
      await spokePoolClient_1.update();
      await spokePoolClient_2.update();
    },
  };
}
