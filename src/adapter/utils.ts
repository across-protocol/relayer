import { TOKEN_APPROVALS_TO_FIRST_ZERO } from "../common";
import {
  BigNumber,
  spreadEventWithBlockNumber,
  toBN,
  MAX_SAFE_ALLOWANCE,
  runTransaction,
  bnZero,
  getNetworkName,
  blockExplorerLink,
  mapAsync,
  winston,
} from "../utils";
import { BridgeEvent } from "./bridges/BaseBridgeAdapter";
import { Log, SortableEvent } from "../interfaces";
import { ExpandedERC20 } from "@across-protocol/contracts";

export {
  matchL2EthDepositAndWrapEvents,
  getAllowanceCacheKey,
  getTokenAllowanceFromCache,
  setTokenAllowanceInCache,
} from "../clients/bridges/utils";

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

export function processEvent(event: Log, amountField: string, toField: string, fromField: string): BridgeEvent {
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
