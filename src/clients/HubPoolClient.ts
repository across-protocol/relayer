import { clients, interfaces } from "@across-protocol/sdk-v2";
import { Contract } from "ethers";
import winston from "winston";
import { MakeOptional, EventSearchConfig, isDefined } from "../utils";
import { IGNORED_HUB_EXECUTED_BUNDLES, IGNORED_HUB_PROPOSED_BUNDLES } from "../common";
import { DepositWithBlock } from "../interfaces";

export class HubPoolClient extends clients.HubPoolClient {
  constructor(
    logger: winston.Logger,
    hubPool: Contract,
    configStoreClient: clients.AcrossConfigStoreClient,
    deploymentBlock?: number,
    chainId = 1,
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    cachingMechanism?: interfaces.CachingMechanismInterface,
    timeToCache?: number,
    customSpokeAddresses?: Record<number, { address: string; registrationBlock: number }>
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
    // We can insert the custom spoke entry directly into the crossChainContracts map
    // because the HubPoolClient strictly appends data. Additionally, we can place this
    // entry at the "0th" block so that it is always used & will be overwritten by any
    // future entries resolved by the HubPool.
    if (isDefined(customSpokeAddresses)) {
      Object.entries(customSpokeAddresses).forEach(([_l2ChainId, { address }]) => {
        const l2ChainId = Number(_l2ChainId);
        this.crossChainContracts[l2ChainId] = [
          {
            l2ChainId,
            spokePool: address,
            blockNumber: 0,
            logIndex: 0,
            transactionHash: "",
            transactionIndex: 0,
          },
        ];
      });
      if (Object.keys(customSpokeAddresses).length > 0) {
        this.logger.info({
          at: "HubPoolClient#constructor",
          message: "HubPoolClient using custom SpokeAddresses.",
          customSpokeAddresses,
        });
      }
    }
  }

  async computeRealizedLpFeePct(
    deposit: Pick<
      DepositWithBlock,
      "quoteTimestamp" | "amount" | "originChainId" | "originToken" | "destinationChainId" | "blockNumber"
    >
  ): Promise<interfaces.RealizedLpFee> {
    if (deposit.quoteTimestamp > this.currentTime) {
      throw new Error(
        `Cannot compute lp fee percent for quote timestamp ${deposit.quoteTimestamp} in the future. Current time: ${this.currentTime}.`
      );
    }

    return await super.computeRealizedLpFeePct(deposit);
  }
}
