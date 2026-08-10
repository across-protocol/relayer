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

  // Set once an on-chain CHAIN_ID_INDICES update supersedes the injected chain, so that the
  // override is logged loudly but only once per process rather than on every update cycle.
  private injectionSuperseded = false;

  constructor(
    readonly logger: winston.Logger,
    readonly configStore: Contract,
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "to"> = { from: 0, maxLookBack: 0 },
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
    const { injectedChain } = this;
    if (isDefined(injectedChain)) {
      // Track the initial length of the chain id indices updates
      const initialLength = this.chainIdIndicesUpdates.length;
      // Identify the synthetic entry by the marker this class stamps on it below (an empty txnRef at
      // the injected block number), not by chain ID membership. CHAIN_ID_INDICES is append-only, so
      // once the chain is genuinely onboarded a real on-chain update will also contain
      // injectedChain.chainId; a membership test would delete that real event, and super.update()
      // cannot restore it because its search window has already advanced past that block.
      this.chainIdIndicesUpdates = this.chainIdIndicesUpdates.filter(
        ({ txnRef, blockNumber }) => !(txnRef === "" && blockNumber === injectedChain.blockNumber)
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
      if (injectedBlockNumber > this.latestHeightSearched) {
        this.logger.debug({
          at: "ConfigStore[Relayer]#update",
          message: `Injected block number ${injectedBlockNumber} is greater than the latest block number ${this.latestHeightSearched}`,
        });
        return;
      }
      // The injected chain is already present in an on-chain CHAIN_ID_INDICES update. That key is
      // append-only, so a chain can never be appended to it twice: the on-chain event is authoritative
      // and supersedes the locally-configured injection. Leave the real update in place and stop
      // injecting. Log this loudly (once) because it means INJECT_CHAIN_ID_INCLUSION is now stale.
      if (this.chainIdIndicesUpdates.some(({ value }) => value.includes(injectedChainId))) {
        if (!this.injectionSuperseded) {
          this.injectionSuperseded = true;
          this.logger.warn({
            at: "ConfigStore[Relayer]#update",
            message:
              `On-chain CHAIN_ID_INDICES update already includes injected chain ${injectedChainId}; ` +
              "the on-chain config overrides INJECT_CHAIN_ID_INCLUSION, which should now be unset. " +
              "This variable is for testing only and must not be set in production.",
            injectedChain: this.injectedChain,
          });
        }
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
