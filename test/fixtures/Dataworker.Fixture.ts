import { setupUmaEcosystem } from "./UmaEcosystemFixture";
import { deploySpokePoolWithToken, enableRoutesOnHubPool, Contract, BigNumber, enableRoutes } from "../utils";
import { SignerWithAddress, setupTokensForWallet, getLastBlockTime } from "../utils";
import { createSpyLogger, winston, deployAndConfigureHubPool, deployConfigStore } from "../utils";
import * as clients from "../../src/clients";
import { amountToLp, destinationChainId, originChainId, CHAIN_ID_TEST_LIST } from "../constants";

import { Dataworker } from "../../src/dataworker/Dataworker"; // Tested

// Sets up all contracts neccessary to build and execute leaves in dataworker merkle roots: relayer refund, slow relay,
// and pool rebalance roots.
export async function setupDataworker(
  ethers: any,
  maxRefundPerRelayerRefundLeaf: number,
  maxL1TokensPerPoolRebalanceLeaf: number,
  defaultPoolRebalanceTokenTransferThreshold: BigNumber
): Promise<{
  hubPool: Contract;
  spokePool_1: Contract;
  erc20_1: Contract;
  spokePool_2: Contract;
  erc20_2: Contract;
  l1Token_1: Contract;
  l1Token_2: Contract;
  configStore: Contract;
  timer: Contract;
  spokePoolClient_1: clients.SpokePoolClient;
  spokePoolClient_2: clients.SpokePoolClient;
  configStoreClient: clients.ConfigStoreClient;
  rateModelClient: clients.RateModelClient;
  hubPoolClient: clients.HubPoolClient;
  dataworkerInstance: Dataworker;
  spyLogger: winston.Logger;
  multiCallerClient: clients.MultiCallerClient;
  owner: SignerWithAddress;
  depositor: SignerWithAddress;
  relayer: SignerWithAddress;
  dataworker: SignerWithAddress;
  updateAllClients: () => Promise<void>;
}> {
  const [owner, depositor, relayer, dataworker] = await ethers.getSigners();

  const { spokePool: spokePool_1, erc20: erc20_1 } = await deploySpokePoolWithToken(originChainId, destinationChainId);
  const { spokePool: spokePool_2, erc20: erc20_2 } = await deploySpokePoolWithToken(destinationChainId, originChainId);

  const umaEcosystem = await setupUmaEcosystem(owner);
  const { hubPool, l1Token_1, l1Token_2 } = await deployAndConfigureHubPool(
    owner,
    [
      { l2ChainId: destinationChainId, spokePool: spokePool_2 },
      { l2ChainId: originChainId, spokePool: spokePool_1 },
    ],
    umaEcosystem.finder.address,
    umaEcosystem.timer.address
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

  // Set bond currency on hub pool so that roots can be proposed.
  await umaEcosystem.collateralWhitelist.addToWhitelist(l1Token_1.address);
  await umaEcosystem.store.setFinalFee(l1Token_1.address, { rawValue: "0" });
  await hubPool.setBond(l1Token_1.address, "1"); // We set to 1 Wei since we can't set to 0.

  // Give dataworker final fee bond to propose roots with:
  await setupTokensForWallet(hubPool, dataworker, [l1Token_1], null, 100);

  const { spyLogger } = createSpyLogger();
  const { configStore } = await deployConfigStore(owner, [l1Token_1, l1Token_2]);
  const hubPoolClient = new clients.HubPoolClient(spyLogger, hubPool);
  const rateModelClient = new clients.RateModelClient(spyLogger, configStore, hubPoolClient);

  const multiCallerClient = new clients.MultiCallerClient(spyLogger, null); // leave out the gasEstimator for now.
  const configStoreClient = new clients.ConfigStoreClient(
    spyLogger,
    {
      [l1Token_1.address]: defaultPoolRebalanceTokenTransferThreshold,
      [l1Token_2.address]: defaultPoolRebalanceTokenTransferThreshold,
    },
    maxRefundPerRelayerRefundLeaf,
    maxL1TokensPerPoolRebalanceLeaf
  );

  const spokePoolClient_1 = new clients.SpokePoolClient(
    spyLogger,
    spokePool_1.connect(relayer),
    rateModelClient,
    originChainId
  );
  const spokePoolClient_2 = new clients.SpokePoolClient(
    spyLogger,
    spokePool_2.connect(relayer),
    rateModelClient,
    destinationChainId
  );

  const dataworkerInstance = new Dataworker(
    spyLogger,
    {
      spokePoolClients: { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 },
      hubPoolClient,
      rateModelClient,
      multiCallerClient,
      configStoreClient,
    },
    CHAIN_ID_TEST_LIST
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
    hubPool,
    spokePool_1,
    erc20_1,
    spokePool_2,
    erc20_2,
    l1Token_1,
    l1Token_2,
    configStore,
    timer: umaEcosystem.timer,
    spokePoolClient_1,
    spokePoolClient_2,
    configStoreClient,
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
