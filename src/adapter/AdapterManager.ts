import { isDefined, winston, CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "../utils";
import { SpokePoolClient, HubPoolClient } from "../clients";
import { BaseChainAdapter } from "./";
import { SUPPORTED_TOKENS, CUSTOM_BRIDGE, CANONICAL_BRIDGE, DEFAULT_GAS_MULTIPLIER } from "../common";

import { AdapterManager } from "../clients/bridges";

export class GenericAdapterManager extends AdapterManager {
  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient,
    readonly monitoredAddresses: string[]
  ) {
    super(logger, spokePoolClients, hubPoolClient, monitoredAddresses);
    if (!spokePoolClients) {
      return;
    }
    const spokePoolAddresses = Object.values(spokePoolClients).map((client) => client.spokePool.address);
    const hubChainId = this.hubPoolClient.chainId;

    // The adapters are only set up to monitor EOA's and the HubPool and SpokePool address, so remove
    // spoke pool addresses from other chains.
    const filterMonitoredAddresses = (chainId: number) => {
      return monitoredAddresses.filter(
        (address) =>
          this.hubPoolClient.hubPool.address === address ||
          this.spokePoolClients[chainId].spokePool.address === address ||
          !spokePoolAddresses.includes(address)
      );
    };

    const l1Signer = spokePoolClients[hubChainId].spokePool.signer;

    Object.values(CHAIN_IDs)
      .filter((chainId) => isDefined(this.spokePoolClients[chainId]) && chainId !== hubChainId)
      .map((chainId) => {
        // First, fetch all the bridges associated with the chain.
        const bridges = {};
        const l2Signer = spokePoolClients[chainId].spokePool.signer;

        SUPPORTED_TOKENS[chainId]?.map((symbol) => {
          const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[hubChainId];
          const bridgeConstructor = CUSTOM_BRIDGE[chainId][l1Token] ?? CANONICAL_BRIDGE[chainId];

          bridges[l1Token] = new bridgeConstructor(chainId, hubChainId, l1Signer, l2Signer, l1Token);
        });

        // Then instantiate a generic adapter.
        this.adapters[chainId] = new BaseChainAdapter(
          spokePoolClients,
          chainId,
          hubChainId,
          filterMonitoredAddresses(chainId),
          logger,
          SUPPORTED_TOKENS[chainId],
          bridges,
          DEFAULT_GAS_MULTIPLIER[chainId] ?? 1
        );
      });

    logger.debug({
      at: "AdapterManager#constructor",
      message: "Initialized AdapterManager",
      adapterChains: Object.keys(this.adapters).map((chainId) => chainId),
    });
  }
}
