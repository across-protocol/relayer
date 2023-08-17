import { clients, constants, utils } from "@across-protocol/sdk-v2";
import { Contract, Event, EventSearchConfig, MakeOptional, isDefined, sortEventsDescending, winston } from "../utils";
import { Result } from "@ethersproject/abi";
export const { UBA_MIN_CONFIG_STORE_VERSION } = utils;
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
    readonly configStoreVersion: number
  ) {
    super(logger, configStore, eventSearchConfig, configStoreVersion);

    const injectedChains = process.env.INJECT_CHAIN_ID_INCLUSION;
    if (isDefined(injectedChains)) {
      // Attempt to parse the injected chains
      const { chainId: injectedChainId, blockNumber: injectedBlockNumber } = JSON.parse(injectedChains);
      // Sanity check to verify that the chain id & block number are positive integers
      if (!utils.isPositiveInteger(injectedChainId) || !utils.isPositiveInteger(injectedBlockNumber)) {
        this.logger.warn({
          at: "ConfigStore[Relayer]#constructor",
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
    console.log("RELAHER_UPDATE");

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
    console.log(this.chainIdIndicesUpdates);
    console.log("########################&&&&&&##########################");
  }

  protected async _update(): Promise<clients.ConfigStoreUpdate> {
    // We want to call the update function regardless to mimic this behavior
    const update = await super._update();
    // If the update was successful & chains is defined
    if (update.success && isDefined(this.injectedChain)) {
      const { chainId: injectedChainId, blockNumber: injectedBlockNumber } = this.injectedChain;
      try {
        // Sanity check to verify that the injected block number is not greater than
        // the latest block number
        const maxBlockNumber = update.latestBlockNumber;
        if (maxBlockNumber < injectedBlockNumber) {
          throw new Error(
            `Injected block number ${injectedBlockNumber} is greater than the latest block number ${maxBlockNumber}`
          );
        }
        const chainIndicesUpdates = update.events.updatedGlobalConfigEvents.filter(
          ({ args }) => args?.key === utils.utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.CHAIN_ID_INDICES)
        );

        // Sanity check to verify that the injected chain id is not already included
        if (chainIndicesUpdates.some(({ args }) => args?.value.includes(injectedChainId))) {
          throw new Error(`Injected chain id ${injectedChainId} is already included`);
        }

        // Resolve the last global chain update
        const lastGlobalChainUpdate = sortEventsDescending(chainIndicesUpdates)?.[0];

        console.log(JSON.stringify(lastGlobalChainUpdate, null, 2));

        // Sanity check to verify that the injected chain is after the last global chain update
        if (isDefined(lastGlobalChainUpdate) && lastGlobalChainUpdate.blockNumber > injectedBlockNumber) {
          throw new Error(
            `Injected block number ${injectedBlockNumber} is before the last global chain update ${lastGlobalChainUpdate.blockNumber}`
          );
        }

        // Resolve the last global chain indices
        const lastGlobalChainIndices = JSON.parse(
          String(
            lastGlobalChainUpdate?.args?.value ?? JSON.stringify(constants.PROTOCOL_DEFAULT_CHAIN_ID_INDICES)
          ).replaceAll('"', "")
        ) as number[];

        // Inject the chain id into the last global chain indices
        const injectedChainIndices = [...lastGlobalChainIndices, injectedChainId];

        // Injected args to include
        const injectedArgs = {
          0: utils.utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.CHAIN_ID_INDICES),
          1: JSON.stringify(injectedChainIndices),
          key: utils.utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.CHAIN_ID_INDICES),
          value: JSON.stringify(injectedChainIndices),
        };

        // If we made it this far, then we can safely inject the chain id into the global config store
        update.events.updatedGlobalConfigEvents.push({
          blockNumber: injectedBlockNumber,
          transactionIndex: 0,
          logIndex: 0,
          args: injectedArgs as unknown as Result,
        } as Event);

        // Resolve the block timestamp of the injected block number
        const injectedBlockTimestamp = await this.configStore.provider
          .getBlock(injectedBlockNumber)
          .then(({ timestamp }) => timestamp);

        // Inject the block timestamp into the global config store's updated times
        update.events.globalConfigUpdateTimes.push(injectedBlockTimestamp);
      } catch (e) {
        this.logger.warn({
          at: "ConfigStore[Relayer]#_update",
          message: `Invalid injected chain id inclusion: ${JSON.stringify(this.injectedChain)}`,
          e: String(e),
        });
      }
    }
    return update;
  }
}
