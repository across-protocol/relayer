import {
  getProvider,
  groupObjectCountsByThreeProps,
  Wallet,
  winston,
  convertFromWei,
  groupObjectCountsByTwoProps,
} from "../../utils";
import { L2ToL1MessageWriter, L2ToL1MessageStatus, L2TransactionReceipt, getL2Network } from "@arbitrum/sdk";
import { MessageBatchProofInfo } from "@arbitrum/sdk/dist/lib/message/L2ToL1Message";
import { TokensBridged } from "../../interfaces";
import { HubPoolClient } from "../../clients";

export async function finalizeArbitrum(
  logger: winston.Logger,
  message: L2ToL1MessageWriter,
  token: string,
  proofInfo: MessageBatchProofInfo
) {
  logger.debug({
    at: "ArbitrumFinalizer",
    message: "Finalizing message",
    token,
  });
  const res = await message.execute(proofInfo);
  const rec = await res.wait();
  logger.info({
    at: "ArbitrumFinalizer",
    message: "Executed!",
    rec,
  });
}

export async function getFinalizableMessages(
  logger: winston.Logger,
  tokensBridged: TokensBridged[],
  l1Signer: Wallet,
  hubPoolClient: HubPoolClient
) {
  const allMessagesWithStatuses = await getAllMessageStatuses(tokensBridged, logger, l1Signer);
  const statusesGrouped = groupObjectCountsByTwoProps(allMessagesWithStatuses, "status", (message) => message["token"]);
  logger.debug({
    at: "ArbitrumFinalizer",
    message: "Queried outbox statuses for messages",
    statusesGrouped,
  });
  const finalizableMessages = allMessagesWithStatuses.filter(
    (x) => x.status === L2ToL1MessageStatus[L2ToL1MessageStatus.CONFIRMED]
  );
  if (finalizableMessages.length > 0) {
    logger.debug({
      at: "ArbitrumFinalizer",
      message: `Found ${finalizableMessages.length} L2 token bridges to L1 that are confirmed and can be finalized`,
      bridges: finalizableMessages.map((x) => {
        const copy: any = { ...x.info };
        const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
          "42161",
          x.info.l2TokenAddress,
          hubPoolClient.latestBlockNumber
        );
        const l1TokenInfo = hubPoolClient.getTokenInfo(1, l1TokenCounterpart);
        copy.token = l1TokenInfo.symbol;
        copy.amountToReturn = convertFromWei(copy.amountToReturn.toString(), l1TokenInfo.decimals);
        delete copy.l2TokenAddress;
        return copy;
      }),
    });
  } else
    logger.debug({
      at: "ArbitrumFinalizer",
      message: "No finalizable messages",
    });
  return finalizableMessages;
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
  ).map((result, i) => {
    return {
      ...result,
      token: tokensBridged[i].l2TokenAddress,
      info: tokensBridged[i],
    };
  });
}
export async function getMessageOutboxStatusAndProof(
  logger: winston.Logger,
  event: TokensBridged,
  l1Signer: Wallet,
  logIndex: number
): Promise<{
  message: L2ToL1MessageWriter;
  proofInfo: MessageBatchProofInfo;
  status: string;
}> {
  const l2Provider = getProvider(42161);
  const receipt = await l2Provider.getTransactionReceipt(event.transactionHash);
  const l2Receipt = new L2TransactionReceipt(receipt);

  // Get L2-to-L1 message objects contained in transaction. In principle, a single transaction could trigger
  // any number of outgoing messages; the common case will be there's only one. In the context of Across V2,
  // there should only ever be one.
  const l2ToL1Messages = await l2Receipt.getL2ToL1Messages(l1Signer, await getL2Network(l2Provider));
  if (l2ToL1Messages.length === 0 || l2ToL1Messages.length - 1 < logIndex) {
    const error = new Error(`No outgoing messages found in transaction:${event.transactionHash}`);
    logger.error({
      at: "ArbitrumFinalizer",
      message: "Transaction that emitted TokensBridged event unexpectedly contains 0 L2-to-L1 messages 🤢!",
      logIndex,
      l2ToL1Messages: l2ToL1Messages.length,
      txnHash: event.transactionHash,
      error,
      notificationPath: "across-error",
    });
    throw error;
  }

  const l2Message = l2ToL1Messages[logIndex];

  // Now fetch the proof info we'll need in order to execute or check execution status.
  const proofInfo = await l2Message.tryGetProof(l2Provider);

  // Check if already executed or unconfirmed (i.e. not yet available to be executed on L1 following dispute
  // window)
  if (await l2Message.hasExecuted(proofInfo)) {
    return {
      message: l2Message,
      proofInfo: undefined,
      status: L2ToL1MessageStatus[L2ToL1MessageStatus.EXECUTED],
    };
  }
  const outboxMessageExecutionStatus = await l2Message.status(proofInfo);
  if (outboxMessageExecutionStatus !== L2ToL1MessageStatus.CONFIRMED) {
    return {
      message: l2Message,
      proofInfo: undefined,
      status: L2ToL1MessageStatus[L2ToL1MessageStatus.UNCONFIRMED],
    };
  }

  // Now that its confirmed and not executed, we can use the Merkle proof data to execute our
  // message in its outbox entry.
  return {
    message: l2Message,
    proofInfo,
    status: L2ToL1MessageStatus[outboxMessageExecutionStatus],
  };
}
