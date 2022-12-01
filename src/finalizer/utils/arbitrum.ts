import {
  getProvider,
  Wallet,
  winston,
  convertFromWei,
  groupObjectCountsByProp,
  delay,
  etherscanLink,
} from "../../utils";
import { L2ToL1MessageStatus, L2TransactionReceipt, IL2ToL1MessageWriter } from "@arbitrum/sdk";
import { TokensBridged } from "../../interfaces";
import { HubPoolClient } from "../../clients";

const CHAIN_ID = 42161;

export async function finalizeArbitrum(
  logger: winston.Logger,
  message: IL2ToL1MessageWriter,
  messageInfo: TokensBridged,
  hubPoolClient: HubPoolClient
) {
  const l2Provider = getProvider(42161);
  const l1TokenInfo = hubPoolClient.getL1TokenInfoForL2Token(messageInfo.l2TokenAddress, CHAIN_ID);
  const amountFromWei = convertFromWei(messageInfo.amountToReturn.toString(), l1TokenInfo.decimals);
  try {
    const txn = await message.execute(l2Provider);
    logger.info({
      at: "ArbitrumFinalizer",
      message: `Finalized Arbitrum withdrawal for ${amountFromWei} of ${l1TokenInfo.symbol} 🪃`,
      transactionHash: etherscanLink(txn.hash, 1),
    });
    await delay(30);
  } catch (error) {
    logger.warn({
      at: "ArbitrumFinalizer",
      message: "Error creating executeTransactionTx",
      reason: error.stack || error.message || error.toString(),
      notificationPath: "across-error",
    });
  }
}

export async function getFinalizableMessages(logger: winston.Logger, tokensBridged: TokensBridged[], l1Signer: Wallet) {
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

export async function getAllMessageStatuses(
  tokensBridged: TokensBridged[],
  logger: winston.Logger,
  mainnetSigner: Wallet
) {
  // For each token bridge event, store a unique log index for the event within the arbitrum transaction hash.
  // This is important for bridge transactions containing multiple events.
  const uniqueTokenhashes = {};
  const logIndexesForMessage = [];
  for (const event of tokensBridged) {
    uniqueTokenhashes[event.transactionHash] = uniqueTokenhashes[event.transactionHash] ?? 0;
    const logIndex = uniqueTokenhashes[event.transactionHash];
    logIndexesForMessage.push(logIndex);
    uniqueTokenhashes[event.transactionHash] += 1;
  }
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
export async function getMessageOutboxStatusAndProof(
  logger: winston.Logger,
  event: TokensBridged,
  l1Signer: Wallet,
  logIndex: number
): Promise<{
  message: IL2ToL1MessageWriter;
  status: string;
}> {
  const l2Provider = getProvider(42161);
  const receipt = await l2Provider.getTransactionReceipt(event.transactionHash);
  const l2Receipt = new L2TransactionReceipt(receipt);

  try {
    const l2ToL1Messages = await l2Receipt.getL2ToL1Messages(l1Signer, l2Provider);
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
