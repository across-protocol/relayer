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
  Address,
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

export { getL2TokenAllowanceFromCache, setL2TokenAllowanceInCache } from "../clients/bridges/utils";

export function aboveAllowanceThreshold(allowance: BigNumber): boolean {
  return allowance.gte(toBN(MAX_SAFE_ALLOWANCE).div(2));
}

export async function approveTokens(
  tokens: { token: ExpandedERC20; bridges: Address[] }[],
  approvalChainId: number,
  hubChainId: number,
  logger: winston.Logger
): Promise<string> {
  const bridges = tokens.flatMap(({ token, bridges }) => bridges.map((bridge) => ({ token, bridge })));
  const approvalMarkdwn = await mapAsync(bridges, async ({ token, bridge }) => {
    const txs = [];
    if (approvalChainId == hubChainId) {
      if (TOKEN_APPROVALS_TO_FIRST_ZERO[hubChainId]?.includes(token.address)) {
        txs.push(await runTransaction(logger, token, "approve", [bridge.toNative(), bnZero]));
      }
    }
    txs.push(await runTransaction(logger, token, "approve", [bridge.toNative(), MAX_SAFE_ALLOWANCE]));
    const receipts = await Promise.all(txs.map((tx) => tx.wait()));
    const networkName = getNetworkName(approvalChainId);

    let internalMrkdwn =
      ` - Approved token bridge ${blockExplorerLink(bridge.toNative(), approvalChainId)} ` +
      `to spend ${await token.symbol()} ${blockExplorerLink(token.address, approvalChainId)} on ${networkName}.` +
      `tx: ${blockExplorerLink(receipts.at(-1).transactionHash, approvalChainId)}`;

    if (receipts.length > 1) {
      internalMrkdwn += ` tx (to zero approval first): ${blockExplorerLink(receipts[0].transactionHash, hubChainId)}`;
    }
    return internalMrkdwn;
  });
  return ["*Approval transactions:*", ...approvalMarkdwn].join("\n");
}

export function processEvent(event: Log, amountField: string): BridgeEvent {
  const eventSpread = spreadEventWithBlockNumber(event) as SortableEvent;
  return {
    ...eventSpread,
    amount: eventSpread[amountField],
  };
}
