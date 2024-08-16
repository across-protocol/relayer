import { BigNumber, Event } from "ethers";
import { TOKEN_APPROVALS_TO_FIRST_ZERO } from "../common";
import {
  spreadEventWithBlockNumber,
  toBN,
  MAX_SAFE_ALLOWANCE,
  runTransaction,
  bnZero,
  getNetworkName,
  blockExplorerLink,
  mapAsync,
  winston,
  getRedisCache,
} from "../utils";
import { BridgeEvent } from "./bridges/BaseBridgeAdapter";
import { SortableEvent } from "../interfaces";
import { ExpandedERC20 } from "@across-protocol/contracts";

export function matchL2EthDepositAndWrapEvents(l2EthDepositEvents: Event[], _l2WrapEvents: Event[]): Event[] {
  const l2WrapEvents = [..._l2WrapEvents]; // deep-copy because we're going to modify this in-place.
  return l2EthDepositEvents.filter((l2EthDepositEvent: Event) => {
    // Search from left to right to find the first following wrap event.
    const followingWrapEventIndex = l2WrapEvents.findIndex(
      (wrapEvent) => wrapEvent.blockNumber >= l2EthDepositEvent.blockNumber
    );
    // Delete the wrap event from the l2 wrap events array to avoid duplicate processing.
    if (followingWrapEventIndex >= 0) {
      l2WrapEvents.splice(followingWrapEventIndex, 1);
      return true;
    }
    return false;
  });
}

export function getAllowanceCacheKey(l1Token: string, targetContract: string, userAddress: string): string {
  return `l1CanonicalTokenBridgeAllowance_${l1Token}_${userAddress}_targetContract:${targetContract}`;
}

export async function getTokenAllowanceFromCache(
  l1Token: string,
  userAddress: string,
  contractAddress: string
): Promise<BigNumber | undefined> {
  const redis = await getRedisCache();
  const key = getAllowanceCacheKey(l1Token, contractAddress, userAddress);
  const allowance = await redis?.get<string>(key);
  if (allowance === null) {
    return undefined;
  }
  return toBN(allowance);
}

export async function setTokenAllowanceInCache(
  l1Token: string,
  userAddress: string,
  contractAddress: string,
  allowance: BigNumber
): Promise<void> {
  const redis = await getRedisCache();
  const key = getAllowanceCacheKey(l1Token, contractAddress, userAddress);
  await redis?.set(key, allowance.toString());
}

export function aboveAllowanceThreshold(allowance: BigNumber): boolean {
  return allowance.gte(toBN(MAX_SAFE_ALLOWANCE).div(2));
}

export async function approveTokens(
  tokens: { token: ExpandedERC20; bridges: string[] }[],
  chainId: number,
  hubChainId: number,
  logger: winston.Logger
): Promise<string> {
  const bridges = tokens.flatMap(({ token, bridges }) => bridges.map((bridge) => ({ token, bridge })));
  const approvalMarkdwn = await mapAsync(bridges, async ({ token: l1Token, bridge }) => {
    const txs = [];
    if (TOKEN_APPROVALS_TO_FIRST_ZERO[hubChainId]?.includes(l1Token.address)) {
      txs.push(await runTransaction(logger, l1Token, "approve", [bridge, bnZero]));
    }
    txs.push(await runTransaction(logger, l1Token, "approve", [bridge, MAX_SAFE_ALLOWANCE]));
    const receipts = await Promise.all(txs.map((tx) => tx.wait()));
    const hubNetwork = getNetworkName(hubChainId);
    const spokeNetwork = getNetworkName(chainId);
    let internalMrkdwn =
      ` - Approved canonical ${spokeNetwork} token bridge ${blockExplorerLink(bridge, hubChainId)} ` +
      `to spend ${await l1Token.symbol()} ${blockExplorerLink(l1Token.address, hubChainId)} on ${hubNetwork}.` +
      `tx: ${blockExplorerLink(receipts[receipts.length - 1].transactionHash, hubChainId)}`;
    if (receipts.length > 1) {
      internalMrkdwn += ` tx (to zero approval first): ${blockExplorerLink(receipts[0].transactionHash, hubChainId)}`;
    }
    return internalMrkdwn;
  });
  return ["*Approval transactions:*", ...approvalMarkdwn].join("\n");
}

export function processEvent(event: Event, amountField: string, toField: string, fromField: string): BridgeEvent {
  const eventSpread = spreadEventWithBlockNumber(event) as SortableEvent & {
    amount: BigNumber;
    to: string;
    from: string;
  };
  return {
    amount: eventSpread[amountField],
    to: eventSpread[toField],
    from: eventSpread[fromField],
    ...eventSpread,
  };
}
