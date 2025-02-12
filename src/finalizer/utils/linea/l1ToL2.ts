import { utils as sdkUtils } from "@across-protocol/sdk";
import { OnChainMessageStatus } from "@consensys/linea-sdk";
import { Contract } from "ethers";
import { groupBy } from "lodash";
import { HubPoolClient, SpokePoolClient } from "../../../clients";
import { CONTRACT_ADDRESSES } from "../../../common";
import { EventSearchConfig, Signer, convertFromWei, winston, CHAIN_IDs, ethers, BigNumber } from "../../../utils";
import { CrossChainMessage, FinalizerPromise } from "../../types";
import {
  determineMessageType,
  findMessageFromTokenBridge,
  findMessageFromUsdcBridge,
  findMessageSentEvents,
  getL1MessageServiceContractFromL1ClaimingService,
  initLineaSdk,
} from "./common";
import { L2MessageServiceContract } from "./imports";

const L1L2MessageStatuses = {
  0: "UNKNOWN",
  1: "CLAIMABLE",
  2: "CLAIMED",
};
// Temporary re-implementation of the SDK's `L2MessageServiceContract.getMessageStatus` functions that allow us to use
// our custom provider, with retry and caching logic, to get around the SDK's hardcoded logic to query events
// from 0 to "latest" which will not work on all RPC's.
async function getL1ToL2MessageStatusUsingCustomProvider(
  messageService: L2MessageServiceContract,
  messageHash: string,
  l2Provider: ethers.providers.Provider
): Promise<OnChainMessageStatus> {
  const l2Contract = messageService.contract.connect(l2Provider);
  const status: BigNumber = await l2Contract.inboxL1L2MessageStatus(messageHash);
  return L1L2MessageStatuses[status.toString()];
}

export async function lineaL1ToL2Finalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  l2SpokePoolClient: SpokePoolClient,
  l1SpokePoolClient: SpokePoolClient,
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

  const searchConfig: EventSearchConfig = {
    fromBlock: l1SpokePoolClient.eventSearchConfig.fromBlock,
    toBlock: l1SpokePoolClient.latestBlockSearched,
    maxBlockLookBack: l1SpokePoolClient.eventSearchConfig.maxBlockLookBack,
  };

  const [wethAndRelayEvents, tokenBridgeEvents, usdcBridgeEvents] = await Promise.all([
    findMessageSentEvents(
      getL1MessageServiceContractFromL1ClaimingService(lineaSdk.getL1ClaimingService(), hubPoolClient.hubPool.provider),
      l1ToL2AddressesToFinalize,
      searchConfig
    ),
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

    const messageStatus = await getL1ToL2MessageStatusUsingCustomProvider(
      l2MessageServiceContract,
      _messageHash,
      l2SpokePoolClient.spokePool.provider
    );
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
