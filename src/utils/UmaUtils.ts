import { HubPoolClient } from "../clients";
import { CONTRACT_ADDRESSES } from "../common";
import { ProposedRootBundle, SortableEvent } from "../interfaces";
import { Contract, ethers, getBlockForTimestamp, isEventOlder, sortEventsDescending } from ".";

export async function getDvmContract(provider: ethers.providers.Provider): Promise<Contract> {
  const { chainId } = await provider.getNetwork();
  const { address, abi } = CONTRACT_ADDRESSES[chainId].VotingV2;
  return new Contract(address, abi, provider);
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
