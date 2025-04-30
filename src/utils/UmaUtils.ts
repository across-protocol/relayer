import { HubPoolClient } from "../clients";
import { CONTRACT_ADDRESSES } from "../common";
import { ProposedRootBundle, SortableEvent } from "../interfaces";
import { isEventOlder, paginatedEventQuery, sortEventsDescending, spreadEventWithBlockNumber } from "./EventUtils";
import { Contract, ethers, getBlockForTimestamp } from ".";

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

  const eventSearchConfig = { fromBlock: priceRequestBlock, toBlock: priceRequestBlock };
  const disputes = await paginatedEventQuery(dvm, filter, eventSearchConfig);
  const dispute = disputes.find(({ args }) => args.time.toString() === disputeRequestTimestamp.toString());
  return dispute ? spreadEventWithBlockNumber(dispute) : undefined;
}
