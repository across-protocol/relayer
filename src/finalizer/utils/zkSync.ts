import { interfaces, utils as sdkUtils } from "@across-protocol/sdk-v2";
import { Contract, ethers, Wallet } from "ethers";
import { groupBy } from "lodash";
import { Provider as zksProvider, types as zkTypes, utils as zkUtils, Wallet as zkWallet } from "zksync-web3";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { CONTRACT_ADDRESSES, Multicall2Call } from "../../common";
import { convertFromWei, getEthAddressForChain, winston, zkSync as zkSyncUtils } from "../../utils";
import { FinalizerPromise, Withdrawal } from "../types";

type Provider = ethers.providers.Provider;
type TokensBridged = interfaces.TokensBridged;

type zkSyncWithdrawalData = {
  l1BatchNumber: number;
  l2MessageIndex: number;
  l2TxNumberInBlock: number;
  message: string;
  sender: string;
  proof: string[];
};

const TransactionStatus = zkTypes.TransactionStatus;

/**
 * @returns Withdrawal finalizaton calldata and metadata.
 */
export async function zkSyncFinalizer(
  logger: winston.Logger,
  signer: Wallet,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  oldestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const { chainId: l1ChainId } = hubPoolClient;
  const { chainId: l2ChainId } = spokePoolClient;

  const l1Provider = hubPoolClient.hubPool.provider;
  const l2Provider = zkSyncUtils.convertEthersRPCToZKSyncRPC(spokePoolClient.spokePool.provider);
  const wallet = new zkWallet(signer.privateKey, l2Provider, l1Provider);

  // Any block younger than latestBlockToFinalize is ignored.
  const withdrawalsToQuery = spokePoolClient
    .getTokensBridged()
    .filter(({ blockNumber }) => blockNumber > oldestBlockToFinalize);
  const { committed: l2Committed, finalized: l2Finalized } = await sortWithdrawals(l2Provider, withdrawalsToQuery);
  const candidates = await filterMessageLogs(wallet, l2Provider, l2Finalized);
  const withdrawalParams = await getWithdrawalParams(wallet, candidates);
  const txns = await prepareFinalizations(l1ChainId, l2ChainId, withdrawalParams);

  const withdrawals = candidates.map(({ l2TokenAddress, amountToReturn }) => {
    const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
      l2ChainId,
      l2TokenAddress,
      hubPoolClient.latestBlockNumber
    );
    const { decimals, symbol: l1TokenSymbol } = hubPoolClient.getTokenInfo(l1ChainId, l1TokenCounterpart);
    const amountFromWei = convertFromWei(amountToReturn.toString(), decimals);
    const withdrawal: Withdrawal = {
      l2ChainId,
      l1TokenSymbol,
      amount: amountFromWei,
      type: "withdrawal",
    };

    return withdrawal;
  });

  logger.debug({
    at: "zkSyncFinalizer",
    message: "zkSync withdrawal status.",
    statusesGrouped: {
      withdrawalPending: withdrawalsToQuery.length - l2Finalized.length,
      withdrawalReady: candidates.length,
      withdrawalFinalized: l2Finalized.length - candidates.length,
    },
    committed: l2Committed,
  });

  return { callData: txns, withdrawals };
}

/**
 * @dev For L2 transactions, status "finalized" is required before any contained messages can be executed on the L1.
 * @param provider zkSync L2 provider instance (must be of type zksync-web3.Provider).
 * @param tokensBridged Array of TokensBridged events to evaluate for finalization.
 * @returns TokensBridged events sorted according to pending and ready for finalization.
 */
async function sortWithdrawals(
  provider: zksProvider,
  tokensBridged: TokensBridged[]
): Promise<{ committed: TokensBridged[]; finalized: TokensBridged[] }> {
  const txnStatus = await Promise.all(
    tokensBridged.map(({ transactionHash }) => provider.getTransactionStatus(transactionHash))
  );

  let idx = 0; // @dev Possible to infer the loop index in groupBy ??
  const { committed = [], finalized = [] } = groupBy(tokensBridged, () =>
    txnStatus[idx++] === TransactionStatus.Finalized ? "finalized" : "committed"
  );

  return { committed, finalized };
}

/**
 * @param wallet zkSync wallet instance.
 * @param l2Provider L2 provider instance.
 * @param tokensBridged Array of TokensBridged events to evaluate for finalization.
 * @returns TokensBridged events sorted according to pending and ready for finalization.
 */
async function filterMessageLogs(
  wallet: zkWallet,
  l2Provider: Provider,
  tokensBridged: TokensBridged[]
): Promise<(TokensBridged & { withdrawalIdx: number })[]> {
  const l1MessageSent = zkUtils.L1_MESSENGER.getEventTopic("L1MessageSent");

  // Filter transaction hashes for duplicates, then request receipts for each hash.
  const txnHashes = [...new Set(tokensBridged.map(({ transactionHash }) => transactionHash))];
  const txnReceipts = Object.fromEntries(
    await sdkUtils.mapAsync(txnHashes, async (txnHash) => [txnHash, await l2Provider.getTransactionReceipt(txnHash)])
  );

  // Extract the relevant L1MessageSent events from the transaction.
  const withdrawals = tokensBridged.map((tokenBridged) => {
    const { transactionHash, logIndex } = tokenBridged;
    const txnReceipt = txnReceipts[transactionHash];

    // Search backwards from the TokensBridged log index for the corresponding L1MessageSent event.
    // @dev Array.findLast() would be an improvement but tsc doesn't currently allow it.
    const txnLogs = txnReceipt.logs.slice(0, logIndex).reverse();
    const withdrawal = txnLogs.find((log) => log.topics[0] === l1MessageSent);

    // @dev withdrawalIdx is the "withdrawal number" within the transaction, _not_ the index of the log.
    const l1MessagesSent = txnReceipt.logs.filter((log) => log.topics[0] === l1MessageSent);
    const withdrawalIdx = l1MessagesSent.indexOf(withdrawal);
    return { ...tokenBridged, withdrawalIdx };
  });

  const ready = await sdkUtils.filterAsync(
    withdrawals,
    async ({ transactionHash, withdrawalIdx }) => !(await wallet.isWithdrawalFinalized(transactionHash, withdrawalIdx))
  );

  return ready;
}

/**
 * @param wallet zkSync wallet instance.
 * @param msgLogs Array of transactionHash and withdrawal index pairs.
 * @returns Withdrawal proof data for each withdrawal.
 */
async function getWithdrawalParams(
  wallet: zkWallet,
  msgLogs: { transactionHash: string; withdrawalIdx: number }[]
): Promise<zkSyncWithdrawalData[]> {
  return await sdkUtils.mapAsync(
    msgLogs,
    async ({ transactionHash, withdrawalIdx }) => await wallet.finalizeWithdrawalParams(transactionHash, withdrawalIdx)
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
  ethAddr: string,
  l1Mailbox: Contract,
  l1ERC20Bridge: Contract
): Promise<Multicall2Call> {
  const args = [
    withdrawal.l1BatchNumber,
    withdrawal.l2MessageIndex,
    withdrawal.l2TxNumberInBlock,
    withdrawal.message,
    withdrawal.proof,
  ];

  // @todo Support withdrawing directly as WETH here.
  const [target, txn] =
    withdrawal.sender.toLowerCase() === ethAddr.toLowerCase()
      ? [l1Mailbox.address, await l1Mailbox.populateTransaction.finalizeEthWithdrawal(...args)]
      : [l1ERC20Bridge.address, await l1ERC20Bridge.populateTransaction.finalizeWithdrawal(...args)];

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
  const l1Mailbox = getMailbox(l1ChainId);
  const l1ERC20Bridge = getL1ERC20Bridge(l1ChainId);
  const ethAddr = getEthAddressForChain(l2ChainId);

  return await sdkUtils.mapAsync(withdrawalParams, (withdrawal) =>
    prepareFinalization(withdrawal, ethAddr, l1Mailbox, l1ERC20Bridge)
  );
}

/**
 * @param l1ChainId Chain ID where the L1 ERC20 bridge is deployed.
 * @returns Contract instance for the zkSync ERC20 bridge.
 */
function getL1ERC20Bridge(l1ChainId: number): Contract {
  const contract = CONTRACT_ADDRESSES[l1ChainId]?.zkSyncDefaultErc20Bridge;
  if (!contract) {
    throw new Error(`zkSync ERC20 bridge contract data not found for chain ${l1ChainId}`);
  }
  return new Contract(contract.address, contract.abi);
}

/**
 * @param l1ChainId Chain ID where the L1 messaging bridge is deployed.
 * @returns Contract instance for the zkSync messaging bridge.
 */
function getMailbox(l1ChainId: number): Contract {
  const contract = CONTRACT_ADDRESSES[l1ChainId]?.zkSyncMailbox;
  if (!contract) {
    throw new Error(`zkSync L1 mailbox contract data not found for chain ${l1ChainId}`);
  }
  return new Contract(contract.address, contract.abi);
}
