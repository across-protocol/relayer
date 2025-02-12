import { utils as sdkUtils } from "@across-protocol/sdk";
import { HubPoolClient } from "../clients";
import { PendingRootBundle, PoolRebalanceLeaf, RelayerRefundLeaf, SlowFillLeaf } from "../interfaces";
import {
  bnZero,
  BigNumber,
  fixedPointAdjustment as fixedPoint,
  MerkleTree,
  convertFromWei,
  formatFeePct,
  shortenHexString,
  shortenHexStrings,
  toBN,
  toBNWei,
  winston,
  assert,
  getNetworkName,
  isChainDisabled,
} from "../utils";
import { DataworkerClients } from "./DataworkerClientHelper";

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
  slowRelayLeaves: SlowFillLeaf[],
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
        ` ${getNetworkName(leaf.relayData.originChainId)} depositId ${leaf.relayData.depositId.toString()}`
    );

    // @todo: When v2 types are removed, update the slowFill definition to be more precise about the member fields.
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
  tree: MerkleTree<PoolRebalanceLeaf> | MerkleTree<RelayerRefundLeaf> | MerkleTree<SlowFillLeaf>,
  leaves: PoolRebalanceLeaf[] | RelayerRefundLeaf[] | SlowFillLeaf[],
  logType = "Pool rebalance"
): void {
  leaves.forEach((leaf, index) => {
    const prettyLeaf = Object.keys(leaf).reduce((result, key) => {
      // Check if leaf value is list of BN's or single BN.
      if (Array.isArray(leaf[key]) && BigNumber.isBigNumber(leaf[key][0])) {
        result[key] = leaf[key].map((val) => val.toString());
      } else if (BigNumber.isBigNumber(leaf[key])) {
        result[key] = leaf[key].toString();
      } else {
        result[key] = leaf[key];
      }
      return result;
    }, {});
    logger.debug({
      at: "Dataworker#propose",
      message: `${logType} leaf #${index}`,
      leaf: prettyLeaf,
      proof: tree.getHexProof(leaf),
    });
  });
}
