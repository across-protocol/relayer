import { Contract, ethers, Wallet } from "ethers";
import { Provider as zksProvider, types as zkTypes, utils as zkUtils, Wallet as zkWallet } from "zksync-web3";
import { groupBy } from "lodash";
import { interfaces, utils as sdkUtils } from "@across-protocol/sdk-v2";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { CONTRACT_ADDRESSES, Multicall2Call } from "../../common";
import { convertFromWei, getEthAddressForChain, getNodeUrlList, winston } from "../../utils";
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _latestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const { chainId: l1ChainId } = hubPoolClient;
  const { chainId: l2ChainId } = spokePoolClient;

  const l1Provider = hubPoolClient.hubPool.provider;
  const l2Provider = new zksProvider(getNodeUrlList(l2ChainId, 1)[0]);
  const wallet = new zkWallet(signer.privateKey, l2Provider, l1Provider);

  const tokensBridged = spokePoolClient.getTokensBridged();
  const { ready, pending } = await sortWithdrawals(l2Provider, tokensBridged);
  if (pending.length > 0) {
    logger.debug({
      at: "zkSyncFinalizer",
      message: `Found ${pending.length} pending withdrawal transactions.`,
      pending,
    });
  }

  const candidates = await filterMessageLogs(wallet, l2Provider, ready);
  if (candidates.length > 0) {
    logger.debug({
      at: "zkSyncFinalizer",
      message: `Found ${candidates.length} withdrawals ready to be finalized.`,
      candidates,
    });
  }

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
    const _withdrawal: Withdrawal = {
      l2ChainId,
      l1TokenSymbol,
      amount: amountFromWei,
      type: "withdrawal",
    };

    return _withdrawal;
  });

  return { callData: txns, withdrawals };
}

/**
 * @param provider zkSync L2 provider instance (must be of type zksync-web3.Provider).
 * @param tokensBridged Array of TokensBridged events to evaluate for finalization.
 * @returns TokensBridged events sorted according to pending and ready for finalization.
 */
async function sortWithdrawals(
  provider: zksProvider,
  tokensBridged: TokensBridged[]
): Promise<{ pending: TokensBridged[]; ready: TokensBridged[] }> {
  const txnStatus = await Promise.all(
    tokensBridged.map(({ transactionHash }) => provider.getTransactionStatus(transactionHash))
  );

  let idx = 0; // @dev Possible to infer the loop index in groupBy ??
  const { pending = [], ready = [] } = groupBy(tokensBridged, () =>
    txnStatus[idx++] === TransactionStatus.Finalized ? "ready" : "pending"
  );

  return { ready, pending };
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

  // Extract the relevant L1MessageSent events from the transaction.
  const logs = await sdkUtils.mapAsync(tokensBridged, async (tokenBridged) => {
    const { transactionHash, logIndex } = tokenBridged;
    const txnReceipt = await l2Provider.getTransactionReceipt(transactionHash);

    // Search backwards from the TokensBridged for the first L1MessageSent event.
    const txnLogs = txnReceipt.logs.slice(0, logIndex).reverse();
    const withdrawal = txnLogs.find((log) => log.topics[0] === l1MessageSent);

    // @dev idx is the "withdrawal number" within the transaction, _not_ the index of the log.
    const l1MessagesSent = txnReceipt.logs.filter((log) => log.topics[0] === l1MessageSent);
    const withdrawalIdx = l1MessagesSent.indexOf(withdrawal);
    return { ...tokenBridged, withdrawalIdx };
  });

  const ready = await sdkUtils.filterAsync(
    logs.flat(),
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

  return await sdkUtils.mapAsync(withdrawalParams, async (withdrawal) =>
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
