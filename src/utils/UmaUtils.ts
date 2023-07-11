import { Contract, ethers, getBlockForTimestamp, isEventOlder, sortEventsDescending } from ".";
import * as uma from "@uma/contracts-node";
import { HubPoolClient } from "../clients";
import { ProposedRootBundle, SortableEvent } from "../interfaces";

export async function getDvmContract(mainnetProvider: ethers.providers.Provider): Promise<Contract> {
  return new Contract(await uma.getVotingV2Address(1), uma.getAbi("VotingV2"), mainnetProvider);
}
export function getDisputedProposal(
  hubPoolClient: HubPoolClient,
  disputeEvent: SortableEvent
): ProposedRootBundle | undefined {
  return sortEventsDescending(hubPoolClient.getProposedRootBundles()).find((e) =>
    isEventOlder(e as SortableEvent, disputeEvent)
  );
}

export async function getDisputeForTimestamp(
  dvm: Contract,
  hubPoolClient: HubPoolClient,
  disputeRequestTimestamp: number,
  disputeRequestBlock?: number
): Promise<SortableEvent | undefined> {
  const filter = dvm.filters.RequestAdded();
  const priceRequestBlock =
    disputeRequestBlock !== undefined
      ? disputeRequestBlock
      : await getBlockForTimestamp(hubPoolClient.chainId, disputeRequestTimestamp);

  const disputes = await dvm.queryFilter(filter, priceRequestBlock, priceRequestBlock);
  return disputes.find((e) => e.args.time.toString() === disputeRequestTimestamp.toString()) as SortableEvent;
}
