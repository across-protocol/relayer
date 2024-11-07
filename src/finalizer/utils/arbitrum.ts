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
  ethers,
  paginatedEventQuery,
  averageBlockTime
} from "../../utils";
import { TokensBridged } from "../../interfaces";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { CONTRACT_ADDRESSES, Multicall2Call } from "../../common";
import { FinalizerPromise, CrossChainMessage } from "../types";
import ARBITRUM_ERC20_GATEWAY_L2_ABI from "../../common/abi/ArbitrumErc20GatewayL2.json";

let LATEST_MAINNET_BLOCK: number = 0;

export async function arbitrumOneFinalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient
): Promise<FinalizerPromise> {
  LATEST_MAINNET_BLOCK = hubPoolClient.latestBlockSearched;
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
      !compareAddressesSimple(e.l2TokenAddress, TOKEN_SYMBOLS_MAP["USDC"].addresses[chainId])
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
      const arbitrumGatewayAddress = await arbitrumGatewayRouter.getGateway(TOKEN_SYMBOLS_MAP.WETH.addresses[chainId]);
    const arbitrumGateway = new Contract(
      arbitrumGatewayAddress,
      ARBITRUM_ERC20_GATEWAY_L2_ABI,
      spokePoolClient.spokePool.provider
    );
      // TODO: For this to work for ArbitrumOrbit, we need to first query ERC20GatewayRouter.getGateway(l2Token) to
      // get the ERC20 Gateway. Then, on the ERC20 Gateway, query the WithdrawalInitiated event.
      // See example txn: https://evm-explorer.alephzero.org/tx/0xb493174af0822c1a5a5983c2cbd4fe74055ee70409c777b9c665f417f89bde92
      // which withdraws WETH to mainnet using dev wallet.
      const withdrawalEvents = await paginatedEventQuery(
        arbitrumGateway,
        arbitrumGateway.filters.WithdrawalInitiated(
          null, // l1Token, not-indexed so can't filter
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
      withdrawalEvents.filter((e) => e.args.l1Token === TOKEN_SYMBOLS_MAP.WETH.addresses[hubPoolClient.chainId]).forEach((event) => {
        const tokenBridgedEvent: TokensBridged = {
          ...event,
          amountToReturn: event.args._amount,
          chainId,
          leafId: 0,
          l2TokenAddress: TOKEN_SYMBOLS_MAP.WETH.addresses[chainId],
        };
        // if (event.blockNumber <= latestBlockToFinalize) {
          olderTokensBridgedEvents.push(tokenBridgedEvent);
        // }
      });
    }

  return await multicallArbitrumFinalizations(chainId, olderTokensBridgedEvents, signer, hubPoolClient, logger);
}

async function multicallArbitrumFinalizations(
  chainId: number,
  tokensBridged: TokensBridged[],
  hubSigner: Signer,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<FinalizerPromise> {
  const finalizableMessages = await getFinalizableMessages(chainId, logger, tokensBridged, hubSigner);
  const callData = await Promise.all(finalizableMessages.map((message) => finalizeArbitrum(chainId, message.message)));
  const crossChainTransfers = finalizableMessages.map(({ info: { l2TokenAddress, amountToReturn } }) => {
    const l1TokenInfo = getL1TokenInfo(l2TokenAddress, chainId);
    const amountFromWei = convertFromWei(amountToReturn.toString(), l1TokenInfo.decimals);
    const withdrawal: CrossChainMessage = {
      originationChainId: chainId,
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

async function finalizeArbitrum(chainId, message: L2ToL1MessageWriter): Promise<Multicall2Call> {
  const l2Provider = getCachedProvider(chainId, true);
  const proof = await message.getOutboxProof(l2Provider);
  const outboxData = CONTRACT_ADDRESSES[chainId][`arbOutbox_${chainId}`];
  if (!outboxData) {
    throw new Error(`Missing arbOutbox entry in CONTRACT_ADDRESSES for chain ${chainId}`)
  }
  const { address, abi } = outboxData;
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
  chainId: number,
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
  const allMessagesWithStatuses = await getAllMessageStatuses(chainId, tokensBridged, logger, l1Signer);
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
  chainId: number,
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
      tokensBridged.map((e, i) => getMessageOutboxStatusAndProof(chainId, logger, e, mainnetSigner, logIndexesForMessage[i]))
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
  chainId: number,
  logger: winston.Logger,
  event: TokensBridged,
  l1Signer: Signer,
  logIndex: number
): Promise<{
  message: L2ToL1MessageWriter;
  status: string;
  estimatedFinalizationBlock?: number;
}> {
  const l2Provider = getCachedProvider(chainId, true);
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
      const estimatedFinalizationBlock = await l2Message.getFirstExecutableBlock(l2Provider);
      const estimatedFinalizationBlockDelta = estimatedFinalizationBlock.toNumber() - LATEST_MAINNET_BLOCK
      const mainnetBlockTime = 12
      logger.debug({
        at: "ArbitrumFinalizer",
        message: `Unconfirmed withdrawal can be finalized in ${
          (estimatedFinalizationBlockDelta * mainnetBlockTime) / 60 / 60
        } hours`,
        chainId,
        token: event.l2TokenAddress,
        amount: event.amountToReturn,
        receipt: l2Receipt.transactionHash
      })
      return {
        estimatedFinalizationBlock: estimatedFinalizationBlock.toNumber(),
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
    console.error(error)
    // Likely L1 message hasn't been included in an arbitrum batch yet, so ignore it for now.
    return {
      message: undefined,
      status: L2ToL1MessageStatus[L2ToL1MessageStatus.UNCONFIRMED],
    };
  }
}
