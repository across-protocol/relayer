import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { OnChainMessageStatus } from "@consensys/linea-sdk";
import { MessageSentEvent } from "@consensys/linea-sdk/dist/typechain/LineaRollup";
import { Contract } from "ethers";
import { getAddress } from "ethers/lib/utils";
import { groupBy } from "lodash";
import { HubPoolClient, SpokePoolClient } from "../../../clients";
import { CHAIN_MAX_BLOCK_LOOKBACK } from "../../../common";
import { Signer, convertFromWei, paginatedEventQuery, winston } from "../../../utils";
import { CrossChainMessage, FinalizerPromise } from "../../types";
import { determineMessageType, getBlockRangeByHoursOffsets, initLineaSdk } from "./common";

export async function lineaL1ToL2Finalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _spokePoolClient: SpokePoolClient,
  l1ToL2AddressesToFinalize: string[]
): Promise<FinalizerPromise> {
  const [l1ChainId, hubPoolAddress] = [hubPoolClient.chainId, hubPoolClient.hubPool.address];
  const l2ChainId = l1ChainId === 1 ? 59144 : 59140;
  const lineaSdk = initLineaSdk(l1ChainId, l2ChainId);
  const l2Contract = lineaSdk.getL2Contract();
  const l1Contract = lineaSdk.getL1Contract();

  // We always want to make sure that the l1ToL2AddressesToFinalize array contains
  // the HubPool address, so we can finalize any pending messages sent from the HubPool.
  if (!l1ToL2AddressesToFinalize.includes(getAddress(hubPoolAddress))) {
    l1ToL2AddressesToFinalize.push(hubPoolAddress);
  }

  // Optimize block range for querying Linea's MessageSent events on L1.
  // We want to conservatively query for events that are between 0 and 24 hours old
  // because Linea L1->L2 messages are claimable after ~20 mins.
  const { fromBlock, toBlock } = await getBlockRangeByHoursOffsets(l1ChainId, 24, 0);
  logger.debug({
    at: "Finalizer#LineaL1ToL2Finalizer",
    message: "Linea MessageSent event filter",
    fromBlock,
    toBlock,
  });

  // Get Linea's `MessageSent` events originating from the L1->L2 addresses to finalize
  // Note: An array passed to `filters.MessageSent` will be OR'd together
  const messageSentEvents = (await paginatedEventQuery(
    l1Contract.contract,
    (l1Contract.contract as Contract).filters.MessageSent(l1ToL2AddressesToFinalize),
    {
      fromBlock,
      toBlock,
      maxBlockLookBack: CHAIN_MAX_BLOCK_LOOKBACK[l1ChainId] || 10_000,
    }
  )) as MessageSentEvent[];
  const enrichedMessageSentEvents = await sdkUtils.mapAsync(messageSentEvents, async (event) => {
    const {
      transactionHash: txHash,
      logIndex,
      args: { _from, _to, _fee, _value, _nonce, _calldata, _messageHash },
    } = event;
    // It's unlikely that our multicall will have multiple transactions to bridge to Linea
    // so we can grab the statuses individually.
    const messageStatus = await l2Contract.getMessageStatus(_messageHash);
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
      return l2Contract.contract.populateTransaction.claimMessage(
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
    target: l2Contract.contractAddress,
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
