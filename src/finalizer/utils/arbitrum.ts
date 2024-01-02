import { L2ToL1MessageStatus, L2TransactionReceipt, L2ToL1MessageWriter } from "@arbitrum/sdk";
import {
  winston,
  convertFromWei,
  getNetworkName,
  groupObjectCountsByProp,
  Contract,
  getCachedProvider,
  getUniqueLogIndex,
  Signer,
} from "../../utils";
import { TokensBridged } from "../../interfaces";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { CONTRACT_ADDRESSES, Multicall2Call } from "../../common";
import { FinalizerPromise, Withdrawal } from "../types";

const CHAIN_ID = 42161;

export async function arbitrumOneFinalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  latestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const { chainId } = spokePoolClient;

  logger.debug({
    at: "Finalizer#arbitrumOneFinalizer",
    message: `Oldest TokensBridged block to attempt to finalize for ${getNetworkName(chainId)}`,
    latestBlockToFinalize,
  });
  // Skip events that are likely not past the seven day challenge period.
  const olderTokensBridgedEvents = spokePoolClient
    .getTokensBridged()
    .filter((e) => e.blockNumber < latestBlockToFinalize);

  return await multicallArbitrumFinalizations(olderTokensBridgedEvents, signer, hubPoolClient, logger);
}

async function multicallArbitrumFinalizations(
  tokensBridged: TokensBridged[],
  hubSigner: Signer,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<{ callData: Multicall2Call[]; withdrawals: Withdrawal[] }> {
  const finalizableMessages = await getFinalizableMessages(logger, tokensBridged, hubSigner);
  const callData = await Promise.all(finalizableMessages.map((message) => finalizeArbitrum(message.message)));
  const withdrawals = finalizableMessages.map((message) => {
    const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
      CHAIN_ID,
      message.info.l2TokenAddress,
      hubPoolClient.latestBlockSearched
    );
    const l1TokenInfo = hubPoolClient.getTokenInfo(1, l1TokenCounterpart);
    const amountFromWei = convertFromWei(message.info.amountToReturn.toString(), l1TokenInfo.decimals);
    const withdrawal: Withdrawal = {
      l2ChainId: CHAIN_ID,
      l1TokenSymbol: l1TokenInfo.symbol,
      amount: amountFromWei,
      type: "withdrawal",
    };

    return withdrawal;
  });
  return {
    callData,
    withdrawals,
  };
}

async function finalizeArbitrum(message: L2ToL1MessageWriter): Promise<Multicall2Call> {
  const l2Provider = getCachedProvider(CHAIN_ID, true);
  const proof = await message.getOutboxProof(l2Provider);
  const { address, abi } = CONTRACT_ADDRESSES[CHAIN_ID].outbox;
  const outbox = new Contract(address, abi);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eventData = (message as any).nitroWriter.event; // nitroWriter is a private property on the
  // L2ToL1MessageWriter class, which we need to form the calldata so unfortunately we must cast to `any`.
  const callData = await outbox.populateTransaction.executeTransaction(
    proof,
    eventData.position,
    eventData.caller,
    eventData.destination,
    eventData.arbBlockNum,
    eventData.ethBlockNum,
    eventData.timestamp,
    eventData.callvalue,
    eventData.data,
    {}
  );
  return {
    callData: callData.data,
    target: callData.to,
  };
}

async function getFinalizableMessages(
  logger: winston.Logger,
  tokensBridged: TokensBridged[],
  l1Signer: Signer
): Promise<
  {
    info: TokensBridged;
    message: L2ToL1MessageWriter;
    status: string;
  }[]
> {
  const allMessagesWithStatuses = await getAllMessageStatuses(tokensBridged, logger, l1Signer);
  const statusesGrouped = groupObjectCountsByProp(
    allMessagesWithStatuses,
    (message: { status: string }) => message.status
  );
  logger.debug({
    at: "ArbitrumFinalizer",
    message: "Arbitrum outbox message statuses",
    statusesGrouped,
  });
  return allMessagesWithStatuses.filter((x) => x.status === L2ToL1MessageStatus[L2ToL1MessageStatus.CONFIRMED]);
}

async function getAllMessageStatuses(
  tokensBridged: TokensBridged[],
  logger: winston.Logger,
  mainnetSigner: Signer
): Promise<
  {
    info: TokensBridged;
    message: L2ToL1MessageWriter;
    status: string;
  }[]
> {
  // For each token bridge event, store a unique log index for the event within the arbitrum transaction hash.
  // This is important for bridge transactions containing multiple events.
  const logIndexesForMessage = getUniqueLogIndex(tokensBridged);
  return (
    await Promise.all(
      tokensBridged.map((e, i) => getMessageOutboxStatusAndProof(logger, e, mainnetSigner, logIndexesForMessage[i]))
    )
  )
    .map((result, i) => {
      return {
        ...result,
        info: tokensBridged[i],
      };
    })
    .filter((result) => result.message !== undefined);
}

async function getMessageOutboxStatusAndProof(
  logger: winston.Logger,
  event: TokensBridged,
  l1Signer: Signer,
  logIndex: number
): Promise<{
  message: L2ToL1MessageWriter;
  status: string;
}> {
  const l2Provider = getCachedProvider(CHAIN_ID, true);
  const receipt = await l2Provider.getTransactionReceipt(event.transactionHash);
  const l2Receipt = new L2TransactionReceipt(receipt);

  try {
    const l2ToL1Messages = await l2Receipt.getL2ToL1Messages(l1Signer);
    if (l2ToL1Messages.length === 0 || l2ToL1Messages.length - 1 < logIndex) {
      const error = new Error(`No outgoing messages found in transaction:${event.transactionHash}`);
      logger.warn({
        at: "ArbitrumFinalizer",
        message: "Arbitrum transaction that emitted TokensBridged event unexpectedly contains 0 L2-to-L1 messages 🤢!",
        logIndex,
        l2ToL1Messages: l2ToL1Messages.length,
        txnHash: event.transactionHash,
        reason: error.stack || error.message || error.toString(),
        notificationPath: "across-error",
      });
      throw error;
    }
    const l2Message = l2ToL1Messages[logIndex];

    // Check if already executed or unconfirmed (i.e. not yet available to be executed on L1 following dispute
    // window)
    const outboxMessageExecutionStatus = await l2Message.status(l2Provider);
    if (outboxMessageExecutionStatus === L2ToL1MessageStatus.EXECUTED) {
      return {
        message: l2Message,
        status: L2ToL1MessageStatus[L2ToL1MessageStatus.EXECUTED],
      };
    }
    if (outboxMessageExecutionStatus !== L2ToL1MessageStatus.CONFIRMED) {
      return {
        message: l2Message,
        status: L2ToL1MessageStatus[L2ToL1MessageStatus.UNCONFIRMED],
      };
    }

    // Now that its confirmed and not executed, we can execute our
    // message in its outbox entry.
    return {
      message: l2Message,
      status: L2ToL1MessageStatus[outboxMessageExecutionStatus],
    };
  } catch (error) {
    // Likely L1 message hasn't been included in an arbitrum batch yet, so ignore it for now.
    return {
      message: undefined,
      status: L2ToL1MessageStatus[L2ToL1MessageStatus.UNCONFIRMED],
    };
  }
}
