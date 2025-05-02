import { clients, constants, utils } from "@across-protocol/sdk";
import { Contract, EventSearchConfig, MakeOptional, isDefined, sortEventsDescending, winston } from "../utils";
import { CONFIG_STORE_VERSION } from "../common";
export const GLOBAL_CONFIG_STORE_KEYS = clients.GLOBAL_CONFIG_STORE_KEYS;

export class ConfigStoreClient extends clients.AcrossConfigStoreClient {
  private readonly injectedChain:
    | {
        chainId: number;
        blockNumber: number;
      }
    | undefined;

  constructor(
    readonly logger: winston.Logger,
    readonly configStore: Contract,
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    readonly configStoreVersion: number = CONFIG_STORE_VERSION
  ) {
    super(logger, configStore, eventSearchConfig, configStoreVersion);

    const injectedChains = process.env.INJECT_CHAIN_ID_INCLUSION;
    if (isDefined(injectedChains)) {
      // Attempt to parse the injected chains
      const { chainId: injectedChainId, blockNumber: injectedBlockNumber } = JSON.parse(injectedChains);
      // Sanity check to verify that the chain id & block number are positive integers
      if (!utils.isPositiveInteger(injectedChainId) || !utils.isPositiveInteger(injectedBlockNumber)) {
        this.logger.warn({
          at: "ConfigStoreClient#constructor",
          message: `Invalid injected chain id inclusion: ${injectedChains}`,
        });
      }
      this.injectedChain = {
        chainId: injectedChainId,
        blockNumber: injectedBlockNumber,
      };
    }
  }

  async update(): Promise<void> {
    // We know that as we move forward in time, the injected chain id inclusion will
    // eventually outdate the latest block number. Therefore, we want to remove the
    // injected chain id inclusion from the chain id indices updates before we call
    // the super update function. This is to prevent the injected chain id inclusion
    // from issuing an error. We will re-add the injected chain id inclusion after
    // in the overloaded _.update() function.
    if (isDefined(this.injectedChain)) {
      // Track the initial length of the chain id indices updates
      const initialLength = this.chainIdIndicesUpdates.length;
      // Because this chain is `injected` we know that it doesn't occur
      // on-chain, and therefore we just need to remove it altogether
      // wherever an instance of it appears.
      this.chainIdIndicesUpdates = this.chainIdIndicesUpdates.filter(
        ({ value }) => !value.includes(this.injectedChain.chainId)
      );
      if (this.chainIdIndicesUpdates.length !== initialLength) {
        this.logger.debug({
          at: "ConfigStore[Relayer]#update",
          message: "Removed injected chain id inclusion from chain id indices updates",
          injectedChain: this.injectedChain,
        });
      }
    }
    await super.update();

    if (isDefined(this.injectedChain)) {
      const { chainId: injectedChainId, blockNumber: injectedBlockNumber } = this.injectedChain;
      // Sanity check to ensure that this event doesn't happen in the future
      if (injectedBlockNumber > this.latestBlockSearched) {
        this.logger.debug({
          at: "ConfigStore[Relayer]#update",
          message: `Injected block number ${injectedBlockNumber} is greater than the latest block number ${this.latestBlockSearched}`,
        });
        return;
      }
      // Sanity check to ensure that the injected chain id is not already included
      if (this.chainIdIndicesUpdates.some(({ value }) => value.includes(injectedChainId))) {
        this.logger.debug({
          at: "ConfigStore[Relayer]#update",
          message: `Injected chain id ${injectedChainId} is already included`,
        });
        return;
      }

      // Partially create the meta-data information regarding the injected chain id inclusion
      const partialChainIdIndicesUpdate = {
        blockNumber: injectedBlockNumber,
        txnIndex: 0,
        logIndex: 0,
        txnRef: "",
      };

      // We need to now resolve the last chain id indices update
      const lastChainIdIndicesUpdate = sortEventsDescending(this.chainIdIndicesUpdates)?.[0];
      if (!isDefined(lastChainIdIndicesUpdate)) {
        this.chainIdIndicesUpdates.push({
          ...partialChainIdIndicesUpdate,
          value: [...constants.PROTOCOL_DEFAULT_CHAIN_ID_INDICES, injectedChainId],
        });
      } else {
        // Sanity check to ensure that the injected chain id is after the last chain id indices update
        if (lastChainIdIndicesUpdate.blockNumber > injectedBlockNumber) {
          this.logger.debug({
            at: "ConfigStore[Relayer]#update",
            message: `Injected block number ${injectedBlockNumber} is before the last chain id indices update ${lastChainIdIndicesUpdate.blockNumber}`,
          });
          return;
        }
        // We can now add the injected chain id to the last chain id indices update
        this.chainIdIndicesUpdates.push({
          ...partialChainIdIndicesUpdate,
          value: [...lastChainIdIndicesUpdate.value, injectedChainId],
        });
      }
    }
  }
}
