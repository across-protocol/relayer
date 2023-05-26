import { setupUmaEcosystem } from "./UmaEcosystemFixture";
import {
  deploySpokePoolWithToken,
  enableRoutesOnHubPool,
  Contract,
  BigNumber,
  enableRoutes,
  sampleRateModel,
} from "../utils";
import { SignerWithAddress, setupTokensForWallet, getLastBlockTime } from "../utils";
import { createSpyLogger, winston, deployAndConfigureHubPool, deployConfigStore } from "../utils";
import * as clients from "../../src/clients";
import {
  amountToLp,
  destinationChainId as defaultDestinationChainId,
  originChainId as defaultOriginChainId,
  repaymentChainId,
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD,
} from "../constants";

import { Dataworker } from "../../src/dataworker/Dataworker"; // Tested
import { BundleDataClient, TokenClient } from "../../src/clients";
import { DataworkerClients } from "../../src/dataworker/DataworkerClientHelper";
import { MockConfigStoreClient, MockedMultiCallerClient } from "../mocks";

async function _constructSpokePoolClientsWithLookback(
  spokePools: Contract[],
  spokePoolChains: number[],
  spyLogger: winston.Logger,
  signer: SignerWithAddress,
  hubPoolClient: clients.HubPoolClient,
  lookbackForAllChains?: number,
  deploymentBlocks?: { [chainId: number]: number }
) {
  const latestBlocks = await Promise.all(spokePools.map((x) => x.provider.getBlockNumber()));
  return spokePools.map((pool, i) => {
    return new clients.SpokePoolClient(
      spyLogger,
      pool.connect(signer),
      hubPoolClient,
      spokePoolChains[i],
      deploymentBlocks && deploymentBlocks[spokePoolChains[i]],
      lookbackForAllChains === undefined ? undefined : { fromBlock: latestBlocks[i] - lookbackForAllChains }
    );
  });
}
// Sets up all contracts neccessary to build and execute leaves in dataworker merkle roots: relayer refund, slow relay,
// and pool rebalance roots.
export async function setupDataworker(
  ethers: any,
  maxRefundPerRelayerRefundLeaf: number,
  maxL1TokensPerPoolRebalanceLeaf: number,
  defaultPoolRebalanceTokenTransferThreshold: BigNumber,
  defaultEndBlockBuffer: number,
  destinationChainId = defaultDestinationChainId,
  originChainId = defaultOriginChainId,
  lookbackForAllChains?: number
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
  spokePoolClient_3: clients.SpokePoolClient;
  spokePoolClient_4: clients.SpokePoolClient;
  spokePoolClients: { [chainId: number]: clients.SpokePoolClient };
  configStoreClient: MockConfigStoreClient;
  hubPoolClient: clients.HubPoolClient;
  dataworkerInstance: Dataworker;
  spyLogger: winston.Logger;
  spy: sinon.SinonSpy;
  multiCallerClient: clients.MultiCallerClient;
  profitClient: clients.ProfitClient;
  owner: SignerWithAddress;
  depositor: SignerWithAddress;
  relayer: SignerWithAddress;
  dataworker: SignerWithAddress;
  dataworkerClients: DataworkerClients;
  updateAllClients: () => Promise<void>;
}> {
  const [owner, depositor, relayer, dataworker] = await ethers.getSigners();
  const hubPoolChainId = await owner.getChainId();

  const { spokePool: spokePool_1, erc20: erc20_1 } = await deploySpokePoolWithToken(originChainId, destinationChainId);
  const { spokePool: spokePool_2, erc20: erc20_2 } = await deploySpokePoolWithToken(destinationChainId, originChainId);
  const { spokePool: spokePool_3 } = await deploySpokePoolWithToken(repaymentChainId, hubPoolChainId);
  const { spokePool: spokePool_4 } = await deploySpokePoolWithToken(hubPoolChainId, repaymentChainId);
  const spokePoolDeploymentBlocks = {
    [originChainId]: await spokePool_1.provider.getBlockNumber(),
    [destinationChainId]: await spokePool_2.provider.getBlockNumber(),
    [repaymentChainId]: await spokePool_3.provider.getBlockNumber(),
    [hubPoolChainId]: await spokePool_4.provider.getBlockNumber(),
  };
  const testChainIdList = Object.keys(spokePoolDeploymentBlocks).map((_chainId) => Number(_chainId));

  const umaEcosystem = await setupUmaEcosystem(owner);
  const { hubPool, hubPoolDeploymentBlock, l1Token_1, l1Token_2 } = await deployAndConfigureHubPool(
    owner,
    [
      { l2ChainId: destinationChainId, spokePool: spokePool_2 },
      { l2ChainId: originChainId, spokePool: spokePool_1 },
      // Following spoke pool destinations should not be used in tests but need to be set for dataworker to fetch
      // spoke pools for those chains in proposeRootBundle
      { l2ChainId: repaymentChainId, spokePool: spokePool_3 },
      { l2ChainId: hubPoolChainId, spokePool: spokePool_4 },
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
    // Need to enable L1 token route to itself on Hub Pool so that hub pool client can look up the L1 token for
    // its own chain.
    {
      destinationChainId: hubPoolChainId,
      l1Token: l1Token_1,
      destinationToken: l1Token_1,
    },
  ]);

  // Set bond currency on hub pool so that roots can be proposed.
  await umaEcosystem.collateralWhitelist.addToWhitelist(l1Token_1.address);
  await umaEcosystem.store.setFinalFee(l1Token_1.address, { rawValue: "0" });
  await hubPool.setBond(l1Token_1.address, "1"); // We set to 1 Wei since we can't set to 0.

  // Give dataworker final fee bond to propose roots with:
  await setupTokensForWallet(hubPool, dataworker, [l1Token_1], null, 100);

  const { spyLogger, spy } = createSpyLogger();

  // Set up config store.
  const { configStore } = await deployConfigStore(
    owner,
    [l1Token_1, l1Token_2],
    maxL1TokensPerPoolRebalanceLeaf,
    maxRefundPerRelayerRefundLeaf,
    sampleRateModel,
    defaultPoolRebalanceTokenTransferThreshold
  );

  const configStoreClient = new MockConfigStoreClient(spyLogger, configStore);
  const hubPoolClient = new clients.HubPoolClient(
    spyLogger,
    hubPool,
    configStoreClient,
    hubPoolDeploymentBlock,
    hubPoolChainId
  );
  const multiCallerClient = new MockedMultiCallerClient(spyLogger); // leave out the gasEstimator for now.

  const [spokePoolClient_1, spokePoolClient_2, spokePoolClient_3, spokePoolClient_4] =
    await _constructSpokePoolClientsWithLookback(
      [spokePool_1, spokePool_2, spokePool_3, spokePool_4],
      [originChainId, destinationChainId, repaymentChainId, hubPoolChainId],
      spyLogger,
      relayer,
      hubPoolClient,
      lookbackForAllChains,
      spokePoolDeploymentBlocks
    );

  const tokenClient = new TokenClient(spyLogger, relayer.address, {}, hubPoolClient);

  // This client dictionary can be conveniently passed in root builder functions that expect mapping of clients to
  // load events from. Dataworker needs a client mapped to every chain ID set in testChainIdList.
  const spokePoolClients = {
    [originChainId]: spokePoolClient_1,
    [destinationChainId]: spokePoolClient_2,
    [repaymentChainId]: spokePoolClient_3,
    [hubPoolChainId]: spokePoolClient_4,
  };
  const profitClient = new clients.ProfitClient(spyLogger, hubPoolClient, spokePoolClients, []);
  const bundleDataClient = new BundleDataClient(
    spyLogger,
    {
      configStoreClient,
      multiCallerClient,
      hubPoolClient,
    },
    spokePoolClients,
    testChainIdList
  );

  const dataworkerClients: DataworkerClients = {
    bundleDataClient,
    tokenClient,
    hubPoolClient,
    multiCallerClient,
    configStoreClient,
    profitClient,
  };
  const dataworkerInstance = new Dataworker(
    spyLogger,
    dataworkerClients,
    testChainIdList,
    maxRefundPerRelayerRefundLeaf,
    maxL1TokensPerPoolRebalanceLeaf,
    Object.fromEntries(testChainIdList.map((chainId) => [chainId, defaultPoolRebalanceTokenTransferThreshold])),
    Object.fromEntries(testChainIdList.map((chainId) => [chainId, defaultEndBlockBuffer]))
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
    spokePoolClient_3,
    spokePoolClient_4,
    spokePoolClients,
    configStoreClient,
    hubPoolClient,
    dataworkerInstance,
    spyLogger,
    spy,
    multiCallerClient,
    profitClient,
    owner,
    depositor,
    relayer,
    dataworker,
    dataworkerClients,
    updateAllClients: async () => {
      await configStoreClient.update();
      await hubPoolClient.update();
      await profitClient.update();
      await spokePoolClient_1.update();
      await spokePoolClient_2.update();
      await spokePoolClient_3.update();
      await spokePoolClient_4.update();
    },
  };
}

// Set up Dataworker with SpokePoolClients with custom lookbacks. All other params are set to defaults.
export async function setupFastDataworker(
  ethers: any,
  lookbackForAllChains?: number
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
  spokePoolClient_3: clients.SpokePoolClient;
  spokePoolClient_4: clients.SpokePoolClient;
  spokePoolClients: { [chainId: number]: clients.SpokePoolClient };
  configStoreClient: MockConfigStoreClient;
  hubPoolClient: clients.HubPoolClient;
  dataworkerInstance: Dataworker;
  spyLogger: winston.Logger;
  spy: sinon.SinonSpy;
  multiCallerClient: clients.MultiCallerClient;
  profitClient: clients.ProfitClient;
  owner: SignerWithAddress;
  depositor: SignerWithAddress;
  relayer: SignerWithAddress;
  dataworker: SignerWithAddress;
  dataworkerClients: DataworkerClients;
  updateAllClients: () => Promise<void>;
}> {
  return await setupDataworker(
    ethers,
    MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
    MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
    DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD,
    0,
    defaultDestinationChainId,
    defaultOriginChainId,
    lookbackForAllChains
  );
}
