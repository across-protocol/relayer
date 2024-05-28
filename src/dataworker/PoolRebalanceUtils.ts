import { utils as sdkUtils, interfaces as sdkInterfaces } from "@across-protocol/sdk-v2";
import { ConfigStoreClient, HubPoolClient, SpokePoolClient } from "../clients";
import { Clients } from "../common";
import * as interfaces from "../interfaces";
import {
  PendingRootBundle,
  PoolRebalanceLeaf,
  RelayerRefundLeaf,
  SpokePoolTargetBalance,
  V3SlowFillLeaf,
} from "../interfaces";
import {
  bnZero,
  BigNumber,
  fixedPointAdjustment as fixedPoint,
  MerkleTree,
  compareAddresses,
  convertFromWei,
  formatFeePct,
  shortenHexString,
  shortenHexStrings,
  toBN,
  toBNWei,
  winston,
  assert,
  getNetworkName,
} from "../utils";
import { DataworkerClients } from "./DataworkerClientHelper";

export function updateRunningBalance(
  runningBalances: interfaces.RunningBalances,
  l2ChainId: number,
  l1Token: string,
  updateAmount: BigNumber
): void {
  // Initialize dictionary if empty.
  if (!runningBalances[l2ChainId]) {
    runningBalances[l2ChainId] = {};
  }
  const runningBalance = runningBalances[l2ChainId][l1Token];
  if (runningBalance) {
    runningBalances[l2ChainId][l1Token] = runningBalance.add(updateAmount);
  } else {
    runningBalances[l2ChainId][l1Token] = updateAmount;
  }
}

export function addLastRunningBalance(
  latestMainnetBlock: number,
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient
): void {
  Object.keys(runningBalances).forEach((repaymentChainId) => {
    Object.keys(runningBalances[Number(repaymentChainId)]).forEach((l1TokenAddress) => {
      const { runningBalance } = hubPoolClient.getRunningBalanceBeforeBlockForChain(
        latestMainnetBlock,
        Number(repaymentChainId),
        l1TokenAddress
      );
      if (!runningBalance.eq(bnZero)) {
        updateRunningBalance(runningBalances, Number(repaymentChainId), l1TokenAddress, runningBalance);
      }
    });
  });
}

export function updateRunningBalanceForDeposit(
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  deposit: interfaces.V3DepositWithBlock,
  updateAmount: BigNumber
): void {
  const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
    deposit.inputToken,
    deposit.originChainId,
    deposit.quoteBlockNumber
  );
  updateRunningBalance(runningBalances, deposit.originChainId, l1TokenCounterpart, updateAmount);
}

// TODO: Is summing up absolute values really the best way to compute a root bundle's "volume"? Said another way,
// how do we measure a root bundle's "impact" or importance?
export async function computePoolRebalanceUsdVolume(
  leaves: PoolRebalanceLeaf[],
  clients: DataworkerClients
): Promise<BigNumber> {
  // Fetch the set of unique token addresses from the array of PoolRebalanceLeave objects.
  // Map the resulting HubPool token addresses to symbol, decimals, and price.
  const hubPoolTokens = Object.fromEntries(
    Array.from(new Set(leaves.map(({ l1Tokens }) => l1Tokens).flat()))
      .map((address) => clients.hubPoolClient.getTokenInfoForL1Token(address))
      .map(({ symbol, decimals, address }) => [address, { symbol, decimals, price: bnZero }])
  );

  // Fetch all relevant token prices.
  const prices = await clients.priceClient.getPricesByAddress(
    Object.keys(hubPoolTokens).map((address) => address),
    "usd"
  );

  // Scale token price to 18 decimals.
  prices.forEach(({ address, price }) => (hubPoolTokens[address].price = toBNWei(price)));

  const bn10 = toBN(10);
  return leaves.reduce((result: BigNumber, poolRebalanceLeaf) => {
    return poolRebalanceLeaf.l1Tokens.reduce((sum: BigNumber, l1Token: string, index: number) => {
      const { decimals, price: usdTokenPrice } = hubPoolTokens[l1Token];

      const netSendAmount = poolRebalanceLeaf.netSendAmounts[index];
      const volume = netSendAmount.abs().mul(bn10.pow(18 - decimals)); // Scale volume to 18 decimals.

      const usdVolume = volume.mul(usdTokenPrice).div(fixedPoint);
      return sum.add(usdVolume);
    }, result);
  }, bnZero);
}

export function constructPoolRebalanceLeaves(
  latestMainnetBlock: number,
  runningBalances: interfaces.RunningBalances,
  realizedLpFees: interfaces.RunningBalances,
  configStoreClient: ConfigStoreClient,
  maxL1TokenCount?: number
): interfaces.PoolRebalanceLeaf[] {
  // Create one leaf per L2 chain ID. First we'll create a leaf with all L1 tokens for each chain ID, and then
  // we'll split up any leaves with too many L1 tokens.
  const leaves: interfaces.PoolRebalanceLeaf[] = [];
  Object.keys(runningBalances)
    .map((chainId) => Number(chainId))
    // Leaves should be sorted by ascending chain ID
    .sort((chainIdA, chainIdB) => chainIdA - chainIdB)
    .map((chainId) => {
      // Sort addresses.
      const sortedL1Tokens = Object.keys(runningBalances[chainId]).sort((addressA, addressB) => {
        return compareAddresses(addressA, addressB);
      });

      // This begins at 0 and increments for each leaf for this { chainId, L1Token } combination.
      let groupIndexForChainId = 0;

      // Split addresses into multiple leaves if there are more L1 tokens than allowed per leaf.
      const maxL1TokensPerLeaf =
        maxL1TokenCount || configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(latestMainnetBlock);
      for (let i = 0; i < sortedL1Tokens.length; i += maxL1TokensPerLeaf) {
        const l1TokensToIncludeInThisLeaf = sortedL1Tokens.slice(i, i + maxL1TokensPerLeaf);

        const spokeTargetBalances = l1TokensToIncludeInThisLeaf.map((l1Token) =>
          configStoreClient.getSpokeTargetBalancesForBlock(l1Token, chainId, latestMainnetBlock)
        );

        // Build leaves using running balances and realized lp fees data for l1Token + chain, or default to
        // zero if undefined.
        const leafBundleLpFees = l1TokensToIncludeInThisLeaf.map(
          (l1Token) => realizedLpFees[chainId]?.[l1Token] ?? bnZero
        );
        const leafNetSendAmounts = l1TokensToIncludeInThisLeaf.map((l1Token, index) =>
          runningBalances[chainId] && runningBalances[chainId][l1Token]
            ? getNetSendAmountForL1Token(spokeTargetBalances[index], runningBalances[chainId][l1Token])
            : bnZero
        );
        const leafRunningBalances = l1TokensToIncludeInThisLeaf.map((l1Token, index) =>
          runningBalances[chainId]?.[l1Token]
            ? getRunningBalanceForL1Token(spokeTargetBalances[index], runningBalances[chainId][l1Token])
            : bnZero
        );

        leaves.push({
          chainId: chainId,
          bundleLpFees: leafBundleLpFees,
          netSendAmounts: leafNetSendAmounts,
          runningBalances: leafRunningBalances,
          groupIndex: groupIndexForChainId++,
          leafId: leaves.length,
          l1Tokens: l1TokensToIncludeInThisLeaf,
        });
      }
    });
  return leaves;
}

// Note: this function computes the intended transfer amount before considering the transfer threshold.
// A positive number indicates a transfer from hub to spoke.
export function computeDesiredTransferAmountToSpoke(
  runningBalance: BigNumber,
  spokePoolTargetBalance: SpokePoolTargetBalance
): BigNumber {
  // Transfer is always desired if hub owes spoke.
  if (runningBalance.gte(0)) {
    return runningBalance;
  }

  // Running balance is negative, but its absolute value is less than the spoke pool target balance threshold.
  // In this case, we transfer nothing.
  if (runningBalance.abs().lt(spokePoolTargetBalance.threshold)) {
    return bnZero;
  }

  // We are left with the case where the spoke pool is beyond the threshold.
  // A transfer needs to be initiated to bring it down to the target.
  const transferSize = runningBalance.abs().sub(spokePoolTargetBalance.target);

  // If the transferSize is < 0, this indicates that the target is still above the running balance.
  // This can only happen if the threshold is less than the target. This is likely due to a misconfiguration.
  // In this case, we transfer nothing until the target is exceeded.
  if (transferSize.lt(0)) {
    return bnZero;
  }

  // Negate the transfer size because a transfer from spoke to hub is indicated by a negative number.
  return transferSize.mul(-1);
}

// If the running balance is greater than the token transfer threshold, then set the net send amount
// equal to the running balance and reset the running balance to 0. Otherwise, the net send amount should be
// 0, indicating that we do not want the data worker to trigger a token transfer between hub pool and spoke
// pool when executing this leaf.
export function getNetSendAmountForL1Token(
  spokePoolTargetBalance: SpokePoolTargetBalance,
  runningBalance: BigNumber
): BigNumber {
  return computeDesiredTransferAmountToSpoke(runningBalance, spokePoolTargetBalance);
}

export function getRunningBalanceForL1Token(
  spokePoolTargetBalance: SpokePoolTargetBalance,
  runningBalance: BigNumber
): BigNumber {
  const desiredTransferAmount = computeDesiredTransferAmountToSpoke(runningBalance, spokePoolTargetBalance);
  return runningBalance.sub(desiredTransferAmount);
}

// This returns a possible next block range that could be submitted as a new root bundle, or used as a reference
// when evaluating  pending root bundle. The block end numbers must be less than the latest blocks for each chain ID
// (because we can't evaluate events in the future), and greater than the expected start blocks, which are the
// greater of 0 and the latest bundle end block for an executed root bundle proposal + 1.
export function getWidestPossibleExpectedBlockRange(
  chainIdListForBundleEvaluationBlockNumbers: number[],
  spokeClients: { [chainId: number]: SpokePoolClient },
  endBlockBuffers: number[],
  clients: Clients,
  latestMainnetBlock: number,
  enabledChains: number[]
): number[][] {
  // We impose a buffer on the head of the chain to increase the probability that the received blocks are final.
  // Reducing the latest block that we query also gives partially filled deposits slightly more buffer for relayers
  // to fully fill the deposit and reduces the chance that the data worker includes a slow fill payment that gets
  // filled during the challenge period.
  const latestPossibleBundleEndBlockNumbers = chainIdListForBundleEvaluationBlockNumbers.map(
    (chainId: number, index) =>
      spokeClients[chainId] && Math.max(spokeClients[chainId].latestBlockSearched - endBlockBuffers[index], 0)
  );
  return chainIdListForBundleEvaluationBlockNumbers.map((chainId: number, index) => {
    const lastEndBlockForChain = clients.hubPoolClient.getLatestBundleEndBlockForChain(
      chainIdListForBundleEvaluationBlockNumbers,
      latestMainnetBlock,
      chainId
    );

    // If chain is disabled, re-use the latest bundle end block for the chain as both the start
    // and end block.
    if (!enabledChains.includes(chainId)) {
      return [lastEndBlockForChain, lastEndBlockForChain];
    } else {
      // If the latest block hasn't advanced enough from the previous proposed end block, then re-use it. It will
      // be regarded as disabled by the Dataworker clients. Otherwise, add 1 to the previous proposed end block.
      if (lastEndBlockForChain >= latestPossibleBundleEndBlockNumbers[index]) {
        // @dev: Without this check, then `getNextBundleStartBlockNumber` could return `latestBlock+1` even when the
        // latest block for the chain hasn't advanced, resulting in an invalid range being produced.
        return [lastEndBlockForChain, lastEndBlockForChain];
      } else {
        // Chain has advanced far enough including the buffer, return range from previous proposed end block + 1 to
        // latest block for chain minus buffer.
        return [
          clients.hubPoolClient.getNextBundleStartBlockNumber(
            chainIdListForBundleEvaluationBlockNumbers,
            latestMainnetBlock,
            chainId
          ),
          latestPossibleBundleEndBlockNumbers[index],
        ];
      }
    }
  });
}

export function generateMarkdownForDisputeInvalidBundleBlocks(
  chainIdListForBundleEvaluationBlockNumbers: number[],
  pendingRootBundle: PendingRootBundle,
  widestExpectedBlockRange: number[][],
  buffers: number[]
): string {
  const getBlockRangePretty = (blockRange: number[][] | number[]) => {
    let bundleBlockRangePretty = "";
    chainIdListForBundleEvaluationBlockNumbers.forEach((chainId, index) => {
      bundleBlockRangePretty += `\n\t\t${chainId}: ${JSON.stringify(blockRange[index])}`;
    });
    return bundleBlockRangePretty;
  };
  return (
    "Disputed pending root bundle because of invalid bundle blocks:" +
    `\n\t*Widest possible expected block range*:${getBlockRangePretty(widestExpectedBlockRange)}` +
    `\n\t*Buffers to end blocks*:${getBlockRangePretty(buffers)}` +
    `\n\t*Pending end blocks*:${getBlockRangePretty(pendingRootBundle.bundleEvaluationBlockNumbers)}`
  );
}

export function generateMarkdownForDispute(pendingRootBundle: PendingRootBundle): string {
  return (
    "Disputed pending root bundle:" +
    `\n\tPoolRebalance leaf count: ${pendingRootBundle.unclaimedPoolRebalanceLeafCount}` +
    `\n\tPoolRebalance root: ${shortenHexString(pendingRootBundle.poolRebalanceRoot)}` +
    `\n\tRelayerRefund root: ${shortenHexString(pendingRootBundle.relayerRefundRoot)}` +
    `\n\tSlowRelay root: ${shortenHexString(pendingRootBundle.slowRelayRoot)}` +
    `\n\tProposer: ${shortenHexString(pendingRootBundle.proposer)}`
  );
}

export function isChainDisabled(blockRangeForChain: number[]): boolean {
  return blockRangeForChain[0] === blockRangeForChain[1];
}

export function generateMarkdownForRootBundle(
  hubPoolClient: HubPoolClient,
  chainIdListForBundleEvaluationBlockNumbers: number[],
  hubPoolChainId: number,
  bundleBlockRange: number[][],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  poolRebalanceLeaves: any[],
  poolRebalanceRoot: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  relayerRefundLeaves: any[],
  relayerRefundRoot: string,
  slowRelayLeaves: V3SlowFillLeaf[],
  slowRelayRoot: string
): string {
  // Create helpful logs to send to slack transport
  let bundleBlockRangePretty = "";
  bundleBlockRange.forEach((_blockRange, index) => {
    const chainId = chainIdListForBundleEvaluationBlockNumbers[index];
    bundleBlockRangePretty += `\n\t\t${chainId}: ${JSON.stringify(bundleBlockRange[index])}${
      isChainDisabled(bundleBlockRange[index]) ? " 🥶" : ""
    }`;
  });

  const convertTokenListFromWei = (chainId: number, tokenAddresses: string[], weiVals: string[]) => {
    return tokenAddresses.map((token, index) => {
      const { decimals } = hubPoolClient.getTokenInfo(chainId, token);
      return convertFromWei(weiVals[index], decimals);
    });
  };
  const convertTokenAddressToSymbol = (chainId: number, tokenAddress: string) => {
    return hubPoolClient.getTokenInfo(chainId, tokenAddress).symbol;
  };
  const convertL1TokenAddressesToSymbols = (l1Tokens: string[]) => {
    return l1Tokens.map((l1Token) => {
      return convertTokenAddressToSymbol(hubPoolChainId, l1Token);
    });
  };
  let poolRebalanceLeavesPretty = "";
  poolRebalanceLeaves.forEach((leaf, index) => {
    // Shorten keys for ease of reading from Slack.
    delete leaf.leafId;
    leaf.groupId = leaf.groupIndex;
    delete leaf.groupIndex;
    leaf.bundleLpFees = convertTokenListFromWei(hubPoolChainId, leaf.l1Tokens, leaf.bundleLpFees);
    leaf.runningBalances = convertTokenListFromWei(hubPoolChainId, leaf.l1Tokens, leaf.runningBalances);
    leaf.netSendAmounts = convertTokenListFromWei(hubPoolChainId, leaf.l1Tokens, leaf.netSendAmounts);
    leaf.l1Tokens = convertL1TokenAddressesToSymbols(leaf.l1Tokens);
    poolRebalanceLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf)}`;
  });

  let relayerRefundLeavesPretty = "";
  relayerRefundLeaves.forEach((leaf, index) => {
    // Shorten keys for ease of reading from Slack.
    delete leaf.leafId;
    leaf.amountToReturn = convertFromWei(
      leaf.amountToReturn,
      hubPoolClient.getTokenInfo(leaf.chainId, leaf.l2TokenAddress).decimals
    );
    leaf.refundAmounts = convertTokenListFromWei(
      leaf.chainId,
      Array(leaf.refundAmounts.length).fill(leaf.l2TokenAddress),
      leaf.refundAmounts
    );
    leaf.l2Token = convertTokenAddressToSymbol(leaf.chainId, leaf.l2TokenAddress);
    delete leaf.l2TokenAddress;
    leaf.refundAddresses = shortenHexStrings(leaf.refundAddresses);
    relayerRefundLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf)}`;
  });

  let slowRelayLeavesPretty = "";
  slowRelayLeaves.forEach((leaf, index) => {
    const { outputToken } = leaf.relayData;
    const destinationChainId = leaf.chainId;
    const outputTokenDecimals = hubPoolClient.getTokenInfo(destinationChainId, outputToken).decimals;
    const lpFeePct = sdkUtils.getSlowFillLeafLpFeePct(leaf);

    // Scale amounts to 18 decimals for realizedLpFeePct computation.
    const scaleBy = toBN(10).pow(18 - outputTokenDecimals);
    const inputAmount = leaf.relayData.inputAmount.mul(scaleBy);
    const updatedOutputAmount = leaf.updatedOutputAmount.mul(scaleBy);
    assert(
      inputAmount.gte(updatedOutputAmount),
      "Unexpected output amount for slow fill on" +
        ` ${getNetworkName(leaf.relayData.originChainId)} depositId ${leaf.relayData.depositId}`
    );

    // @todo: When v2 types are removed, update the slowFill definition to be more precise about the memebr fields.
    const slowFill = {
      // Shorten select keys for ease of reading from Slack.
      depositor: shortenHexString(leaf.relayData.depositor),
      recipient: shortenHexString(leaf.relayData.recipient),
      originChainId: leaf.relayData.originChainId.toString(),
      destinationChainId: destinationChainId.toString(),
      depositId: leaf.relayData.depositId.toString(),
      message: leaf.relayData.message,
      // Fee decimals is always 18. 1e18 = 100% so 1e16 = 1%.
      realizedLpFeePct: `${formatFeePct(lpFeePct)}%`,
      outputToken,
      outputAmount: convertFromWei(updatedOutputAmount.toString(), 18), // tokens were scaled to 18 decimals.
    };

    slowRelayLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(slowFill)}`;
  });

  const slowRelayMsg = slowRelayLeavesPretty
    ? `root:${shortenHexString(slowRelayRoot)}...\n\t\tleaves:${slowRelayLeavesPretty}`
    : "No slow relay leaves";
  return (
    "\n" +
    `\t*Bundle blocks*:${bundleBlockRangePretty}\n` +
    "\t*PoolRebalance*:\n" +
    `\t\troot:${shortenHexString(poolRebalanceRoot)}...\n` +
    `\t\tleaves:${poolRebalanceLeavesPretty}\n` +
    "\t*RelayerRefund*\n" +
    `\t\troot:${shortenHexString(relayerRefundRoot)}...\n` +
    `\t\tleaves:${relayerRefundLeavesPretty}\n` +
    "\t*SlowRelay*\n" +
    `\t${slowRelayMsg}`
  );
}

export function prettyPrintLeaves(
  logger: winston.Logger,
  tree: MerkleTree<PoolRebalanceLeaf> | MerkleTree<RelayerRefundLeaf> | MerkleTree<V3SlowFillLeaf>,
  leaves: PoolRebalanceLeaf[] | RelayerRefundLeaf[] | V3SlowFillLeaf[],
  logType = "Pool rebalance"
): void {
  leaves.forEach((leaf, index) => {
    const prettyLeaf = Object.keys(leaf).reduce((result, key) => {
      const entry = (leaf as unknown as Record<string, unknown>)[key];
      // Check if leaf value is list of BN's or single BN.
      if (Array.isArray(entry) && BigNumber.isBigNumber(entry[0])) {
        result[key] = entry.map((val) => val.toString());
      } else if (BigNumber.isBigNumber(entry)) {
        result[key] = entry.toString();
      } else {
        result[key] = entry;
      }
      return result;
    }, {} as Record<string, unknown>);
    logger.debug({
      at: "Dataworker#propose",
      message: `${logType} leaf #${index}`,
      leaf: prettyLeaf,
      proof: tree.getHexProof(
        leaf as unknown as sdkInterfaces.SlowFillLeaf &
          sdkInterfaces.RelayerRefundLeaf &
          sdkInterfaces.PoolRebalanceLeaf
      ),
    });
  });
}
