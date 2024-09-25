import { Contract } from "ethers";
import { Log } from "../../interfaces";
import { TOKEN_APPROVALS_TO_FIRST_ZERO } from "../../common";
import {
  BigNumber,
  MAX_SAFE_ALLOWANCE,
  blockExplorerLink,
  bnZero,
  getNetworkName,
  getRedisCache,
  runTransaction,
  toBN,
  winston,
  mapAsync,
} from "../../utils";

/**
 * @notice This function is designed to be used in L2 chain adapters when identifying "finalized" cross
 * chain transfers. For certain L2 chains, sending WETH from L1 to L2 is impossible so the EOA is forced to
 * first unwrap the WETH into ETH via the AtomicWethDepositor contract before receiving ETH to their L2 EOA. As
 * a final step, the EOA must wrap the ETH back into WETH. This function is designed to be used to match the
 * receipt of ETH on L2 with the wrapping of ETH into WETH on L2 to produce a single stream of "finalized" cross
 * chain transfers.
 * @dev Matching wrap and deposit finalized events is inexact because the wrapped amount usually differs
 * slightly from the deposited amount due to fees and inventory management logic. This function therefore
 * coarsely matches L2 deposit events with L2 wrap events by finding the first wrap event following the deposit
 * event. This wrap event is then removed from a list and cannot be matched with any other deposit event. Since
 * wrapping ETH is only expected to be done by this relayer, then this is a very accurate proxy for deciding
 * when WETH cross chain transfers have finalized into the relayer's L2 WETH inventory.
 * @dev This function is used in the WethBridge class in the OP stack and the ZkSyncAdapter.
 * @param l2EthDepositEvents List of L2 DepositFinalized events emitted when the EOA receives ETH on L2.
 * @param _l2WrapEvents List of L2 Wrap events emitted when the EOA wraps ETH into WETH on L2.
 * @returns List of l2EthDepositEvents followed by a l2WrapEvent. None of the
 * l2EthDepositEvents will match with the same l2WrapEvent.
 */
export function matchL2EthDepositAndWrapEvents(l2EthDepositEvents: Log[], _l2WrapEvents: Log[]): Log[] {
  const l2WrapEvents = [..._l2WrapEvents]; // deep-copy because we're going to modify this in-place.
  return l2EthDepositEvents.filter((l2EthDepositEvent) => {
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

export async function approveTokens(
  tokens: { token: Contract; bridge: string }[],
  chainId: number,
  hubChainId: number,
  logger: winston.Logger
): Promise<string> {
  const approvalMarkdwn = await mapAsync(tokens, async ({ token: l1Token, bridge }) => {
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
