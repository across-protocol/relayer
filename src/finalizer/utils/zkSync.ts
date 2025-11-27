import { interfaces, utils as sdkUtils } from "@across-protocol/sdk";
import { Contract, Signer } from "ethers";
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
  assert,
  isEVMSpokePoolClient,
  isSignerWallet,
  TOKEN_SYMBOLS_MAP,
  EvmAddress,
  Address,
  Provider,
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

const IGNORED_WITHDRAWALS = [
  "0xe93642e22eec21ead2abb20f23a1dc3033b41274cdfe7439cf3ada3dfa1dff06", // Lens USDC 2025-06-13 @todo remove
];

/**
 * @returns Withdrawal finalization calldata and metadata.
 */
export async function zkSyncFinalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient
): Promise<FinalizerPromise> {
  assert(isEVMSpokePoolClient(spokePoolClient));
  const { chainId: l1ChainId } = hubPoolClient;
  const { chainId: l2ChainId } = spokePoolClient;

  const l1Provider = hubPoolClient.hubPool.provider;
  const l2Provider = zkSyncUtils.convertEthersRPCToZKSyncRPC(spokePoolClient.spokePool.provider);
  assert(isSignerWallet(signer), "Signer is not a Wallet");
  const wallet = new zkWallet(signer.privateKey, l2Provider, l1Provider);

  // Zksync takes ~6 hours to finalize so ignore any events
  // earlier than that.
  const redis = await getRedisCache(logger);
  const latestBlockToFinalize = await getBlockForTimestamp(
    logger,
    l2ChainId,
    getCurrentTime() - 60 * 60 * 6,
    undefined,
    redis
  );

  logger.debug({
    at: "Finalizer#ZkSyncFinalizer",
    message: "ZkSync TokensBridged event filter",
    toBlock: latestBlockToFinalize,
  });
  const withdrawalsToQuery = spokePoolClient
    .getTokensBridged()
    .filter(({ blockNumber }) => blockNumber <= latestBlockToFinalize)
    .filter(({ txnRef }) => !IGNORED_WITHDRAWALS.includes(txnRef));
  const statuses = await sortWithdrawals(l2Provider, withdrawalsToQuery);
  const l2Finalized = statuses["finalized"] ?? [];
  const candidates = await filterMessageLogs(wallet, l1ChainId, l2Finalized);
  const withdrawalParams = await getWithdrawalParams(wallet, candidates);
  const txns = await prepareFinalizations(l1ChainId, l2ChainId, withdrawalParams, candidates);

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
  l1ChainId: number,
  tokensBridged: TokensBridged[]
): Promise<(TokensBridged & { withdrawalIdx: number })[]> {
  // For each token bridge event, store a unique log index for the event within the zksync transaction hash.
  // This is important for bridge transactions containing multiple events.
  const logIndexesForMessage = getUniqueLogIndex(tokensBridged);
  const withdrawals = tokensBridged.map((tokenBridged, i) => {
    return { ...tokenBridged, withdrawalIdx: logIndexesForMessage[i] };
  });

  const ready = await sdkUtils.filterAsync(withdrawals, async ({ txnRef, withdrawalIdx, chainId, l2TokenAddress }) => {
    try {
      // If the token is USDC, we need to avoid using the zksync-ethers SDK version < 6.20.0, which adds support
      // for the custom USDC bridge that ZkStack uses. Specifically, the L2 Bridge for USDC withdrawals doesn't have
      // a "l1SharedBridge" view method but instead has a "l1USDCBridge" view method.
      if (withdrawalRequiresCustomUsdcBridge(l1ChainId, chainId, l2TokenAddress)) {
        // The following code is copied from the zksync-ethers SDK but replaces the l1BridgeContract
        // with the l1UsdcBridgeContract where we call isWithdrawalFinalized().
        const { l2ToL1LogIndex } = await wallet._getWithdrawalL2ToL1Log(txnRef, withdrawalIdx);
        const { id } = await wallet._providerL2().getLogProof(txnRef, l2ToL1LogIndex);
        const { l1BatchNumber } = await wallet.finalizeWithdrawalParams(txnRef, withdrawalIdx);
        const l1UsdcBridge = getSharedBridge(l1ChainId, chainId, l2TokenAddress, wallet._providerL1());
        return !(await l1UsdcBridge.isWithdrawalFinalized(chainId, l1BatchNumber, id));
      }
      return !(await wallet.isWithdrawalFinalized(txnRef, withdrawalIdx));
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("Log proof not found")) {
        return false;
      }
      throw error;
    }
  });

  return ready;
}

function withdrawalRequiresCustomUsdcBridge(l1ChainId: number, l2ChainId: number, l2TokenAddress: Address): boolean {
  if (CONTRACT_ADDRESSES[l1ChainId]?.[`zkStackUSDCBridge_${l2ChainId}`] && CONTRACT_ADDRESSES[l2ChainId]?.usdcBridge) {
    const l2Usdc = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[l2ChainId]);
    return l2TokenAddress.eq(l2Usdc);
  }
  return false;
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
  withdrawalParams: zkSyncWithdrawalData[],
  tokensBridged: TokensBridged[]
): Promise<Multicall2Call[]> {
  assert(
    tokensBridged.length === withdrawalParams.length,
    "Withdrawal params and tokens bridged must have the same length"
  );

  return await sdkUtils.mapAsync(withdrawalParams, async (withdrawal, idx) => {
    const sharedBridge = getSharedBridge(l1ChainId, tokensBridged[idx].chainId, tokensBridged[idx].l2TokenAddress);
    return prepareFinalization(withdrawal, l2ChainId, sharedBridge);
  });
}

function getSharedBridge(
  l1ChainId: number,
  l2ChainId: number,
  l2TokenAddress: Address,
  l1Provider?: Provider
): Contract {
  const contract =
    CONTRACT_ADDRESSES[l1ChainId]?.[
      withdrawalRequiresCustomUsdcBridge(l1ChainId, l2ChainId, l2TokenAddress)
        ? `zkStackUSDCBridge_${l2ChainId}`
        : "zkStackSharedBridge"
    ];
  if (!contract) {
    throw new Error(`zkStack shared bridge contract data not found for chain ${l1ChainId}`);
  }
  return new Contract(contract.address, contract.abi, l1Provider);
}
