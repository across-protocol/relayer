import { Contract, ethers, getBlockForTimestamp, getCurrentTime, isEventOlder, sortEventsDescending } from ".";
import * as uma from "@uma/contracts-node";
import { AcrossConfigStoreClient } from "../clients";
import { ProposedRootBundle, SortableEvent } from "../interfaces";

export async function getDvmContract(mainnetProvider: ethers.providers.Provider): Promise<Contract> {
  return new Contract(await uma.getVotingV2Address(1), uma.getAbi("VotingV2"), mainnetProvider);
}
export function getDisputedProposal(
  configStoreClient: AcrossConfigStoreClient,
  disputeEvent: SortableEvent
): ProposedRootBundle | undefined {
  return sortEventsDescending(configStoreClient.hubPoolClient.getProposedRootBundles()).find((e) =>
    isEventOlder(e as SortableEvent, disputeEvent)
  );
}

export async function getDisputeForTimestamp(
  dvm: Contract,
  configStoreClient: AcrossConfigStoreClient,
  disputeRequestTimestamp: number,
  disputeRequestBlock?: number
): Promise<SortableEvent | undefined> {
  const filter = dvm.filters.RequestAdded();
  const priceRequestBlock =
    disputeRequestBlock !== undefined
      ? disputeRequestBlock
      : await getBlockForTimestamp(
          configStoreClient.hubPoolClient.chainId,
          configStoreClient.hubPoolClient.chainId,
          disputeRequestTimestamp,
          getCurrentTime()
        );
  const disputes = await dvm.queryFilter(filter, priceRequestBlock, priceRequestBlock);
  return disputes.find((e) => e.args.time.toString() === disputeRequestTimestamp.toString()) as SortableEvent;
}
