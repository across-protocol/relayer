import { utils as sdkUtils } from "@across-protocol/sdk";
import { OnChainMessageStatus } from "@consensys/linea-sdk";
import { Contract } from "ethers";
import { groupBy } from "lodash";
import { HubPoolClient, SpokePoolClient } from "../../../clients";
import { CHAIN_MAX_BLOCK_LOOKBACK, CONTRACT_ADDRESSES } from "../../../common";
import { EventSearchConfig, Signer, convertFromWei, retryAsync, winston, CHAIN_IDs } from "../../../utils";
import { CrossChainMessage, FinalizerPromise } from "../../types";
import {
  determineMessageType,
  findMessageFromTokenBridge,
  findMessageFromUsdcBridge,
  findMessageSentEvents,
  getBlockRangeByHoursOffsets,
  initLineaSdk,
} from "./common";

export async function lineaL1ToL2Finalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _spokePoolClient: SpokePoolClient,
  l1ToL2AddressesToFinalize: string[]
): Promise<FinalizerPromise> {
  const [l1ChainId] = [hubPoolClient.chainId, hubPoolClient.hubPool.address];
  if (l1ChainId !== CHAIN_IDs.MAINNET) {
    throw new Error("Finalizations for Linea testnet is not supported.");
  }
  const l2ChainId = CHAIN_IDs.LINEA;
  const lineaSdk = initLineaSdk(l1ChainId, l2ChainId);
  const l2MessageServiceContract = lineaSdk.getL2Contract();
  const l1MessageServiceContract = lineaSdk.getL1Contract();
  const l1TokenBridge = new Contract(
    CONTRACT_ADDRESSES[l1ChainId].lineaL1TokenBridge.address,
    CONTRACT_ADDRESSES[l1ChainId].lineaL1TokenBridge.abi,
    hubPoolClient.hubPool.provider
  );
  const l1UsdcBridge = new Contract(
    CONTRACT_ADDRESSES[l1ChainId].lineaL1UsdcBridge.address,
    CONTRACT_ADDRESSES[l1ChainId].lineaL1UsdcBridge.abi,
    hubPoolClient.hubPool.provider
  );

  // Optimize block range for querying Linea's MessageSent events on L1.
  const { fromBlock, toBlock } = await getBlockRangeByHoursOffsets(l1ChainId, 24 * 7, 0);
  logger.debug({
    at: "Finalizer#LineaL1ToL2Finalizer",
    message: "Linea MessageSent event filter",
    fromBlock,
    toBlock,
  });

  const searchConfig: EventSearchConfig = {
    fromBlock,
    toBlock,
    maxBlockLookBack: CHAIN_MAX_BLOCK_LOOKBACK[l1ChainId] || 10_000,
  };

  const [wethAndRelayEvents, tokenBridgeEvents, usdcBridgeEvents] = await Promise.all([
    findMessageSentEvents(l1MessageServiceContract, l1ToL2AddressesToFinalize, searchConfig),
    findMessageFromTokenBridge(l1TokenBridge, l1MessageServiceContract, l1ToL2AddressesToFinalize, searchConfig),
    findMessageFromUsdcBridge(l1UsdcBridge, l1MessageServiceContract, l1ToL2AddressesToFinalize, searchConfig),
  ]);

  const messageSentEvents = [...wethAndRelayEvents, ...tokenBridgeEvents, ...usdcBridgeEvents];
  const enrichedMessageSentEvents = await sdkUtils.mapAsync(messageSentEvents, async (event) => {
    const {
      transactionHash: txHash,
      logIndex,
      args: { _from, _to, _fee, _value, _nonce, _calldata, _messageHash },
    } = event;
    // It's unlikely that our multicall will have multiple transactions to bridge to Linea
    // so we can grab the statuses individually.

    // The Linea SDK MessageServiceContract constructs its own Provider without our retry logic so we retry each call
    // twice with a 1 second delay between in case of intermittent RPC failures.
    const messageStatus = await retryAsync(() => l2MessageServiceContract.getMessageStatus(_messageHash), 2, 1);
    return {
      messageSender: _from,
      destination: _to,
      fee: _fee,
      value: _value,
      messageNonce: _nonce,
      calldata: _calldata,
      messageHash: _messageHash,
      txHash,
      logIndex,
      status: messageStatus,
      messageType: determineMessageType(event, hubPoolClient),
    };
  });
  // Group messages by status
  const {
    claimed = [],
    claimable = [],
    unknown = [],
  } = groupBy(enrichedMessageSentEvents, (message) => {
    switch (message.status) {
      case OnChainMessageStatus.CLAIMED:
        return "claimed";
      case OnChainMessageStatus.CLAIMABLE:
        return "claimable";
      default:
        return "unknown";
    }
  });

  // Populate txns for claimable messages
  const populatedTxns = await Promise.all(
    claimable.map(async (message) => {
      return l2MessageServiceContract.contract.populateTransaction.claimMessage(
        message.messageSender,
        message.destination,
        message.fee,
        message.value,
        await signer.getAddress(),
        message.calldata,
        message.messageNonce
      );
    })
  );
  const multicall3Call = populatedTxns.map((txn) => ({
    target: l2MessageServiceContract.contractAddress,
    callData: txn.data,
  }));

  // Populate cross chain calls for claimable messages
  const messages = claimable.flatMap(({ messageType }) => {
    let crossChainCall: CrossChainMessage;
    if (messageType.type === "misc") {
      crossChainCall = {
        originationChainId: l1ChainId,
        destinationChainId: l2ChainId,
        type: "misc",
        miscReason: "lineaClaim:relayMessage",
      };
    } else {
      const { decimals, symbol: l1TokenSymbol } = hubPoolClient.getTokenInfo(l1ChainId, messageType.l1TokenAddress);
      const amountFromWei = convertFromWei(messageType.amount.toString(), decimals);
      crossChainCall = {
        originationChainId: l1ChainId,
        destinationChainId: l2ChainId,
        l1TokenSymbol,
        amount: amountFromWei,
        type: "deposit",
      };
    }
    return crossChainCall;
  });

  logger.debug({
    at: "Finalizer#LineaL1ToL2Finalizer",
    message: "Linea L1->L2 message statuses",
    statuses: {
      claimed: claimed.length,
      claimable: claimable.length,
      notReceived: unknown.length,
    },
  });

  return { callData: multicall3Call, crossChainMessages: messages };
}
