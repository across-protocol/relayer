import { clients, utils } from "@across-protocol/sdk-v2";
import { Event, isDefined, sortEventsDescending } from "../utils";
import { Result } from "@ethersproject/abi";
export const { UBA_MIN_CONFIG_STORE_VERSION } = utils;
export const GLOBAL_CONFIG_STORE_KEYS = clients.GLOBAL_CONFIG_STORE_KEYS;

export class ConfigStoreClient extends clients.AcrossConfigStoreClient {
  protected async _update(): Promise<clients.ConfigStoreUpdate> {
    // We want to call the update function regardless to mimic this behavior
    const update = await super._update();
    const injectedChains = process.env.INJECT_CHAIN_ID_INCLUSION;
    // If the update was successful & chains is defined
    if (update.success && isDefined(injectedChains)) {
      try {
        // Attempt to parse the injected chains
        const { injectedChainId, injectedBlockNumber } = JSON.parse(injectedChains);
        // Sanity check to verify that the chain id & block number are positive integers
        if (!utils.isPositiveInteger(injectedChainId) || !utils.isPositiveInteger(injectedBlockNumber)) {
          throw new Error("Invalid injected chain id inclusion");
        }
        // Sanity check to verify that the injected block number is not greater than
        // the latest block number
        const maxBlockNumber = update.latestBlockNumber;
        if (maxBlockNumber < injectedBlockNumber) {
          throw new Error(
            `Injected block number ${injectedBlockNumber} is greater than the latest block number ${maxBlockNumber}`
          );
        }
        // Sanity check to verify that the injected chain id is not already included
        if (
          update.events.updatedGlobalConfigEvents.some(
            ({ args }) =>
              args?.key === utils.utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.CHAIN_ID_INDICES) &&
              args?.value.includes(injectedChainId)
          )
        ) {
          throw new Error(`Injected chain id ${injectedChainId} is already included`);
        }

        // Resolve the last global chain update
        const lastGlobalChainUpdate = sortEventsDescending(update.events.updatedGlobalConfigEvents).find(
          ({ args }) => args?.key === utils.utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.CHAIN_ID_INDICES)
        );
        const lastGlobalChainUpdateArgs = lastGlobalChainUpdate?.args;
        // Sanity check to verify that there is a last global chain update
        // We know that the update was successful, so this should always be defined as this is a ground truth
        if (!isDefined(lastGlobalChainUpdate) || !isDefined(lastGlobalChainUpdateArgs)) {
          throw new Error("No last global chain id indices update exists");
        }
        // Sanity check to verify that the injected chain is after the last global chain update
        if (lastGlobalChainUpdate.blockNumber > maxBlockNumber) {
          throw new Error(
            `Injected block number ${injectedBlockNumber} is before the last global chain update ${lastGlobalChainUpdate.blockNumber}`
          );
        }

        // Resolve the last global chain indices
        const lastGlobalChainIndices = JSON.parse(lastGlobalChainUpdateArgs.value) as number[];

        // If we made it this far, then we can safely inject the chain id into the global config store
        update.events.updatedGlobalConfigEvents.push({
          blockNumber: injectedBlockNumber,
          transactionIndex: 0,
          logIndex: 0,
          args: {
            ...lastGlobalChainUpdateArgs,
            key: utils.utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.CHAIN_ID_INDICES),
            value: JSON.stringify([...lastGlobalChainIndices, injectedChainId]),
          } as unknown as Result,
        } as Event);
      } catch (e) {
        this.logger.warn({
          at: "ConfigStore[Relayer]#_update",
          message: `Invalid injected chain id inclusion: ${injectedChains}`,
          e,
        });
      }
    }
    return update;
  }
}
