import { ethers } from "ethers";
import assert from "assert";

const defaultConfiguredNetworks = [1, 10, 42161, 288];

export interface ProcessEnv {
  [key: string]: string | undefined;
}

export class RelayerConfig {
  readonly hubPoolAddress: string;
  readonly configuredNetworks: number[];

  constructor(env: ProcessEnv) {
    const { HUB_POOL_ADDRESS, CONFIGURED_NETWORKS } = env;
    assert(HUB_POOL_ADDRESS, "HUB_POOL_ADDRESS required");
    this.hubPoolAddress = ethers.utils.getAddress(HUB_POOL_ADDRESS);

    this.configuredNetworks = CONFIGURED_NETWORKS ? JSON.parse(CONFIGURED_NETWORKS) : defaultConfiguredNetworks;
  }
}
