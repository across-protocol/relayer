import assert from "assert";
import { countBy } from "lodash";
import * as viem from "viem";
import * as viemChains from "viem/chains";
import {
  getWithdrawals,
  buildProveWithdrawal,
  getWithdrawalStatus,
  getL2Output,
  getTimeToFinalize,
} from "viem/op-stack";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { Log, TokensBridged } from "../../interfaces";
import {
  CHAIN_IDs,
  chainIsOPStack,
  convertFromWei,
  EventSearchConfig,
  getBlockForTimestamp,
  getCurrentTime,
  getNetworkName,
  getViemChain,
  isDefined,
  Provider,
  Signer,
  TOKEN_SYMBOLS_MAP,
  winston,
  chainIsProd,
  Contract,
  ethers,
  Multicall2Call,
  mapAsync,
  paginatedEventQuery,
  createViemCustomTransportFromEthersProvider,
  getTokenInfo,
  getCctpDomainForChainId,
  isEVMSpokePoolClient,
  EvmAddress,
  ZERO_ADDRESS,
} from "../../utils";
import { getRedisCache } from "../../cache/Redis";
import { CONTRACT_ADDRESSES, OPSTACK_CONTRACT_OVERRIDES, getContractEntry } from "../../common";
import OPStackPortalL1 from "../../common/abi/OpStackPortalL1.json";
import { FinalizerPromise, CrossChainMessage, AddressesToFinalize } from "../types";

const { USDC, WETH } = TOKEN_SYMBOLS_MAP;
const USDCe = TOKEN_SYMBOLS_MAP["USDC.e"];
// Mirror CHAIN_IDs.MAINNET / CHAIN_IDs.SEPOLIA as literal types — viem's OP-stack helpers key
// L1 contracts by literal hub chain id, and the `number`-typed CHAIN_IDs entries widen and break narrowing.
const MAINNET = 1 satisfies typeof CHAIN_IDs.MAINNET;
const SEPOLIA = 11155111 satisfies typeof CHAIN_IDs.SEPOLIA;

// @dev The call to `getWithdrawalStatus` may incorrectly label a withdrawal which is not ready to prove as ready to prove.
// If we attempt to call `getL2Output` on this withdrawal, this root will be outputted. We can compare the output root with
// this constant and skip the proof submission if they match.
const PENDING_PROOF_OUTPUT_ROOT = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

// OP-stack target chains used with viem OP-stack actions must declare portal, disputeGameFactory,
// and l2OutputOracle contracts. At runtime, the specific contracts accessed depend on the portal
// version, so not all chains need every contract. The type satisfies the most demanding function
// signature (getTimeToFinalize), while the assertion validates the universally required portal
// contract. This interface is necessary because viem's internal TargetChain type is not exported,
// and viem's function signatures are stricter than their runtime behaviour (e.g. getTimeToFinalize
// requires l2OutputOracle in the type even though it only reads it for portal v<3).
type OpStackTargetChain<TId extends number> = viem.Chain & {
  contracts: {
    portal: Record<TId, viem.ChainContract>;
    disputeGameFactory: Record<TId, viem.ChainContract>;
    l2OutputOracle: Record<TId, viem.ChainContract>;
  };
};

function assertOpStackTargetChain<TId extends number>(
  chain: viem.Chain,
  hubChainId: TId
): asserts chain is OpStackTargetChain<TId> {
  const portal = chain.contracts?.portal;
  // viem types `portal` as `ChainContract | { [sourceId: number]: ChainContract }`. OP-stack chains
  // use the nested form, so narrow off the direct-`address` shape before indexing by hubChainId.
  assert(
    isDefined(portal) && typeof portal === "object" && !("address" in portal),
    `Chain ${chain.id} missing OP-stack 'portal' contract record`
  );
  assert(isDefined(portal[hubChainId]), `Chain ${chain.id} missing 'portal' contract for hub ${hubChainId}`);
}

/**
 * Augment a viem chain definition with disputeGameFactory from OPSTACK_CONTRACT_OVERRIDES
 * when the viem chain doesn't already provide one. No-op for chains that already have
 * disputeGameFactory in their viem definition.
 *
 * This is intended as a short-term fix when on-chain changes (e.g. a portal upgrade to
 * fault proofs) have not yet been propagated to viem's chain definitions. The preferred
 * approach is to upstream the changes to viem, or at least to update the existing viem
 * patches in this repository. In the interim, adding a DisputeGameFactory override in
 * OPSTACK_CONTRACT_OVERRIDES is acceptable.
 */
function withContractOverrides(chainId: number, chain: viem.Chain): viem.Chain {
  const overrides = OPSTACK_CONTRACT_OVERRIDES[chainId]?.l1;
  if (!overrides?.DisputeGameFactory || chain.contracts?.disputeGameFactory) {
    return chain;
  }
  const sourceId = chainIsProd(chainId) ? CHAIN_IDs.MAINNET : CHAIN_IDs.SEPOLIA;
  return {
    ...chain,
    contracts: {
      ...chain.contracts,
      disputeGameFactory: {
        [sourceId]: { address: overrides.DisputeGameFactory as viem.Address },
      },
    },
  };
}

// Minimal dispute-game read surface for computing the dispute-game finality airgap.
const DISPUTE_GAME_RESOLVED_AT_ABI = ["function resolvedAt() view returns (uint64)"];

// For a proven-but-not-yet-finalizable Portal-2 withdrawal, return the L1 timestamp at which the
// dispute-game finality airgap elapses (when finalization becomes possible), or undefined if the
// backing game has not resolved yet (the airgap clock has not started).
async function getDisputeGameFinalizableAt(
  portal: Contract,
  withdrawalHash: string,
  signer: Signer
): Promise<number | undefined> {
  const numProofSubmitters: ethers.BigNumber = await portal.numProofSubmitters(withdrawalHash);
  const proofSubmitter: string = await portal.proofSubmitters(withdrawalHash, numProofSubmitters.sub(1));
  const { disputeGameProxy }: { disputeGameProxy: string } = await portal.provenWithdrawals(
    withdrawalHash,
    proofSubmitter
  );
  const game = new Contract(disputeGameProxy, DISPUTE_GAME_RESOLVED_AT_ABI, signer);
  const [resolvedAt, finalityDelay]: [ethers.BigNumber, ethers.BigNumber] = await Promise.all([
    game.resolvedAt(),
    portal.disputeGameFinalityDelaySeconds(),
  ]);
  return resolvedAt.isZero() ? undefined : resolvedAt.toNumber() + finalityDelay.toNumber();
}

export async function opStackFinalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  _l1SpokePoolClient: SpokePoolClient,
  senderAddresses: AddressesToFinalize
): Promise<FinalizerPromise> {
  assert(isEVMSpokePoolClient(spokePoolClient));
  const { chainId, latestHeightSearched: to, spokePool } = spokePoolClient;
  assert(chainIsOPStack(chainId), `Unsupported OP Stack chain ID: ${chainId}`);
  const chain = getNetworkName(chainId);
  const at = `${chain}Finalizer`;

  // Optimism withdrawals take 7 days to finalize, while proofs are ready as soon as an L1 txn containing the L2
  // withdrawal is posted to Mainnet, so ~30 mins.
  // Sort tokensBridged events by their age. Submit proofs for recent events, and withdrawals for older events.
  // - Don't submit proofs for finalizations older than 1 day
  // - Don't try to withdraw tokens that are not past the 7 day challenge period
  const redis = await getRedisCache(logger);
  const minimumFinalizationTime = getCurrentTime() - 7 * 3600 * 24;
  const latestBlockToProve = await getBlockForTimestamp(logger, chainId, minimumFinalizationTime, undefined, redis);

  // OP Stack chains may have tokens that do not go through the standard ERC20 withdrawal process, so the
  // easiest way to query for these events is to use the TokensBridged event emitted by the Across SpokePool
  // on every withdrawal.
  // @dev EOA-initiated withdrawals of such tokens are NOT discovered here, because getOVMStdEvents() only
  // queries the OVM standard bridge; those need finalizing by hand.
  const usdc = EvmAddress.from(USDC.addresses[chainId] ?? ZERO_ADDRESS);
  const { recentTokensBridgedEvents = [], olderTokensBridgedEvents = [] } = Object.groupBy(
    spokePoolClient.getTokensBridged().filter(
      ({ l2TokenAddress }) =>
        // CCTP USDC withdrawals should be finalized via the CCTP Finalizer.
        !l2TokenAddress.eq(usdc) || !(getCctpDomainForChainId(chainId) > 0)
    ),
    (e) => (e.blockNumber >= latestBlockToProve ? "recentTokensBridgedEvents" : "olderTokensBridgedEvents")
  );

  // First submit proofs for any newly withdrawn tokens. You can submit proofs for any withdrawals that have been
  // snapshotted on L1, so it takes roughly 1 hour from the withdrawal time
  logger.debug({ at, message: `Latest TokensBridged block for proof submission on ${chain}.`, latestBlockToProve });

  // Add in all manual withdrawals from other EOA's from OPStack chain to the finalizer. This will help us
  // automate token withdrawals from Lite chains, which can build up ETH and ERC20 balances over time
  // and because they are lite chains, our only way to withdraw them is to initiate a manual bridge from the
  // the lite chain to Ethereum via the canonical OVM standard bridge.
  // Filter out SpokePool as sender since we query for it previously using the TokensBridged event query.
  const ovmFromAddresses = Array.from(senderAddresses.keys())
    .filter((address) => address.isEVM())
    .map((sender) => sender.toEvmAddress())
    .filter((sender) => sender !== spokePool.address);
  const searchConfig = { ...spokePoolClient.eventSearchConfig, to };
  const withdrawalEvents = await Promise.all([
    getOVMStdEvents(logger, spokePool.provider, ovmFromAddresses, searchConfig),
    getOPUSDCEvents(logger, spokePool.provider, ovmFromAddresses, searchConfig),
  ]);

  // If there are any found withdrawal initiated events, then add them to the list of TokenBridged events we'll
  // submit proofs and finalizations for.
  withdrawalEvents.flat().forEach(({ transactionHash, transactionIndex, ...event }) => {
    const tokenBridgedEvent: TokensBridged = {
      ...event,
      amountToReturn: event.args.amount,
      chainId,
      leafId: 0,
      l2TokenAddress: EvmAddress.from(event.l2TokenAddress),
      txnRef: transactionHash,
      txnIndex: transactionIndex,
    };
    if (event.blockNumber >= latestBlockToProve) {
      recentTokensBridgedEvents.push(tokenBridgedEvent);
    } else {
      olderTokensBridgedEvents.push(tokenBridgedEvent);
    }
  });

  const { callData, withdrawals: crossChainTransfers } = await viem_multicallOptimismFinalizations(
    chainId,
    logger,
    signer,
    hubPoolClient,
    olderTokensBridgedEvents,
    recentTokensBridgedEvents
  );

  return { callData, crossChainMessages: crossChainTransfers };
}

async function getOVMStdEvents(
  logger: winston.Logger,
  provider: Provider,
  fromAddresses: string[],
  searchConfig: EventSearchConfig
): Promise<(Log & { l2TokenAddress: string })[]> {
  const { chainId } = await provider.getNetwork();
  const chain = getNetworkName(chainId);
  const at = `${chain}Finalizer`;

  // Add in all manual withdrawals from other EOA's from OPStack chain to the finalizer. This will help us
  // automate token withdrawals from Lite chains, which can build up ETH and ERC20 balances over time
  // and because they are lite chains, our only way to withdraw them is to initiate a manual bridge from the
  // the lite chain to Ethereum via the canonical OVM standard bridge.
  const ovmStandardBridge = getContractEntry(chainId, "ovmStandardBridge");
  const bridge = new Contract(ovmStandardBridge.address, ovmStandardBridge.abi, provider);

  const ethFilter = bridge.filters.ETHBridgeInitiated(fromAddresses);
  const ethEvents = (await paginatedEventQuery(bridge, ethFilter, searchConfig)).map((event) => ({
    ...event,
    l2TokenAddress: WETH.addresses[chainId],
  }));

  const erc20filter = bridge.filters.ERC20BridgeInitiated(null, null, fromAddresses);
  const erc20Events = (await paginatedEventQuery(bridge, erc20filter, searchConfig))
    .map((event) => {
      // If we're aware of this token, then save the event as one we can finalize.
      try {
        getTokenInfo(EvmAddress.from(event.args.localToken), chainId);
        return { ...event, l2TokenAddress: event.args.localToken };
      } catch {
        logger.debug({ at, message: `Skipping unknown ${chain} token withdrawal: ${event.args.localToken}`, event });
        return undefined;
      }
    })
    .filter(isDefined);

  return [...ethEvents, ...erc20Events];
}

async function getOPUSDCEvents(
  logger: winston.Logger,
  provider: Provider,
  fromAddresses: string[],
  searchConfig: EventSearchConfig
): Promise<(Log & { l2TokenAddress: string })[]> {
  const { chainId } = await provider.getNetwork();
  const chain = getNetworkName(chainId);
  const at = `${chain}Finalizer`;

  if (!CONTRACT_ADDRESSES[chainId]?.opUSDCBridge) {
    return []; // No need to warn; many chains do not have OP USDC.
  }
  const { address, abi } = getContractEntry(chainId, "opUSDCBridge");
  const bridge = new Contract(address, abi, provider);
  const filter = bridge.filters.MessageSent(fromAddresses);
  const events = (await paginatedEventQuery(bridge, filter, searchConfig))
    .map(({ args, ...event }) => {
      const l2TokenAddress = USDC.addresses?.[chainId] ?? USDCe.addresses?.[chainId];
      if (!l2TokenAddress) {
        logger.warn({ at, message: `Unrecognised USDC variant on ${chain}.`, event });
      }

      // MessageSent events aren't immediately compatible with this adapter. Finesse the event format a bit.
      return { ...event, args: { ...args, amount: args._amount }, l2TokenAddress };
    })
    .filter(({ l2TokenAddress }) => isDefined(l2TokenAddress));

  return events;
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
  // Literal-typed so viem op-stack helpers (which key contracts by 1 or 11155111) can narrow correctly.
  const hubChainId: typeof MAINNET | typeof SEPOLIA = chainIsProd(chainId) ? MAINNET : SEPOLIA;
  const l1Chain = chainIsProd(chainId) ? viemChains.mainnet : viemChains.sepolia;
  const publicClientL1 = viem.createPublicClient({
    batch: {
      multicall: true,
    },
    chain: l1Chain,
    transport: createViemCustomTransportFromEthersProvider(hubChainId),
  });
  const targetChain = withContractOverrides(chainId, getViemChain(chainId));
  // Validate the target chain has the required OP-stack contracts.
  assertOpStackTargetChain(targetChain, hubChainId);

  const publicClientL2 = viem.createPublicClient({
    batch: {
      multicall: true,
    },
    chain: targetChain,
    transport: createViemCustomTransportFromEthersProvider(chainId),
  });
  const uniqueTokenhashes: { [hash: string]: number } = {};
  const logIndexesForMessage: number[] = [];
  const events = [...olderTokensBridgedEvents, ...recentTokensBridgedEvents];
  for (const event of events) {
    uniqueTokenhashes[event.txnRef] ??= 0;
    const logIndex = uniqueTokenhashes[event.txnRef];
    logIndexesForMessage.push(logIndex);
    uniqueTokenhashes[event.txnRef] += 1;
  }

  const crossChainMessenger = new Contract(targetChain.contracts.portal[hubChainId].address, OPStackPortalL1, signer);
  const chain: undefined = undefined; // Needed for viem OP type resolution.
  const withdrawalStatuses: string[] = [];

  // Portal version gates the dispute-game finality airgap read (Portal-2, major >= 3).
  const portalMajorVersion = Number((await crossChainMessenger.version()).split(".")[0]);

  // Pass as targetChain to viem OP-stack functions. Viem looks up L2 contracts
  // using l1Chain.id (sourceId) and uses custom decoders from targetChain.custom
  // for MegaETH.
  await mapAsync(events, async (event, i) => {
    // Useful information for event:
    const { decimals, symbol } = getTokenInfo(event.l2TokenAddress, chainId);
    const amountFromWei = convertFromWei(event.amountToReturn.toString(), decimals);

    const receipt = await publicClientL2.getTransactionReceipt({
      hash: event.txnRef as `0x${string}`,
    });
    const withdrawal = getWithdrawals(receipt)[logIndexesForMessage[i]];
    const withdrawalStatus = await getWithdrawalStatus(publicClientL1, {
      chain,
      receipt,
      targetChain,
      logIndex: logIndexesForMessage[i],
    });
    withdrawalStatuses.push(withdrawalStatus);
    if (withdrawalStatus === "ready-to-prove") {
      const l2Output = await getL2Output(publicClientL1, {
        chain,
        l2BlockNumber: BigInt(event.blockNumber),
        targetChain,
      });
      if (l2Output.outputRoot !== PENDING_PROOF_OUTPUT_ROOT) {
        const { l2OutputIndex, outputRootProof, withdrawalProof } = await buildProveWithdrawal(publicClientL2, {
          chain,
          withdrawal,
          output: l2Output,
        });
        const proofArgs = [withdrawal, l2OutputIndex, outputRootProof, withdrawalProof];
        const callData = await crossChainMessenger.populateTransaction.proveWithdrawalTransaction(...proofArgs);
        assert(isDefined(callData.data), "opStack: proveWithdrawalTransaction populateTransaction missing data");
        viemTxns.callData.push({
          callData: callData.data,
          target: crossChainMessenger.address,
        });
        viemTxns.withdrawals.push({
          originationChainId: chainId,
          l1TokenSymbol: symbol,
          amount: amountFromWei,
          type: "misc",
          miscReason: "proof",
          destinationChainId: hubPoolClient.chainId,
        });
      }
    } else if (withdrawalStatus === "waiting-to-finalize") {
      // Proof-maturity clock — the only clock viem's getTimeToFinalize measures.
      const { seconds: proofMaturitySeconds } = await getTimeToFinalize(publicClientL1, {
        chain,
        withdrawalHash: withdrawal.withdrawalHash,
        targetChain,
      });
      const prefix = `Withdrawal ${event.txnRef} for ${amountFromWei} of ${symbol}`;
      // Portal-2 (fault-proof) chains gate finalization on a second clock getTimeToFinalize ignores:
      // the dispute-game finality airgap, which only starts once the backing game resolves. Without
      // it, a matured proof logs "0.00 hours" while the withdrawal is still airgapped. Report the
      // real finalization ETA for Portal-2; keep the proof-maturity countdown for legacy portals.
      if (portalMajorVersion < 3) {
        logger.debug({
          at: `${getNetworkName(chainId)}Finalizer`,
          message: `${prefix} is in challenge period for ${(proofMaturitySeconds / 3600).toFixed(2)} hours`,
        });
      } else {
        const finalizableAt = await getDisputeGameFinalizableAt(crossChainMessenger, withdrawal.withdrawalHash, signer);
        if (!isDefined(finalizableAt)) {
          logger.debug({
            at: `${getNetworkName(chainId)}Finalizer`,
            message: `${prefix} is waiting on dispute-game resolution (airgap not yet started)`,
          });
        } else {
          // Finalizable at the later of the two clocks — proof maturity or the airgap; derive both
          // the hours and the timestamp from it so they can't disagree.
          const now = getCurrentTime();
          const finalizableAtTs = Math.max(finalizableAt, now + proofMaturitySeconds);
          const secondsRemaining = Math.max(finalizableAtTs - now, 0);
          const finalizableInHours = Number((secondsRemaining / 3600).toFixed(2));
          const finalizableAtIso = new Date(finalizableAtTs * 1000).toISOString();
          logger.debug({
            at: `${getNetworkName(chainId)}Finalizer`,
            message: `${prefix} is in dispute-game airgap; finalizable in ${finalizableInHours} hours (at ${finalizableAtIso})`,
            finalizableInHours,
            finalizableAt: finalizableAtIso,
          });
        }
      }
    } else if (withdrawalStatus === "ready-to-finalize") {
      // @dev Some OpStack chains use OptimismPortal instead of the newer OptimismPortal2, the latter of which
      // requires that the msg.sender of the  finalizeWithdrawalTransaction is equal to the address that
      // submitted the proof.
      // See this comment in OptimismPortal2 for more context on why the new portal requires checking the
      // proof submitter address: https://github.com/ethereum-optimism/optimism/blob/d6bda0339005d98c992c749c137938d515755029/packages/contracts-bedrock/src/L1/OptimismPortal2.sol#L132
      let callData: ethers.PopulatedTransaction;
      // Portal-2 (major >= 3) requires the proof submitter be passed explicitly, since proofs may be
      // submitted by an address other than the finalizer (e.g. Multicall3 on MegaETH). The legacy
      // OptimismPortal path keys the proof off msg.sender. Boundary matches viem (major < 3 = legacy).
      if (portalMajorVersion >= 3) {
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
      assert(isDefined(callData.data), "opStack: finalizeWithdrawalTransaction populateTransaction missing data");
      viemTxns.callData.push({
        callData: callData.data,
        target: crossChainMessenger.address,
      });
      viemTxns.withdrawals.push({
        originationChainId: chainId,
        l1TokenSymbol: symbol,
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
