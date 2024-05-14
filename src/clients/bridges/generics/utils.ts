import { BigNumber } from "ethers";
import {
  MAX_SAFE_ALLOWANCE,
  MAX_UINT_VAL,
  blockExplorerLink,
  bnZero,
  getNetworkName,
  getRedisCache,
  runTransaction,
  toBN,
  winston,
} from "../../../utils";
import { TOKEN_APPROVALS_TO_FIRST_ZERO } from "../../../common";
import { utils } from "@across-protocol/sdk-v2";
import { ExpandedERC20 } from "@across-protocol/contracts-v2";

export function getAllowanceCacheKey(l1Token: string, targetContract: string, userAddress: string): string {
  return `l1CanonicalTokenBridgeAllowance_${l1Token}_${userAddress}_targetContract:${targetContract}`;
}

export function isMaxAllowance(allowance: BigNumber): boolean {
  return allowance.gte(toBN(MAX_SAFE_ALLOWANCE));
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

export async function approveTokens(
  tokens: { token: ExpandedERC20; bridges: string[] }[],
  chainId: number,
  hubChainId: number,
  logger: winston.Logger
): Promise<string> {
  const bridges = tokens.flatMap(({ token, bridges }) => bridges.map((bridge) => ({ token, bridge })));
  const approvalMarkdwn = await utils.mapAsync(bridges, async ({ token: l1Token, bridge }) => {
    const txs = [];
    if (TOKEN_APPROVALS_TO_FIRST_ZERO[hubChainId]?.includes(l1Token.address)) {
      txs.push(await runTransaction(logger, l1Token, "approve", [bridge, bnZero]));
    }
    txs.push(await runTransaction(logger, l1Token, "approve", [bridge, MAX_UINT_VAL]));
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
