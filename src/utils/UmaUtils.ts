import { Contract, ethers, getBlockForTimestamp, getCurrentTime, isEventOlder, sortEventsDescending } from ".";
import * as uma from "@uma/contracts-node";
import { AcrossConfigStoreClient } from "../clients";
import { ProposedRootBundle, SortableEvent } from "../interfaces";

export async function getDvmContract(mainnetProvider: ethers.providers.Provider): Promise<Contract> {
  return new Contract(await uma.getVotingAddress(1), uma.getAbi("Voting"), mainnetProvider);
}
export async function getDisputedProposal(
  dvm: Contract,
  configStoreClient: AcrossConfigStoreClient,
  disputeRequestTimestamp: number,
  disputeRequestBlock?: number
): Promise<ProposedRootBundle> {
  const filter = dvm.filters.PriceRequestAdded();
  const priceRequestBlock =
    disputeRequestBlock !== undefined
      ? disputeRequestBlock
      : await getBlockForTimestamp(
          configStoreClient.hubPoolClient.chainId,
          configStoreClient.hubPoolClient.chainId,
          disputeRequestTimestamp,
          getCurrentTime(),
          configStoreClient.blockFinder,
          configStoreClient.redisClient
        );
  const disputes = await dvm.queryFilter(filter, priceRequestBlock, priceRequestBlock);
  const dispute = disputes.find((e) => e.args.time.toString() === disputeRequestTimestamp.toString());
  if (!dispute) throw new Error("Could not find PriceRequestAdded event on DVM matching price request time");
  return sortEventsDescending(configStoreClient.hubPoolClient.getProposedRootBundles()).find((e) =>
    isEventOlder(e as SortableEvent, dispute as SortableEvent)
  );
}
