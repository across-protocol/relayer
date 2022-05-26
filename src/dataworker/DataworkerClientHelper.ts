import winston from "winston";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  Clients,
  constructClients,
  constructSpokePoolClientsForBlockAndUpdate,
  getSpokePoolSigners,
  updateClients,
} from "../common";
import { EventSearchConfig, getDeploymentBlockNumber, getSigner, Wallet, ethers } from "../utils";
import { SpokePoolClient, TokenClient } from "../clients";
import { getWidestPossibleExpectedBlockRange } from "./PoolRebalanceUtils";
import { getBlockRangeForChain } from "./DataworkerUtils";

export interface DataworkerClients extends Clients {
  tokenClient: TokenClient;
  spokePoolSigners: { [chainId: number]: Wallet };
  spokePoolClientSearchSettings: { [chainId: number]: EventSearchConfig };
}

export async function constructDataworkerClients(
  logger: winston.Logger,
  config: DataworkerConfig
): Promise<DataworkerClients> {
  const commonClients = await constructClients(logger, config);
  const baseSigner = await getSigner();

  // We don't pass any spoke pool clients to token client since data worker doesn't need to set approvals for L2 tokens.
  const tokenClient = new TokenClient(logger, baseSigner.address, {}, commonClients.hubPoolClient);
  const spokePoolSigners = getSpokePoolSigners(baseSigner, config);
  const spokePoolClientSearchSettings = Object.fromEntries(
    config.spokePoolChains.map((chainId) => {
      return [
        chainId,
        {
          fromBlock: Number(getDeploymentBlockNumber("SpokePool", chainId)),
          toBlock: null,
          maxBlockLookBack: config.maxBlockLookBack[chainId],
        },
      ];
    })
  );

  return { ...commonClients, tokenClient, spokePoolSigners, spokePoolClientSearchSettings };
}

export async function updateDataworkerClients(clients: DataworkerClients) {
  await updateClients(clients);

  // Token client needs updated hub pool client to pull bond token data.
  await clients.tokenClient.update();

  // Run approval on hub pool.
  await clients.tokenClient.setBondTokenAllowance();
}

export async function constructSpokePoolClientsForPendingRootBundle(
  logger: winston.Logger,
  chainIdListForBundleEvaluationBlockNumbers: number[],
  endBlockBuffers: number[],
  clients: DataworkerClients
) {
  const widestPossibleExpectedBlockRange = await getWidestPossibleExpectedBlockRange(
    chainIdListForBundleEvaluationBlockNumbers,
    endBlockBuffers,
    clients,
    clients.hubPoolClient.latestBlockNumber
  );
  const { hasPendingProposal, pendingRootBundle } = clients.hubPoolClient.getPendingRootBundleIfAvailable();
  let blockRangesImpliedByBundleEndBlocks: number[][];
  let endBlockForMainnet: number;
  let spokePoolClients: { [chainId: number]: SpokePoolClient };
  if (hasPendingProposal) {
    // The block range that we'll use to reconstruct the pending roots will be the end block specified in the
    // pending root bundle, and the block right after the last valid root bundle proposal's end block.
    // If the proposer didn't use the same start block, then they might have missed events and the roots will
    // be different. We'll need to reconstruct these block ranges for the validator and executor.
    if (pendingRootBundle.bundleEvaluationBlockNumbers)
      blockRangesImpliedByBundleEndBlocks = widestPossibleExpectedBlockRange.map((blockRange, index) => [
        blockRange[0],
        pendingRootBundle.bundleEvaluationBlockNumbers[index],
      ]);
    // Construct spoke pool clients using spoke pools deployed at end of block range.
    // We do make an assumption that the spoke pool contract was not changed during the block range. By using the
    // spoke pool at this block instead of assuming its the currently deployed one, we can pay refunds for deposits
    // on deprecated spoke pools.
    if (blockRangesImpliedByBundleEndBlocks) {
      endBlockForMainnet = getBlockRangeForChain(
        blockRangesImpliedByBundleEndBlocks,
        1,
        chainIdListForBundleEvaluationBlockNumbers
      )[1];
      spokePoolClients = await constructSpokePoolClientsForBlockAndUpdate(
        chainIdListForBundleEvaluationBlockNumbers,
        clients,
        logger,
        endBlockForMainnet
      );
    }
  }

  return spokePoolClients;
}

export function spokePoolClientsToProviders(spokePoolClients: { [chainId: number]: SpokePoolClient }): {
  [chainId: number]: ethers.providers.Provider;
} {
  return Object.fromEntries(
    Object.entries(spokePoolClients).map(([chainId, client]) => [Number(chainId), client.spokePool.signer.provider!])
  );
}
