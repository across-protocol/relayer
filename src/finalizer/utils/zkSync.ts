import { interfaces, utils as sdkUtils } from "@across-protocol/sdk";
import { Contract, Wallet, Signer } from "ethers";
import { groupBy } from "lodash";
import { Provider as zksProvider, Wallet as zkWallet } from "zksync-ethers";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { CONTRACT_ADDRESSES } from "../../common";
import {
  convertFromWei,
  getBlockForTimestamp,
  getCurrentTime,
  getRedisCache,
  getTokenInfo,
  getUniqueLogIndex,
  Multicall2Call,
  winston,
  zkSync as zkSyncUtils,
} from "../../utils";
import { FinalizerPromise, CrossChainMessage } from "../types";

type TokensBridged = interfaces.TokensBridged;

type zkSyncWithdrawalData = {
  l1BatchNumber: number;
  l2MessageIndex: number;
  l2TxNumberInBlock: number;
  message: string;
  sender: string;
  proof: string[];
};
/**
 * @returns Withdrawal finalizaton calldata and metadata.
 */
export async function zkSyncFinalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient
): Promise<FinalizerPromise> {
  const { chainId: l1ChainId } = hubPoolClient;
  const { chainId: l2ChainId } = spokePoolClient;

  const l1Provider = hubPoolClient.hubPool.provider;
  const l2Provider = zkSyncUtils.convertEthersRPCToZKSyncRPC(spokePoolClient.spokePool.provider);
  const wallet = new zkWallet((signer as Wallet).privateKey, l2Provider, l1Provider);

  // Zksync takes ~6 hours to finalize so ignore any events
  // earlier than that.
  const redis = await getRedisCache(logger);
  const latestBlockToFinalize = await getBlockForTimestamp(l2ChainId, getCurrentTime() - 60 * 60 * 6, undefined, redis);

  logger.debug({
    at: "Finalizer#ZkSyncFinalizer",
    message: "ZkSync TokensBridged event filter",
    toBlock: latestBlockToFinalize,
  });
  const withdrawalsToQuery = spokePoolClient
    .getTokensBridged()
    .filter(({ blockNumber }) => blockNumber <= latestBlockToFinalize);
  const statuses = await sortWithdrawals(l2Provider, withdrawalsToQuery);
  const l2Finalized = statuses["finalized"] ?? [];
  const candidates = await filterMessageLogs(wallet, l2Finalized);
  const withdrawalParams = await getWithdrawalParams(wallet, candidates);
  const txns = await prepareFinalizations(l1ChainId, l2ChainId, withdrawalParams);

  const withdrawals = candidates.map(({ l2TokenAddress, amountToReturn }) => {
    const { decimals, symbol } = getTokenInfo(l2TokenAddress, l2ChainId);
    const amountFromWei = convertFromWei(amountToReturn.toString(), decimals);
    const withdrawal: CrossChainMessage = {
      originationChainId: l2ChainId,
      l1TokenSymbol: symbol,
      amount: amountFromWei,
      type: "withdrawal",
      destinationChainId: hubPoolClient.chainId,
    };

    return withdrawal;
  });

  // The statuses are:
  // - not-found: The transaction is not found.
  // - processing/committed: Pending finalization
  // - finalized: ready to be withdrawn or already withdrawn
  logger.debug({
    at: "ZkSyncFinalizer",
    message: "ZkSync withdrawal status.",
    statusesGrouped: {
      withdrawalNotFound: statuses["not-found"]?.length,
      withdrawalProcessing: statuses["processing"]?.length,
      // Pending essentially includes txns with the "committed" statuses
      withdrawalPending: withdrawalsToQuery.length - l2Finalized.length,
      withdrawalFinalizedNotExecuted: candidates.length,
      withdrawalExecuted: l2Finalized.length - candidates.length,
    },
  });

  return { callData: txns, crossChainMessages: withdrawals };
}

/**
 * @dev For L2 transactions, status "finalized" is required before any contained messages can be executed on the L1.
 * @param provider zkSync L2 provider instance (must be of type zksync-ethers.Provider).
 * @param tokensBridged Array of TokensBridged events to evaluate for finalization.
 * @returns TokensBridged events sorted according to pending and ready for finalization.
 */
async function sortWithdrawals(
  provider: zksProvider,
  tokensBridged: TokensBridged[]
): Promise<Record<string, TokensBridged[]>> {
  const txnStatus = await Promise.all(tokensBridged.map(({ txnRef }) => provider.getTransactionStatus(txnRef)));

  let idx = 0; // @dev Possible to infer the loop index in groupBy ??
  const statuses = groupBy(tokensBridged, () => txnStatus[idx++]);

  return statuses;
}

/**
 * @param wallet zkSync wallet instance.
 * @param l2Provider L2 provider instance.
 * @param tokensBridged Array of TokensBridged events to evaluate for finalization.
 * @returns TokensBridged events sorted according to pending and ready for finalization.
 */
async function filterMessageLogs(
  wallet: zkWallet,
  tokensBridged: TokensBridged[]
): Promise<(TokensBridged & { withdrawalIdx: number })[]> {
  // For each token bridge event, store a unique log index for the event within the zksync transaction hash.
  // This is important for bridge transactions containing multiple events.
  const logIndexesForMessage = getUniqueLogIndex(tokensBridged);
  const withdrawals = tokensBridged.map((tokenBridged, i) => {
    return { ...tokenBridged, withdrawalIdx: logIndexesForMessage[i] };
  });

  const ready = await sdkUtils.filterAsync(
    withdrawals,
    async ({ txnRef, withdrawalIdx }) => !(await wallet.isWithdrawalFinalized(txnRef, withdrawalIdx))
  );

  return ready;
}

/**
 * @param wallet zkSync wallet instance.
 * @param msgLogs Array of txnRef and withdrawal index pairs.
 * @returns Withdrawal proof data for each withdrawal.
 */
async function getWithdrawalParams(
  wallet: zkWallet,
  msgLogs: { txnRef: string; withdrawalIdx: number }[]
): Promise<zkSyncWithdrawalData[]> {
  return await sdkUtils.mapAsync(
    msgLogs,
    async ({ txnRef, withdrawalIdx }) => await wallet.finalizeWithdrawalParams(txnRef, withdrawalIdx)
  );
}

/**
 * @param withdrawal Withdrawal proof data for a single withdrawal.
 * @param ethAddr Ethereum address on the L2.
 * @param l1Mailbox zkSync mailbox contract on the L1.
 * @param l1ERC20Bridge zkSync ERC20 bridge contract on the L1.
 * @returns Calldata for a withdrawal finalization.
 */
async function prepareFinalization(
  withdrawal: zkSyncWithdrawalData,
  l2ChainId: number,
  l1SharedBridge: Contract
): Promise<Multicall2Call> {
  const args = [
    l2ChainId,
    withdrawal.l1BatchNumber,
    withdrawal.l2MessageIndex,
    withdrawal.l2TxNumberInBlock,
    withdrawal.message,
    withdrawal.proof,
  ];

  // @todo Support withdrawing directly as WETH here.
  const [target, txn] = [l1SharedBridge.address, await l1SharedBridge.populateTransaction.finalizeWithdrawal(...args)];

  return { target, callData: txn.data };
}

/**
 * @param l1ChainId Chain ID for the L1.
 * @param l2ChainId Chain ID for the L2.
 * @param withdrawalParams Array of proof data for each withdrawal to finalize.
 * @returns Array of calldata for each input withdrawal to finalize.
 */
async function prepareFinalizations(
  l1ChainId: number,
  l2ChainId: number,
  withdrawalParams: zkSyncWithdrawalData[]
): Promise<Multicall2Call[]> {
  const sharedBridge = getSharedBridge(l1ChainId);

  return await sdkUtils.mapAsync(withdrawalParams, async (withdrawal) =>
    prepareFinalization(withdrawal, l2ChainId, sharedBridge)
  );
}

function getSharedBridge(l1ChainId: number): Contract {
  const contract = CONTRACT_ADDRESSES[l1ChainId]?.zkStackSharedBridge;
  if (!contract) {
    throw new Error(`zkStack shared bridge contract data not found for chain ${l1ChainId}`);
  }
  return new Contract(contract.address, contract.abi);
}
