import { clients, interfaces, utils } from "@across-protocol/sdk";
import { Contract } from "ethers";
import winston from "winston";
import { CHAIN_IDs, MakeOptional, EventSearchConfig, assign, isDefined, toBytes32 } from "../utils";
import { IGNORED_HUB_EXECUTED_BUNDLES, IGNORED_HUB_PROPOSED_BUNDLES } from "../common";
import { CrossChainContractsSet } from "../interfaces";
import { zeroAddress } from "viem";

export type LpFeeRequest = clients.LpFeeRequest;

export class HubPoolClient extends clients.HubPoolClient {
  private readonly injectedChain:
    | {
        chainId: number;
        blockNumber: number;
        spokePool: string;
      }
    | undefined;

  constructor(
    logger: winston.Logger,
    hubPool: Contract,
    configStoreClient: clients.AcrossConfigStoreClient,
    deploymentBlock?: number,
    chainId = CHAIN_IDs.MAINNET,
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
    const injectedChains = process.env.INJECT_CHAIN_ID_INCLUSION;
    if (isDefined(injectedChains)) {
      // Attempt to parse the injected chains
      const { chainId: injectedChainId, blockNumber: injectedBlockNumber, spokePool } = JSON.parse(injectedChains);
      // Sanity check to verify that the chain id & block number are positive integers
      if (!utils.isPositiveInteger(injectedChainId) || !utils.isPositiveInteger(injectedBlockNumber) || !spokePool) {
        this.logger.warn({
          at: "HubPoolClient#Constructor",
          message: `Invalid injected chain id inclusion: ${injectedChains}`,
        });
      }
      this.injectedChain = {
        chainId: injectedChainId,
        blockNumber: injectedBlockNumber,
        spokePool,
      };
    }
  }

  async computeRealizedLpFeePct(deposit: LpFeeRequest): Promise<interfaces.RealizedLpFee> {
    if (deposit.quoteTimestamp > this.currentTime) {
      throw new Error(
        `Cannot compute lp fee percent for quote timestamp ${deposit.quoteTimestamp} in the future. Current time: ${this.currentTime}.`
      );
    }

    return await super.computeRealizedLpFeePct(deposit);
  }

  async update(eventsToQuery?: any): Promise<void> {
    if (isDefined(this.injectedChain)) {
      const dataToAdd: CrossChainContractsSet = {
        spokePool: this.injectedChain.spokePool,
        blockNumber: this.injectedChain.blockNumber,
        txnRef: toBytes32(zeroAddress),
        logIndex: 0,
        txnIndex: 0,
        l2ChainId: this.injectedChain.chainId,
      };
      assign(this.crossChainContracts, [this.injectedChain.chainId], [dataToAdd]);
    }
    await super.update(eventsToQuery);
  }
}
