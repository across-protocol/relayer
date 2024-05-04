import { clients, interfaces } from "@across-protocol/sdk-v2";
import { Contract } from "ethers";
import winston from "winston";
import { MakeOptional, EventSearchConfig, getTokenInfo, getL1TokenInfo } from "../utils";
import { IGNORED_HUB_EXECUTED_BUNDLES, IGNORED_HUB_PROPOSED_BUNDLES } from "../common";
import { L1Token } from "../interfaces";

export type LpFeeRequest = clients.LpFeeRequest;

export class HubPoolClient extends clients.HubPoolClient {
  constructor(
    logger: winston.Logger,
    hubPool: Contract,
    configStoreClient: clients.AcrossConfigStoreClient,
    deploymentBlock?: number,
    chainId = 1,
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    cachingMechanism?: interfaces.CachingMechanismInterface,
    timeToCache?: number
  ) {
    super(
      logger,
      hubPool,
      configStoreClient,
      deploymentBlock,
      chainId,
      eventSearchConfig,
      {
        ignoredHubExecutedBundles: IGNORED_HUB_EXECUTED_BUNDLES,
        ignoredHubProposedBundles: IGNORED_HUB_PROPOSED_BUNDLES,
        timeToCache,
      },
      cachingMechanism
    );
  }

  /**
   * @dev If tokenAddress + chain do not exist in TOKEN_SYMBOLS_MAP then this will throw.
   * @param tokenAddress Token address on `chain`
   * @param chain Chain where the `tokenAddress` exists in TOKEN_SYMBOLS_MAP.
   * @returns Token info for the given token address on the L2 chain including symbol and decimal.
   */
  getTokenInfoForAddress(tokenAddress: string, chain: number): L1Token {
    return getTokenInfo(tokenAddress, chain);
  }

  /**
   * @dev If tokenAddress + chain do not exist in TOKEN_SYMBOLS_MAP then this will throw.
   * @dev if the token matched in TOKEN_SYMBOLS_MAP does not have an L1 token address then this will throw.
   * @param tokenAddress Token address on `chain`
   * @param chain Chain where the `tokenAddress` exists in TOKEN_SYMBOLS_MAP.
   * @returns Token info for the given token address on the Hub chain including symbol and decimal and L1 address.
   */
  getL1TokenInfoForAddress(tokenAddress: string, chain: number): L1Token {
    return getL1TokenInfo(tokenAddress, chain);
  }

  async computeRealizedLpFeePct(deposit: LpFeeRequest): Promise<interfaces.RealizedLpFee> {
    if (deposit.quoteTimestamp > this.currentTime) {
      throw new Error(
        `Cannot compute lp fee percent for quote timestamp ${deposit.quoteTimestamp} in the future. Current time: ${this.currentTime}.`
      );
    }

    return await super.computeRealizedLpFeePct(deposit);
  }
}
