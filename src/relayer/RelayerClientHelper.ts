import winston from "winston";
import { getSigner } from "../utils";
import { TokenClient, ProfitClient, SpokePoolClient, InventoryClient, AdapterManager } from "../clients";
import { RelayerConfig } from "./RelayerConfig";
import { Clients, constructClients, updateClients, updateSpokePoolClients } from "../common";
import { SpokePoolClientsByChain } from "../interfaces";
import { constructSpokePoolClientsWithLookback } from "../common";

export interface RelayerClients extends Clients {
  spokePoolClients: SpokePoolClientsByChain;
  tokenClient: TokenClient;
  profitClient: ProfitClient;
  inventoryClient: InventoryClient;
}

export async function constructRelayerClients(logger: winston.Logger, config: RelayerConfig): Promise<RelayerClients> {
  const baseSigner = await getSigner();

  const commonClients = await constructClients(logger, config);

  const spokePoolClients = await constructSpokePoolClientsWithLookback(
    logger,
    commonClients.configStoreClient,
    config,
    baseSigner,
    config.maxRelayerLookBack
  );

  const tokenClient = new TokenClient(logger, baseSigner.address, spokePoolClients, commonClients.hubPoolClient);

  const profitClient = new ProfitClient(logger, commonClients.hubPoolClient, config.relayerDiscount);

  const adapterManager = new AdapterManager(logger, spokePoolClients, commonClients.hubPoolClient, baseSigner.address);

  const inventoryClient = new InventoryClient(
    logger,
    config.inventoryConfig,
    tokenClient,
    config.spokePoolChains,
    commonClients.hubPoolClient,
    adapterManager
  );

  return { ...commonClients, spokePoolClients, tokenClient, profitClient, inventoryClient };
}

export async function updateRelayerClients(clients: RelayerClients) {
  await updateClients(clients);
  // SpokePoolClient client requires up to date HubPoolClient and ConfigStore client.

  // TODO: the code below can be refined by grouping with promise.all. however you need to consider the inter
  // dependencies of the clients. some clients need to be updated before others. when doing this refactor consider
  // having a "first run" update and then a "normal" update that considers this. see previous implementation here
  // https://github.com/across-protocol/relayer-v2/pull/37/files#r883371256 as a reference.
  await updateSpokePoolClients(clients.spokePoolClients);

  // Update the token client first so that inventory client has latest balances.

  await clients.tokenClient.update();

  // We can update the inventory client at the same time as checking for eth wrapping as these do not depend on each other.
  await Promise.all([
    clients.inventoryClient.update(),
    clients.inventoryClient.wrapL2EthIfAboveThreshold(),
    clients.inventoryClient.setL1TokenApprovals(),
  ]);

  // Update the token client after the inventory client has done its wrapping of L2 ETH to ensure latest WETH ballance.
  await clients.tokenClient.update();
  await clients.tokenClient.setOriginTokenApprovals(); // Run approval check  after updating token clients as needs route data.
}
