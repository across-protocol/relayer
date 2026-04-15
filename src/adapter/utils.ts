import { TOKEN_APPROVALS_TO_FIRST_ZERO } from "../common";
import {
  BigNumber,
  spreadEventWithBlockNumber,
  toBN,
  MAX_SAFE_ALLOWANCE,
  submitTransaction,
  TransactionResponse,
  bnZero,
  getNetworkName,
  blockExplorerLink,
  mapAsync,
  winston,
  Address,
} from "../utils";
import { BridgeEvent } from "./bridges/BaseBridgeAdapter";
import { Log, SortableEvent } from "../interfaces";
import { ExpandedERC20 } from "@across-protocol/sdk/typechain";
import { TransactionClient } from "../clients/TransactionClient";

export {
  matchL2EthDepositAndWrapEvents,
  getAllowanceCacheKey,
  getTokenAllowanceFromCache,
  setTokenAllowanceInCache,
} from "../clients/bridges/utils";

export { getL2TokenAllowanceFromCache, setL2TokenAllowanceInCache } from "../clients/bridges/utils";

export interface TransferTokenParams {
  // Send tokens to target chain using faster mode of transfer. Used by USDC CCTP bridge.
  fastMode: boolean;
}

export function aboveAllowanceThreshold(allowance: BigNumber): boolean {
  return allowance.gte(toBN(MAX_SAFE_ALLOWANCE).div(2));
}

export async function approveTokens(
  tokens: { token: ExpandedERC20; bridges: Address[] }[],
  approvalChainId: number,
  hubChainId: number,
  logger: winston.Logger
): Promise<string> {
  const transactionClient = new TransactionClient(logger);
  const bridges = tokens.flatMap(({ token, bridges }) => bridges.map((bridge) => ({ token, bridge })));
  const approvalMarkdwn = await mapAsync(bridges, async ({ token, bridge }) => {
    const txs: TransactionResponse[] = [];
    if (approvalChainId == hubChainId) {
      if (TOKEN_APPROVALS_TO_FIRST_ZERO[hubChainId]?.includes(token.address)) {
        txs.push(
          await submitTransaction(
            {
              contract: token,
              method: "approve",
              args: [bridge.toNative(), bnZero],
              chainId: approvalChainId,
              ensureConfirmation: true,
            },
            transactionClient
          )
        );
      }
    }
    txs.push(
      await submitTransaction(
        {
          contract: token,
          method: "approve",
          args: [bridge.toNative(), MAX_SAFE_ALLOWANCE],
          chainId: approvalChainId,
          ensureConfirmation: true,
        },
        transactionClient
      )
    );
    const networkName = getNetworkName(approvalChainId);

    let internalMrkdwn =
      ` - Approved token bridge ${blockExplorerLink(bridge.toNative(), approvalChainId)} ` +
      `to spend ${await token.symbol()} ${blockExplorerLink(token.address, approvalChainId)} on ${networkName}.` +
      `tx: ${blockExplorerLink(txs.at(-1).hash, approvalChainId)}`;

    if (txs.length > 1) {
      internalMrkdwn += ` tx (to zero approval first): ${blockExplorerLink(txs[0].hash, hubChainId)}`;
    }
    return internalMrkdwn;
  });
  return ["*Approval transactions:*", ...approvalMarkdwn].join("\n");
}

export function processEvent(event: Log, amountField: string): BridgeEvent {
  const eventSpread = spreadEventWithBlockNumber(event) as SortableEvent & { [key: string]: BigNumber };
  return {
    ...eventSpread,
    amount: eventSpread[amountField],
  };
}
