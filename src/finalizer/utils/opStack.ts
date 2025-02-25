import assert from "assert";
import { groupBy, countBy } from "lodash";
import * as optimismSDK from "@eth-optimism/sdk";
import * as viem from "viem";
import * as viemChains from "viem/chains";
import {
  getWithdrawals,
  GetWithdrawalStatusReturnType,
  buildProveWithdrawal,
  getWithdrawalStatus,
  getL2Output,
  getTimeToFinalize,
} from "viem/op-stack";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { TokensBridged } from "../../interfaces";
import {
  CHAIN_IDs,
  chainIsOPStack,
  compareAddressesSimple,
  convertFromWei,
  getBlockForTimestamp,
  getCachedProvider,
  getCurrentTime,
  getL1TokenInfo,
  getNetworkName,
  getRedisCache,
  getUniqueLogIndex,
  groupObjectCountsByProp,
  Signer,
  TOKEN_SYMBOLS_MAP,
  winston,
  chainIsProd,
  Contract,
  ethers,
  Multicall2Call,
  mapAsync,
  paginatedEventQuery,
  getCctpDomainForChainId,
  createViemCustomTransportFromEthersProvider,
} from "../../utils";
import { CONTRACT_ADDRESSES, OPSTACK_CONTRACT_OVERRIDES } from "../../common";
import OPStackPortalL1 from "../../common/abi/OpStackPortalL1.json";
import { FinalizerPromise, CrossChainMessage } from "../types";
const { utils } = ethers;

interface CrossChainMessageWithEvent {
  event: TokensBridged;
  message: optimismSDK.MessageLike;
}

interface CrossChainMessageWithStatus extends CrossChainMessageWithEvent {
  status: string;
  logIndex: number;
}

const OP_STACK_CHAINS = Object.values(CHAIN_IDs).filter((chainId) => chainIsOPStack(chainId));
/* OP_STACK_CHAINS should contain all chains which satisfy chainIsOPStack().
 * (typeof OP_STACK_CHAINS)[number] then takes all elements in this array and "unions" their type (i.e. 10 | 8453 | 3443 | ... ).
 * https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-1.html#keyof-and-lookup-types
 */

// We might want to export this mapping of chain ID to viem chain object out of a constant
// file once we start using Viem elsewhere in the repo:
const VIEM_OP_STACK_CHAINS: Record<number, viem.Chain> = {
  [CHAIN_IDs.OPTIMISM]: viemChains.optimism,
  [CHAIN_IDs.BASE]: viemChains.base,
  [CHAIN_IDs.REDSTONE]: viemChains.redstone,
  [CHAIN_IDs.LISK]: viemChains.lisk,
  [CHAIN_IDs.ZORA]: viemChains.zora,
  [CHAIN_IDs.MODE]: viemChains.mode,
  [CHAIN_IDs.WORLD_CHAIN]: viemChains.worldchain,
  [CHAIN_IDs.SONEIUM]: viemChains.soneium,
  [CHAIN_IDs.UNICHAIN]: viemChains.unichain,
  [CHAIN_IDs.INK]: viemChains.ink,
  // // @dev The following chains have non-standard interfaces or processes for withdrawing from L2 to L1
  // [CHAIN_IDs.BLAST]: viemChains.blast,
};

type OVM_CHAIN_ID = (typeof OP_STACK_CHAINS)[number];
type OVM_CROSS_CHAIN_MESSENGER = optimismSDK.CrossChainMessenger;

const BLAST_CLAIM_NOT_READY = 0;
// Start ID used to query hint ID's on Blast L1 yield manager, this should never change.
const BLAST_YIELD_MANAGER_STARTING_REQUEST_ID = 1;
export const chainIsBlast = (chainId: OVM_CHAIN_ID): boolean =>
  [CHAIN_IDs.BLAST, CHAIN_IDs.BLAST_SEPOLIA].includes(chainId);

export async function opStackFinalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient
): Promise<FinalizerPromise> {
  const { chainId } = spokePoolClient;
  assert(chainIsOPStack(chainId), `Unsupported OP Stack chain ID: ${chainId}`);
  const networkName = getNetworkName(chainId);

  // Optimism withdrawals take 7 days to finalize, while proofs are ready as soon as an L1 txn containing the L2
  // withdrawal is posted to Mainnet, so ~30 mins.
  // Sort tokensBridged events by their age. Submit proofs for recent events, and withdrawals for older events.
  // - Don't submit proofs for finalizations older than 1 day
  // - Don't try to withdraw tokens that are not past the 7 day challenge period
  const redis = await getRedisCache(logger);
  const minimumFinalizationTime = getCurrentTime() - 7 * 3600 * 24;
  const latestBlockToProve = await getBlockForTimestamp(chainId, minimumFinalizationTime, undefined, redis);
  const { recentTokensBridgedEvents = [], olderTokensBridgedEvents = [] } = groupBy(
    spokePoolClient.getTokensBridged().filter(
      (e) =>
        // USDC withdrawals for Base and Optimism should be finalized via the CCTP Finalizer.
        !compareAddressesSimple(e.l2TokenAddress, TOKEN_SYMBOLS_MAP["USDC"].addresses[chainId]) ||
        !(getCctpDomainForChainId(chainId) > 0) // Cannot be -1 and cannot be 0.
    ),
    (e) => {
      if (e.blockNumber >= latestBlockToProve) {
        return "recentTokensBridgedEvents";
      } else {
        return "olderTokensBridgedEvents";
      }
    }
  );
  // First submit proofs for any newly withdrawn tokens. You can submit proofs for any withdrawals that have been
  // snapshotted on L1, so it takes roughly 1 hour from the withdrawal time
  logger.debug({
    at: `${networkName}Finalizer`,
    message: `Latest TokensBridged block to attempt to submit proofs for ${networkName}`,
    latestBlockToProve,
  });

  // Add in all manual withdrawals from other EOA's from OPStack chain to the finalizer. This will help us
  // automate token withdrawals from Lite chains, which can build up ETH and ERC20 balances over time
  // and because they are lite chains, our only way to withdraw them is to initiate a manual bridge from the
  // the lite chain to Ethereum via the canonical OVM standard bridge.
  const withdrawalToAddresses: string[] = process.env.FINALIZER_WITHDRAWAL_TO_ADDRESSES
    ? JSON.parse(process.env.FINALIZER_WITHDRAWAL_TO_ADDRESSES).map((address) => ethers.utils.getAddress(address))
    : [];
  if (!CONTRACT_ADDRESSES[chainId].ovmStandardBridge) {
    logger.warn({
      at: `${networkName}Finalizer`,
      message: `No OVM standard bridge contract found for chain ${networkName} in CONTRACT_ADDRESSES`,
    });
  } else if (withdrawalToAddresses.length > 0) {
    const ovmStandardBridge = new Contract(
      CONTRACT_ADDRESSES[chainId].ovmStandardBridge.address,
      CONTRACT_ADDRESSES[chainId].ovmStandardBridge.abi,
      spokePoolClient.spokePool.provider
    );
    const withdrawalEthEvents = (
      await paginatedEventQuery(
        ovmStandardBridge,
        ovmStandardBridge.filters.ETHBridgeInitiated(
          null, // from
          withdrawalToAddresses // to
        ),
        {
          ...spokePoolClient.eventSearchConfig,
          toBlock: spokePoolClient.latestBlockSearched,
        }
      )
    ).map((event) => {
      return {
        ...event,
        l2TokenAddress: TOKEN_SYMBOLS_MAP.WETH.addresses[chainId],
      };
    });
    const withdrawalErc20Events = (
      await paginatedEventQuery(
        ovmStandardBridge,
        ovmStandardBridge.filters.ERC20BridgeInitiated(
          null, // localToken
          null, // remoteToken
          withdrawalToAddresses // from
        ),
        {
          ...spokePoolClient.eventSearchConfig,
          toBlock: spokePoolClient.latestBlockSearched,
        }
      )
    ).map((event) => {
      // If we're aware of this token, then save the event as one we can finalize.
      try {
        getL1TokenInfo(event.args.localToken, chainId);
        return {
          ...event,
          l2TokenAddress: event.args.localToken,
        };
      } catch (err) {
        logger.debug({
          at: `${networkName}Finalizer`,
          message: `Skipping ERC20 withdrawal event for unknown token ${event.args.localToken} on chain ${networkName}`,
          event: event,
        });
        return undefined;
      }
    });
    const withdrawalEvents = [...withdrawalEthEvents, ...withdrawalErc20Events].filter((event) => event !== undefined);
    // If there are any found withdrawal initiated events, then add them to the list of TokenBridged events we'll
    // submit proofs and finalizations for.
    withdrawalEvents.forEach((event) => {
      const tokenBridgedEvent: TokensBridged = {
        ...event,
        amountToReturn: event.args.amount,
        chainId,
        leafId: 0,
        l2TokenAddress: event.l2TokenAddress,
      };
      if (event.blockNumber >= latestBlockToProve) {
        recentTokensBridgedEvents.push(tokenBridgedEvent);
      } else {
        olderTokensBridgedEvents.push(tokenBridgedEvent);
      }
    });
  }

  let callData: Multicall2Call[];
  let crossChainTransfers: CrossChainMessage[];

  if (VIEM_OP_STACK_CHAINS[chainId]) {
    const viemTxns = await viem_multicallOptimismFinalizations(
      chainId,
      logger,
      signer,
      hubPoolClient,
      olderTokensBridgedEvents,
      recentTokensBridgedEvents
    );
    callData = viemTxns.callData;
    crossChainTransfers = viemTxns.withdrawals;
  } else {
    const crossChainMessenger = getOptimismClient(chainId, signer);
    const proofs = await multicallOptimismL1Proofs(
      chainId,
      recentTokensBridgedEvents,
      crossChainMessenger,
      hubPoolClient,
      logger
    );

    // Next finalize withdrawals that have passed challenge period.
    // Skip events that are likely not past the seven day challenge period.
    logger.debug({
      at: `${networkName}Finalizer`,
      message: "Earliest TokensBridged block to attempt to finalize",
      earliestBlockToFinalize: latestBlockToProve,
    });

    const finalizations = await multicallOptimismFinalizations(
      chainId,
      olderTokensBridgedEvents,
      crossChainMessenger,
      hubPoolClient,
      logger
    );
    callData = [...proofs.callData, ...finalizations.callData];
    crossChainTransfers = [...proofs.withdrawals, ...finalizations.withdrawals];
  }

  return { callData, crossChainMessages: crossChainTransfers };
}

async function viem_multicallOptimismFinalizations(
  chainId: number,
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  olderTokensBridgedEvents: TokensBridged[],
  recentTokensBridgedEvents: TokensBridged[]
): Promise<{
  callData: Multicall2Call[];
  withdrawals: CrossChainMessage[];
}> {
  const viemTxns: {
    callData: Multicall2Call[];
    withdrawals: CrossChainMessage[];
  } = {
    callData: [],
    withdrawals: [],
  };
  const hubChainId = hubPoolClient.chainId;
  const publicClientL1 = viem.createPublicClient({
    batch: {
      multicall: true,
    },
    chain: chainIsProd(chainId) ? viemChains.mainnet : viemChains.sepolia,
    transport: createViemCustomTransportFromEthersProvider(hubChainId),
  });
  const publicClientL2 = viem.createPublicClient({
    batch: {
      multicall: true,
    },
    chain: VIEM_OP_STACK_CHAINS[chainId],
    transport: createViemCustomTransportFromEthersProvider(chainId),
  });
  const uniqueTokenhashes = {};
  const logIndexesForMessage = [];
  const events = [...olderTokensBridgedEvents, ...recentTokensBridgedEvents];
  for (const event of events) {
    uniqueTokenhashes[event.transactionHash] ??= 0;
    const logIndex = uniqueTokenhashes[event.transactionHash];
    logIndexesForMessage.push(logIndex);
    uniqueTokenhashes[event.transactionHash] += 1;
  }

  const crossChainMessenger = new Contract(
    VIEM_OP_STACK_CHAINS[chainId].contracts.portal[hubChainId].address,
    OPStackPortalL1,
    signer
  );
  const sourceId = VIEM_OP_STACK_CHAINS[chainId].sourceId;

  // The following viem SDK functions all require the Viem Chain object to either have a portal + disputeGameFactory
  // address defined, or for legacy OpStack chains, the l2OutputOracle address defined.
  const { contracts } = VIEM_OP_STACK_CHAINS[chainId];
  const viemOpStackTargetChainParam: {
    contracts: {
      portal: { [sourceId: number]: { address: `0x${string}` } };
      l2OutputOracle: { [sourceId: number]: { address: `0x${string}` } };
      disputeGameFactory: { [sourceId: number]: { address: `0x${string}` } };
    };
  } = {
    contracts: {
      portal: {
        [sourceId]: {
          address: contracts.portal[sourceId].address,
        },
      },
      l2OutputOracle: {
        [sourceId]: { address: contracts.l2OutputOracle?.[sourceId]?.address ?? viem.zeroAddress },
      },
      disputeGameFactory: {
        [sourceId]: { address: contracts.disputeGameFactory?.[sourceId]?.address ?? viem.zeroAddress },
      },
    },
  };

  const withdrawalStatuses: string[] = [];
  await mapAsync(events, async (event, i) => {
    // Useful information for event:
    const l1TokenInfo = getL1TokenInfo(event.l2TokenAddress, chainId);
    const amountFromWei = convertFromWei(event.amountToReturn.toString(), l1TokenInfo.decimals);

    const receipt = await publicClientL2.getTransactionReceipt({
      hash: event.transactionHash as `0x${string}`,
    });
    const withdrawal = getWithdrawals(receipt)[logIndexesForMessage[i]];
    const withdrawalStatus: GetWithdrawalStatusReturnType = await getWithdrawalStatus(publicClientL1 as viem.Client, {
      receipt,
      chain: publicClientL1.chain as viem.Chain,
      targetChain: viemOpStackTargetChainParam,
      logIndex: logIndexesForMessage[i],
    });
    withdrawalStatuses.push(withdrawalStatus);
    if (withdrawalStatus === "ready-to-prove") {
      const l2Output = await getL2Output(publicClientL1 as viem.Client, {
        chain: publicClientL1.chain as viem.Chain,
        l2BlockNumber: BigInt(event.blockNumber),
        targetChain: viemOpStackTargetChainParam,
      });
      const { l2OutputIndex, outputRootProof, withdrawalProof } = await buildProveWithdrawal(
        publicClientL2 as viem.Client,
        {
          chain: VIEM_OP_STACK_CHAINS[chainId],
          withdrawal,
          output: l2Output,
        }
      );
      const proofArgs = [withdrawal, l2OutputIndex, outputRootProof, withdrawalProof];
      const callData = await crossChainMessenger.populateTransaction.proveWithdrawalTransaction(...proofArgs);
      viemTxns.callData.push({
        callData: callData.data,
        target: crossChainMessenger.address,
      });
      viemTxns.withdrawals.push({
        originationChainId: chainId,
        l1TokenSymbol: l1TokenInfo.symbol,
        amount: amountFromWei,
        type: "misc",
        miscReason: "proof",
        destinationChainId: hubPoolClient.chainId,
      });
    } else if (withdrawalStatus === "waiting-to-finalize") {
      const { seconds } = await getTimeToFinalize(publicClientL1 as viem.Client, {
        chain: VIEM_OP_STACK_CHAINS[hubChainId],
        withdrawalHash: withdrawal.withdrawalHash,
        targetChain: viemOpStackTargetChainParam,
      });
      logger.debug({
        at: `${getNetworkName(chainId)}Finalizer`,
        message: `Withdrawal ${event.transactionHash} for ${amountFromWei} of ${
          l1TokenInfo.symbol
        } is in challenge period for ${(seconds / 3600).toFixed(2)} hours`,
      });
    } else if (withdrawalStatus === "ready-to-finalize") {
      // @dev Some OpStack chains use OptimismPortal instead of the newer OptimismPortal2, the latter of which
      // requires that the msg.sender of the  finalizeWithdrawalTransaction is equal to the address that
      // submitted the proof.
      // See this comment in OptimismPortal2 for more context on why the new portal requires checking the
      // proof submitter address: https://github.com/ethereum-optimism/optimism/blob/d6bda0339005d98c992c749c137938d515755029/packages/contracts-bedrock/src/L1/OptimismPortal2.sol#L132
      let callData: ethers.PopulatedTransaction;
      const portalVersion: string = await crossChainMessenger.version();
      const majorVersion = Number(portalVersion.split(".")[0]);
      if (majorVersion > 3) {
        // Calling OptimismPortal2: https://github.com/ethereum-optimism/optimism/blob/d6bda0339005d98c992c749c137938d515755029/packages/contracts-bedrock/src/L1/OptimismPortal2.sol
        const numProofSubmitters = await crossChainMessenger.numProofSubmitters(withdrawal.withdrawalHash);
        const proofSubmitter = await crossChainMessenger.proofSubmitters(
          withdrawal.withdrawalHash,
          numProofSubmitters - 1
        );
        callData = await crossChainMessenger.populateTransaction.finalizeWithdrawalTransactionExternalProof(
          withdrawal,
          proofSubmitter
        );
      } else {
        // Calling OptimismPortal: https://github.com/ethereum-optimism/optimism/blob/d6bda0339005d98c992c749c137938d515755029/packages/contracts-bedrock/src/L1/OptimismPortal.sol
        callData = await crossChainMessenger.populateTransaction.finalizeWithdrawalTransaction(withdrawal);
      }
      viemTxns.callData.push({
        callData: callData.data,
        target: crossChainMessenger.address,
      });
      viemTxns.withdrawals.push({
        originationChainId: chainId,
        l1TokenSymbol: l1TokenInfo.symbol,
        amount: amountFromWei,
        type: "withdrawal",
        destinationChainId: hubPoolClient.chainId,
      });
    }
  });
  logger.debug({
    at: `${getNetworkName(chainId)}Finalizer`,
    message: "Message statuses",
    statusesGrouped: countBy(withdrawalStatuses),
  });
  return viemTxns;
}

function getOptimismClient(chainId: OVM_CHAIN_ID, hubSigner: Signer): OVM_CROSS_CHAIN_MESSENGER {
  const hubChainId = chainIsProd(chainId) ? CHAIN_IDs.MAINNET : CHAIN_IDs.SEPOLIA;
  const contractOverrides = OPSTACK_CONTRACT_OVERRIDES[chainId];
  return new optimismSDK.CrossChainMessenger({
    bedrock: true,
    l1ChainId: hubChainId,
    l2ChainId: chainId,
    l1SignerOrProvider: hubSigner.connect(getCachedProvider(hubChainId, true)),
    l2SignerOrProvider: hubSigner.connect(getCachedProvider(chainId, true)),
    contracts: contractOverrides,
  });
}

async function getCrossChainMessages(
  _chainId: OVM_CHAIN_ID,
  tokensBridged: TokensBridged[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER
): Promise<CrossChainMessageWithEvent[]> {
  // For each token bridge event, store a unique log index for the event within the optimism transaction hash.
  // This is important for bridge transactions containing multiple events.
  const logIndexesForMessage = getUniqueLogIndex(tokensBridged);

  return (
    await Promise.all(
      tokensBridged.map(async (l2Event, i) => {
        const withdrawals = await crossChainMessenger.getMessagesByTransaction(l2Event.transactionHash, {
          direction: optimismSDK.MessageDirection.L2_TO_L1,
        });
        const logIndexOfEvent = logIndexesForMessage[i];
        assert(logIndexOfEvent < withdrawals.length);
        return withdrawals[logIndexOfEvent];
      })
    )
  ).map((message, i) => {
    return {
      message,
      event: tokensBridged[i],
    };
  });
}

async function getMessageStatuses(
  _chainId: OVM_CHAIN_ID,
  crossChainMessages: CrossChainMessageWithEvent[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER
): Promise<CrossChainMessageWithStatus[]> {
  // For each token bridge event, store a unique log index for the event within the arbitrum transaction hash.
  // This is important for bridge transactions containing multiple events.
  const uniqueTokenhashes = {};
  const logIndexesForMessage = [];
  for (const event of crossChainMessages.map((m) => m.event)) {
    uniqueTokenhashes[event.transactionHash] = uniqueTokenhashes[event.transactionHash] ?? 0;
    const logIndex = uniqueTokenhashes[event.transactionHash];
    logIndexesForMessage.push(logIndex);
    uniqueTokenhashes[event.transactionHash] += 1;
  }

  const statuses = await Promise.all(
    crossChainMessages.map((message, i) => {
      return (crossChainMessenger as optimismSDK.CrossChainMessenger).getMessageStatus(
        message.message as optimismSDK.MessageLike,
        logIndexesForMessage[i]
      );
    })
  );
  return statuses.map((status, i) => {
    return {
      status: optimismSDK.MessageStatus[status],
      message: crossChainMessages[i].message,
      event: crossChainMessages[i].event,
      logIndex: logIndexesForMessage[i],
    };
  });
}

async function getOptimismFinalizableMessages(
  chainId: OVM_CHAIN_ID,
  logger: winston.Logger,
  tokensBridged: TokensBridged[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER
): Promise<CrossChainMessageWithStatus[]> {
  const crossChainMessages = await getCrossChainMessages(chainId, tokensBridged, crossChainMessenger);
  const messageStatuses = await getMessageStatuses(chainId, crossChainMessages, crossChainMessenger);
  logger.debug({
    at: `${getNetworkName(chainId)}Finalizer`,
    message: "Ethers OpStack SDK Message statuses",
    statusesGrouped: groupObjectCountsByProp(messageStatuses, (message: CrossChainMessageWithStatus) => message.status),
  });
  return messageStatuses.filter(
    (message) =>
      message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_FOR_RELAY] ||
      message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.RELAYED] ||
      message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_TO_PROVE]
  );
}

async function finalizeOptimismMessage(
  _chainId: OVM_CHAIN_ID,
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER,
  message: CrossChainMessageWithStatus,
  logIndex = 0
): Promise<Multicall2Call> {
  if (!chainIsBlast(_chainId)) {
    const callData = await (crossChainMessenger as optimismSDK.CrossChainMessenger).populateTransaction.finalizeMessage(
      message.message as optimismSDK.MessageLike,
      undefined,
      logIndex
    );
    return {
      callData: callData.data,
      target: callData.to,
    };
  }

  // Blast OptimismPortal has a custom interface so we can't use the SDK to construct the calldata.
  // Instead, we need to locate the L1 Proof log that was emitted when we proved the L2 transaction
  // to finalize, inside of which contains a `requestId` we need to use to find the `hintId` parameter
  // we need to submit when finalizing the withdrawal. Note that the `hintId` can be hard-coded to 0
  // for non-ETH withdrawals.
  const { blastOptimismPortal, blastEthYieldManager } = CONTRACT_ADDRESSES[CHAIN_IDs.MAINNET];
  const blastPortal = new Contract(
    blastOptimismPortal.address,
    blastOptimismPortal.abi,
    crossChainMessenger.l1Provider
  );

  const resolvedMessage = await crossChainMessenger.toCrossChainMessage(
    message.message as optimismSDK.MessageLike,
    logIndex
  );
  const withdrawalStruct = await crossChainMessenger.toLowLevelMessage(resolvedMessage, logIndex);
  const l2WithdrawalParams = [
    withdrawalStruct.messageNonce,
    withdrawalStruct.sender,
    withdrawalStruct.target,
    withdrawalStruct.value,
    withdrawalStruct.minGasLimit,
    withdrawalStruct.message,
  ];

  let hintId = 0;
  if (withdrawalStruct.value.gt(0)) {
    const withdrawalHash = utils.keccak256(
      utils.defaultAbiCoder.encode(["uint256", "address", "address", "uint256", "uint256", "bytes"], l2WithdrawalParams)
    );
    const blastEthYield = new Contract(
      blastEthYieldManager.address,
      blastEthYieldManager.abi,
      crossChainMessenger.l1Provider
    );

    // @dev The withdrawal hash should be unique for the L2 withdrawal so there should be exactly 1 event for this query.
    // If the withdrawal hasn't been proven yet then this will error.
    const [proofReceipt, latestCheckpointId] = await Promise.all([
      blastPortal.queryFilter(blastPortal.filters.WithdrawalProven(withdrawalHash)),
      blastEthYield.getLastCheckpointId(),
    ]);
    if (proofReceipt.length !== 1) {
      throw new Error(`Failed to find Proof receipt matching Blast withdrawal ${message.event.transactionHash}`);
    }
    const requestId = proofReceipt[0].args?.requestId;
    if (requestId === undefined || requestId === 0) {
      throw new Error(`Found invalid requestId ${requestId} for Blast withdrawal ${message.event.transactionHash}`);
    }
    // @dev The hintId parameter plays a role in our insurance mechanism that kicks in in the rare event that
    // ETH yield goes negative. The `findCheckpointHint` function runs a binary search in solidity to find the
    // correct hint so we naively set the starting point to 1, the first index, and set the latest to the last
    // queried value. The request ID for an already proven withdrawal should always be found by the following function.
    hintId = await blastEthYield.findCheckpointHint(
      requestId,
      BLAST_YIELD_MANAGER_STARTING_REQUEST_ID,
      latestCheckpointId
    );
  }
  const callData = await blastPortal.populateTransaction.finalizeWithdrawalTransaction(hintId, l2WithdrawalParams);
  return {
    callData: callData.data,
    target: callData.to,
  };
}

async function proveOptimismMessage(
  _chainId: OVM_CHAIN_ID,
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER,
  message: CrossChainMessageWithStatus,
  logIndex = 0
): Promise<Multicall2Call> {
  const callData = await (crossChainMessenger as optimismSDK.CrossChainMessenger).populateTransaction.proveMessage(
    message.message as optimismSDK.MessageLike,
    undefined,
    logIndex
  );
  return {
    callData: callData.data,
    target: callData.to,
  };
}

async function multicallOptimismFinalizations(
  chainId: OVM_CHAIN_ID,
  tokensBridgedEvents: TokensBridged[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<{ callData: Multicall2Call[]; withdrawals: CrossChainMessage[] }> {
  const allMessages = await getOptimismFinalizableMessages(chainId, logger, tokensBridgedEvents, crossChainMessenger);
  const finalizableMessages = allMessages.filter(
    (message) => message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_FOR_RELAY]
  );
  const callData = await Promise.all(
    finalizableMessages.map((message) =>
      finalizeOptimismMessage(chainId, crossChainMessenger, message, message.logIndex)
    )
  );
  const withdrawals = finalizableMessages.map((message) => {
    const l1TokenInfo = getL1TokenInfo(message.event.l2TokenAddress, chainId);
    const amountFromWei = convertFromWei(message.event.amountToReturn.toString(), l1TokenInfo.decimals);
    const withdrawal: CrossChainMessage = {
      originationChainId: chainId,
      l1TokenSymbol: l1TokenInfo.symbol,
      amount: amountFromWei,
      type: "withdrawal",
      destinationChainId: hubPoolClient.chainId,
    };
    return withdrawal;
  });

  // Blast USDB withdrawals have a two step withdrawal process involving a separate claim that can be made
  // after the withdrawal request is finalized by a Blast admin. This roughly takes ~24 hours after the OpMessager
  // has been "Finalized" on L1.
  if (!chainIsBlast(chainId)) {
    return {
      callData,
      withdrawals,
    };
  }

  // For each RELAYED (e.g. Finalized in the normal OPStack context) USDB message there should be
  // one WithdrawRequest with a unique requestId.
  const claimableMessages = allMessages.filter(
    (message) =>
      message.event.l2TokenAddress === TOKEN_SYMBOLS_MAP.USDB.addresses[chainId] &&
      message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.RELAYED]
  );
  if (claimableMessages.length === 0) {
    return {
      callData,
      withdrawals,
    };
  }

  const { blastUsdYieldManager, blastDaiRetriever } = CONTRACT_ADDRESSES[hubPoolClient.chainId];
  const usdYieldManager = new Contract(
    blastUsdYieldManager.address,
    blastUsdYieldManager.abi,
    crossChainMessenger.l1Provider
  );
  // Reduce the query by only querying events that were emitted after the earliest TokenBridged event we saw. This
  // is an easy optimization as we know that WithdrawalRequested events are only emitted after the TokenBridged event.
  const fromBlock = tokensBridgedEvents[0].blockNumber;
  const [_withdrawalRequests, lastCheckpointId, lastFinalizedRequestId] = await Promise.all([
    usdYieldManager.queryFilter(
      usdYieldManager.filters.WithdrawalRequested(
        null,
        null,
        // All withdrawal requests we are interested in finalizing either have the HubPool or the
        // Blast_Retriever address as the recipient. HubPool as recipient is actually a leftover artifact from a
        // deprecated SpokePool code and all recipients going
        // forward should be the Blast_Retriever address. We include it here so that this finalizer can catch any
        // leftover finalizations with HubPool as the recipient that we can manually retrieve.
        // @dev We should replace this filter with a single blastDaiRetriever address once the finalizer lookback
        // stops querying TokensBridged/L2 Withdrawal events that have the HubPool as the recipient.
        [hubPoolClient.hubPool.address, blastDaiRetriever.address]
      ),
      fromBlock
    ),
    usdYieldManager.getLastCheckpointId(),
    // We fetch the lastFinalizedRequestId to filter out any withdrawal requests to give more
    // logging information as to why a withdrawal request is not ready to be claimed.
    usdYieldManager.getLastFinalizedRequestId(),
  ]);

  // The claimableMessages (i.e. the TokensBridged events) should fall out of the lookback window sooner than
  // the WithdrawalRequested events will, but we want a 1:1 mapping between them. Therefore, if we have N
  // WithdrawalRequested events, we should keep the last N claimableMessages.
  const withdrawalRequests = [..._withdrawalRequests].slice(-claimableMessages.length);
  const withdrawalRequestIds = withdrawalRequests.map((request) => request.args.requestId);
  assert(withdrawalRequestIds.length === claimableMessages.length);

  // @dev If a hint for requestId is zero, then the claim is not ready yet (i.e. the Blast admin has not moved to
  // finalize the withdrawal yet) so we should not try to claim it from the Blast Yield Manager.
  // @dev Alternatively, another way to throw out requestIds that aren't ready yet is to query the
  // `getLastFinalizedRequestId` and ignore any requestIds > this value.
  const [hintIds, withdrawalClaims] = await Promise.all([
    Promise.all(
      withdrawalRequestIds.map((requestId) =>
        usdYieldManager.findCheckpointHint(requestId, BLAST_YIELD_MANAGER_STARTING_REQUEST_ID, lastCheckpointId)
      )
    ),
    Promise.all(
      withdrawalRequestIds.map((requestId) =>
        usdYieldManager.queryFilter(usdYieldManager.filters.WithdrawalClaimed(requestId), fromBlock)
      )
    ),
  ]);
  const withdrawalRequestIsClaimed = withdrawalClaims.map((_id, i) => withdrawalClaims[i].length > 0);
  assert(withdrawalRequestIds.length === hintIds.length);
  assert(withdrawalClaims.length === claimableMessages.length);

  logger.debug({
    at: "BlastFinalizer",
    message: "Blast USDB claimable message statuses",
    claims: claimableMessages.map((message, i) => {
      return {
        withdrawalHash: message.event.transactionHash,
        withdrawRequestId: withdrawalRequestIds[i],
        usdYieldManagerHintId: hintIds[i],
        isClaimed: withdrawalRequestIsClaimed[i],
      };
    }),
  });

  const tokenRetriever = new Contract(blastDaiRetriever.address, blastDaiRetriever.abi, crossChainMessenger.l1Provider);
  const claimMessages: CrossChainMessage[] = [];
  const claimCallData = (
    await Promise.all(
      claimableMessages.map(async (message, i) => {
        if (withdrawalRequestIsClaimed[i]) {
          logger.debug({
            at: "BlastFinalizer",
            message: `Withdrawal request ${withdrawalRequestIds[i]} for message ${message.event.transactionHash} already claimed`,
          });
          return undefined;
        }
        const hintId = hintIds[i];
        if (hintId.eq(BLAST_CLAIM_NOT_READY)) {
          logger.debug({
            at: "BlastFinalizer",
            message: `Blast claim not ready for message ${message.event.transactionHash} with request Id ${withdrawalRequestIds[i]}`,
            lastFinalizedRequestId,
          });
          return undefined;
        }
        const recipient = withdrawalRequests[i].args.recipient;
        if (recipient !== tokenRetriever.address) {
          // This should never happen since we filter our WithdrawalRequested query on the `recipient`
          // but in case it happens, this log should help us debug.
          logger.warn({
            at: "BlastFinalizer",
            message: `Withdrawal request ${withdrawalRequestIds[i]} for message ${message.event.transactionHash} has set its recipient to ${recipient} and can't be finalized by the Blast_DaiRetriever`,
            hintId: hintIds[i],
            recipient,
          });
          return undefined;
        }
        const amountFromWei = convertFromWei(message.event.amountToReturn.toString(), TOKEN_SYMBOLS_MAP.USDB.decimals);
        claimMessages.push({
          originationChainId: chainId,
          l1TokenSymbol: TOKEN_SYMBOLS_MAP.USDB.symbol,
          amount: amountFromWei,
          type: "misc",
          miscReason: "claimUSDB",
          destinationChainId: hubPoolClient.chainId,
        });
        const claimCallData = await tokenRetriever.populateTransaction.retrieve(withdrawalRequestIds[i], hintIds[i]);
        return {
          callData: claimCallData.data,
          target: claimCallData.to,
        };
      })
    )
  ).filter((call) => call !== undefined);

  return {
    callData: [...callData, ...claimCallData],
    withdrawals: [...withdrawals, ...claimMessages],
  };
}

async function multicallOptimismL1Proofs(
  chainId: OVM_CHAIN_ID,
  tokensBridgedEvents: TokensBridged[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<{ callData: Multicall2Call[]; withdrawals: CrossChainMessage[] }> {
  const provableMessages = (
    await getOptimismFinalizableMessages(chainId, logger, tokensBridgedEvents, crossChainMessenger)
  ).filter((message) => message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_TO_PROVE]);
  const callData = await Promise.all(
    provableMessages.map((message) => proveOptimismMessage(chainId, crossChainMessenger, message, message.logIndex))
  );
  const withdrawals = provableMessages.map((message) => {
    const l1TokenInfo = getL1TokenInfo(message.event.l2TokenAddress, chainId);
    const amountFromWei = convertFromWei(message.event.amountToReturn.toString(), l1TokenInfo.decimals);
    const proof: CrossChainMessage = {
      originationChainId: chainId,
      l1TokenSymbol: l1TokenInfo.symbol,
      amount: amountFromWei,
      type: "misc",
      miscReason: "proof",
      destinationChainId: hubPoolClient.chainId,
    };
    return proof;
  });

  return {
    callData,
    withdrawals,
  };
}
