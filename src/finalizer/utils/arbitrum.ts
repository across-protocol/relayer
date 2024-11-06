import { L2ToL1MessageStatus, L2TransactionReceipt, L2ToL1MessageWriter } from "@arbitrum/sdk";
import {
  winston,
  convertFromWei,
  groupObjectCountsByProp,
  Contract,
  getCachedProvider,
  getUniqueLogIndex,
  Signer,
  getCurrentTime,
  getRedisCache,
  getBlockForTimestamp,
  getL1TokenInfo,
  compareAddressesSimple,
  TOKEN_SYMBOLS_MAP,
  CHAIN_IDs,
  ethers,
  paginatedEventQuery,
} from "../../utils";
import { TokensBridged } from "../../interfaces";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { CONTRACT_ADDRESSES, Multicall2Call } from "../../common";
import { FinalizerPromise, CrossChainMessage } from "../types";

const CHAIN_ID = CHAIN_IDs.ARBITRUM;

export async function arbitrumOneFinalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient
): Promise<FinalizerPromise> {
  const { chainId } = spokePoolClient;

  // Arbitrum takes 7 days to finalize withdrawals, so don't look up events younger than that.
  const redis = await getRedisCache(logger);
  const latestBlockToFinalize = await getBlockForTimestamp(
    chainId,
    getCurrentTime() - 7 * 60 * 60 * 24,
    undefined,
    redis
  );
  logger.debug({
    at: "Finalizer#ArbitrumFinalizer",
    message: "Arbitrum TokensBridged event filter",
    toBlock: latestBlockToFinalize,
  });
  // Skip events that are likely not past the seven day challenge period.
  const olderTokensBridgedEvents = spokePoolClient.getTokensBridged().filter(
    (e) =>
      e.blockNumber <= latestBlockToFinalize &&
      // USDC withdrawals for Arbitrum should be finalized via the CCTP Finalizer.
      !compareAddressesSimple(e.l2TokenAddress, TOKEN_SYMBOLS_MAP["USDC"].addresses[CHAIN_ID])
  );

  // Experimental feature: Add in all ETH withdrawals from Arbitrum Orbit chain to the finalizer. This will help us
  // in the short term to automate ETH withdrawals from Lite chains, which can build up ETH balances over time
  // and because they are lite chains, our only way to withdraw them is to initiate a slow bridge of ETH from the
  // the lite chain to Ethereum.
  const withdrawalToAddresses: string[] = process.env.FINALIZER_WITHDRAWAL_TO_ADDRESSES
    ? JSON.parse(process.env.FINALIZER_WITHDRAWAL_TO_ADDRESSES).map((address) => ethers.utils.getAddress(address))
    : [];
    if (!CONTRACT_ADDRESSES[chainId].erc20GatewayRouter) {
      logger.warn({
        at: "ArbitrumFinalizer",
        message: `No erc20GatewayRouter contract found for chain ${chainId} in CONTRACT_ADDRESSES`,
      });
    } else if (withdrawalToAddresses.length > 0) {
      const arbitrumGatewayRouter = new Contract(
        CONTRACT_ADDRESSES[chainId].erc20GatewayRouter.address,
        CONTRACT_ADDRESSES[chainId].erc20GatewayRouter.abi,
        spokePoolClient.spokePool.provider
      );
      const arbitrumGateway = await arbitrumGatewayRouter.getGateway(TOKEN_SYMBOLS_MAP.WETH.addresses[chainId]);
      // TODO: For this to work for ArbitrumOrbit, we need to first query ERC20GatewayRouter.getGateway(l2Token) to
      // get the ERC20 Gateway. Then, on the ERC20 Gateway, query the WithdrawalInitiated event.
      // See example txn: https://evm-explorer.alephzero.org/tx/0xb493174af0822c1a5a5983c2cbd4fe74055ee70409c777b9c665f417f89bde92
      // which withdraws WETH to mainnet using dev wallet.
      const withdrawalEvents = await paginatedEventQuery(
        arbitrumGateway,
        arbitrumGateway.filters.WithdrawalInitiated(
          null, // from
          withdrawalToAddresses // to
        ),
        {
          ...spokePoolClient.eventSearchConfig,
          toBlock: spokePoolClient.latestBlockSearched,
        }
      );
      // If there are any found withdrawal initiated events, then add them to the list of TokenBridged events we'll
      // submit proofs and finalizations for.
      withdrawalEvents.forEach((event) => {
        const tokenBridgedEvent: TokensBridged = {
          ...event,
          amountToReturn: event.args.amount,
          chainId,
          leafId: 0,
          l2TokenAddress: TOKEN_SYMBOLS_MAP.WETH.addresses[chainId],
        };
        if (event.blockNumber <= latestBlockToFinalize) {
          olderTokensBridgedEvents.push(tokenBridgedEvent);
        }
      });
    }

  return await multicallArbitrumFinalizations(olderTokensBridgedEvents, signer, hubPoolClient, logger);
}

async function multicallArbitrumFinalizations(
  tokensBridged: TokensBridged[],
  hubSigner: Signer,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<FinalizerPromise> {
  const finalizableMessages = await getFinalizableMessages(logger, tokensBridged, hubSigner);
  const callData = await Promise.all(finalizableMessages.map((message) => finalizeArbitrum(message.message)));
  const crossChainTransfers = finalizableMessages.map(({ info: { l2TokenAddress, amountToReturn } }) => {
    const l1TokenInfo = getL1TokenInfo(l2TokenAddress, CHAIN_ID);
    const amountFromWei = convertFromWei(amountToReturn.toString(), l1TokenInfo.decimals);
    const withdrawal: CrossChainMessage = {
      originationChainId: CHAIN_ID,
      l1TokenSymbol: l1TokenInfo.symbol,
      amount: amountFromWei,
      type: "withdrawal",
      destinationChainId: hubPoolClient.chainId,
    };

    return withdrawal;
  });
  return {
    callData,
    crossChainMessages: crossChainTransfers,
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
      const error = new Error(
        `No outgoing messages found in transaction:${event.transactionHash} for l2 token ${event.l2TokenAddress}`
      );
      logger.warn({
        at: "ArbitrumFinalizer",
        message: "Arbitrum transaction that emitted TokensBridged event unexpectedly contains 0 L2-to-L1 messages 🤢!",
        logIndex,
        l2ToL1Messages: l2ToL1Messages.length,
        event,
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
