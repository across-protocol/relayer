import { clients, utils } from "@across-protocol/sdk-v2";
import { utils as ethersUtils } from "ethers";
import { Contract } from "ethers";
import winston from "winston";
import { MakeOptional, EventSearchConfig, isDefined, assign } from "../utils";
import { IGNORED_HUB_EXECUTED_BUNDLES, IGNORED_HUB_PROPOSED_BUNDLES } from "../common";

export class HubPoolClient extends clients.HubPoolClient {
  private readonly injectedContract:
    | {
        blockNumber: number;
        chainId: string;
        spokeAddress: string;
      }
    | undefined;

  constructor(
    logger: winston.Logger,
    hubPool: Contract,
    configStoreClient: clients.AcrossConfigStoreClient,
    deploymentBlock?: number,
    chainId = 1,
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 }
  ) {
    super(logger, hubPool, configStoreClient, deploymentBlock, chainId, eventSearchConfig, {
      ignoredHubExecutedBundles: IGNORED_HUB_EXECUTED_BUNDLES,
      ignoredHubProposedBundles: IGNORED_HUB_PROPOSED_BUNDLES,
    });

    const injectedContract = process.env.INJECT_CROSS_CHAIN_CONTRACT_INCLUSION;
    if (isDefined(injectedContract)) {
      // Attempt to parse the injected contract
      const {
        spokeAddress: injectedSpokeAddress,
        blockNumber: injectedBlockNumber,
        chainId: injectedChainId,
      } = JSON.parse(injectedContract);
      // Sanity check to verify that the chain id & block number are positive
      // integers && spokeAddress is a valid address
      if (
        !ethersUtils.isAddress(injectedSpokeAddress) ||
        !utils.isPositiveInteger(injectedChainId) ||
        !utils.isPositiveInteger(injectedBlockNumber)
      ) {
        this.logger.warn({
          at: "ConfigStore[Relayer]#constructor",
          message: `Invalid injected contract: ${injectedContract}`,
        });
      }
      this.injectedContract = {
        chainId: injectedChainId,
        blockNumber: injectedBlockNumber,
        spokeAddress: injectedSpokeAddress,
      };
    }
  }

  async update(): Promise<void> {
    // We want to first sanitize our injected contract before we call the super
    // update function. This is to prevent the injected contract from issuing
    // an error. We will re-add the injected contract after in the overloaded
    // update() function.
    if (isDefined(this.injectedContract)) {
      // We should check the inclusion of the injected contract details
      // in the cross chain contracts before we remove it from the
      // cross chain contracts.
      if (Object.keys(this.crossChainContracts).includes(this.injectedContract.chainId)) {
        // We know that the injected contract is included in the cross chain
        // contracts, so we can remove it from the cross chain contracts.
        delete this.crossChainContracts[this.injectedContract.chainId];
      }
    }

    await super.update();

    // We want to re-add the injected contract to the cross chain contracts
    // after we have called the super update function.
    if (isDefined(this.injectedContract)) {
      // We know that the injected contract is not included in the cross chain
      // contracts, so we can add it to the cross chain contracts.
      assign(
        this.crossChainContracts,
        [this.injectedContract.chainId],
        [
          {
            spokePool: this.injectedContract.spokeAddress,
            blockNumber: this.injectedContract.blockNumber,
            transactionIndex: 0,
            logIndex: 0,
          },
        ]
      );
    }
  }
}
