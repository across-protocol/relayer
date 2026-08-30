import { utils as sdkUtils } from "@across-protocol/sdk";
import { utils as ethersUtils } from "ethers";
import { HubPoolClient } from "../clients";
import { PendingRootBundle, PoolRebalanceLeaf, RelayerRefundLeaf, SlowFillLeaf } from "../interfaces";
import {
  BigNumber,
  MerkleTree,
  convertFromWei,
  formatFeePct,
  shortenHexString,
  shortenHexStrings,
  toBN,
  winston,
  assert,
  getNetworkName,
  EvmAddress,
  Address,
  isDefined,
} from "../utils";

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
    `\n\tProposer: ${shortenHexString(pendingRootBundle.proposer.toEvmAddress())}`
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
    const [startBlock, endBlock] = bundleBlockRange[index];
    const paused = startBlock === endBlock ? " 🥶" : "";
    bundleBlockRangePretty += `\n\t\t${chainId}: ${JSON.stringify(bundleBlockRange[index])}${paused}`;
  });

  const convertTokenListFromWei = (chainId: number, tokenAddresses: Address[], weiVals: string[]) => {
    return tokenAddresses.map((token, index) => {
      try {
        const { decimals } = hubPoolClient.getTokenInfoForAddress(token, chainId);
        return convertFromWei(weiVals[index], decimals);
      } catch (error) {
        hubPoolClient.logger.debug({
          at: "PoolRebalanceUtils#generateMarkdownForRootBundle#convertTokenListFromWei",
          message: `Error getting token info for address ${token} on chain ${chainId}`,
          error,
        });
        return weiVals[index].toString();
      }
    });
  };
  const convertTokenAddressToSymbol = (chainId: number, tokenAddress: Address) => {
    try {
      return hubPoolClient.getTokenInfoForAddress(tokenAddress, chainId).symbol;
    } catch (error) {
      hubPoolClient.logger.debug({
        at: "PoolRebalanceUtils#generateMarkdownForRootBundle#convertTokenAddressToSymbol",
        message: `Error getting token info for address ${tokenAddress} on chain ${chainId}`,
        error,
      });
      return "UNKNOWN TOKEN";
    }
  };
  const convertL1TokenAddressesToSymbols = (l1Tokens: EvmAddress[]) => {
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
    try {
      leaf.amountToReturn = convertFromWei(
        leaf.amountToReturn,
        hubPoolClient.getTokenInfoForAddress(leaf.l2TokenAddress, leaf.chainId).decimals
      );
    } catch (error) {
      hubPoolClient.logger.debug({
        at: "PoolRebalanceUtils#generateMarkdownForRootBundle",
        message: `Error getting token info for address ${leaf.l2TokenAddress} on chain ${leaf.chainId}`,
        error,
      });
      leaf.amountToReturn = leaf.amountToReturn.toString();
    }
    leaf.refundAmounts = convertTokenListFromWei(
      leaf.chainId,
      Array(leaf.refundAmounts.length).fill(leaf.l2TokenAddress),
      leaf.refundAmounts
    );
    leaf.l2Token = convertTokenAddressToSymbol(leaf.chainId, leaf.l2TokenAddress);
    delete leaf.l2TokenAddress;
    leaf.refundAddresses = shortenHexStrings(
      leaf.refundAddresses.map((refundAddress: Address) => refundAddress.toBytes32())
    );
    relayerRefundLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf)}`;
  });

  let slowRelayLeavesPretty = "";
  slowRelayLeaves.forEach((leaf, index) => {
    const { outputToken } = leaf.relayData;
    const destinationChainId = leaf.chainId;
    // @devgetTokenInfoForAddress should always succeed for slow leaves as we should always be aware of these tokens in
    // TOKEN_SYMBOLS_MAP.
    const outputTokenDecimals = hubPoolClient.getTokenInfoForAddress(outputToken, destinationChainId).decimals;
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
      depositor: shortenHexString(leaf.relayData.depositor.toBytes32()),
      recipient: shortenHexString(leaf.relayData.recipient.toBytes32()),
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

// Format a wei-scaled balance as a fixed-point decimal string with sensible precision:
//   - exactly zero               → "" (suppress) or "0" depending on suppressZero
//   - |x| >= 1                   → 2 decimal places, thousands-separated (e.g. "-4,166.85")
//   - 0 < |x| < 1                → 4 significant figures, no scientific notation (e.g. "0.0000000123")
// formatUnits gives us a non-scientific decimal string from any BigNumber input, so all formatting
// reduces to string slicing — no float math, no precision loss.
function formatBalanceAmount(weiVal: BigNumber | string, decimals: number, suppressZero: boolean): string {
  const raw = ethersUtils.formatUnits(BigNumber.from(weiVal.toString()), decimals);
  const isZero = /^-?0(?:\.0*)?$/.test(raw);
  if (isZero) {
    return suppressZero ? "" : "0";
  }
  const negative = raw.startsWith("-");
  const [intPart, fracPart = ""] = raw.replace(/^-/, "").split(".");
  const sign = negative ? "-" : "";
  if (intPart !== "0") {
    const truncatedFrac = (fracPart + "00").slice(0, 2);
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${sign}${grouped}.${truncatedFrac}`;
  }
  const firstNonZero = fracPart.search(/[1-9]/);
  if (firstNonZero === -1) {
    return suppressZero ? "" : "0";
  }
  const sigFigs = fracPart.slice(firstNonZero, firstNonZero + 4);
  const leadingZeros = fracPart.slice(0, firstNonZero);
  return `${sign}0.${leadingZeros}${sigFigs}`;
}

// Lay out `rows` as a fixed-width text table. Numeric columns (align: "decimal") are right-aligned on
// the decimal point so columns of mixed-magnitude values still line up visually; text columns are
// left-aligned. Blank cells are padded with spaces so column shape is preserved.
type ColumnAlign = "left" | "right" | "decimal";
function renderTable(headers: string[], aligns: ColumnAlign[], rows: string[][]): string {
  const cols = headers.length;
  const widths: { left: number; right: number; total: number }[] = [];
  for (let c = 0; c < cols; c++) {
    if (aligns[c] === "decimal") {
      let maxLeft = 0;
      let maxRight = 0;
      for (const row of rows) {
        const cell = row[c] ?? "";
        if (cell === "") {
          continue;
        }
        const idx = cell.indexOf(".");
        if (idx === -1) {
          maxLeft = Math.max(maxLeft, cell.length);
        } else {
          maxLeft = Math.max(maxLeft, idx);
          maxRight = Math.max(maxRight, cell.length - idx);
        }
      }
      const headerWidth = headers[c].length;
      const total = Math.max(maxLeft + maxRight, headerWidth);
      widths.push({ left: maxLeft, right: maxRight, total });
    } else {
      const total = Math.max(headers[c].length, ...rows.map((row) => (row[c] ?? "").length));
      widths.push({ left: 0, right: 0, total });
    }
  }

  const renderCell = (cell: string, c: number): string => {
    const w = widths[c];
    if (aligns[c] === "decimal") {
      if (cell === "") {
        return " ".repeat(w.total);
      }
      const idx = cell.indexOf(".");
      const leftPart = idx === -1 ? cell : cell.slice(0, idx);
      const rightPart = idx === -1 ? "" : cell.slice(idx);
      // Pad to (left, right) to align on the decimal point, then right-pad with spaces so the
      // column fits the header width when the header is wider than any data row.
      return (leftPart.padStart(w.left) + rightPart.padEnd(w.right)).padEnd(w.total);
    }
    if (aligns[c] === "right") {
      return (cell ?? "").padStart(w.total);
    }
    return (cell ?? "").padEnd(w.total);
  };

  const lines = [headers.map((h, c) => renderCell(h, c)).join("  ")];
  for (const row of rows) {
    lines.push(row.map((cell, c) => renderCell(cell, c)).join("  "));
  }
  return lines.join("\n");
}

// Compact Slack summary for a root bundle proposal. Replaces the per-leaf JSON dump with two tables
// (bundle blocks, pool rebalance) plus the relayer-refund and slow-relay roots. Paused chains
// (startBlock === endBlock) collapse into a single line carrying the paused block number. Pool
// rebalance leaves with no token activity (netSendAmounts, runningBalances, bundleLpFees all zero
// for every l1Token) are listed by chainId on a "quiet leaves" line. Full leaf JSON is intended to
// be emitted separately as a debug log alongside this summary.
export function generateSlackSummaryForRootBundle(
  hubPoolClient: HubPoolClient,
  chainIdListForBundleEvaluationBlockNumbers: number[],
  hubPoolChainId: number,
  bundleBlockRange: number[][],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  poolRebalanceLeaves: any[],
  poolRebalanceRoot: string,
  relayerRefundRoot: string,
  slowRelayLeaves: SlowFillLeaf[],
  slowRelayRoot: string
): string {
  // ----- Bundle blocks table -----
  const activeBlockRows: string[][] = [];
  const pausedEntries: string[] = [];
  bundleBlockRange.forEach((range, index) => {
    const chainId = chainIdListForBundleEvaluationBlockNumbers[index];
    const [startBlock, endBlock] = range;
    const name = getNetworkName(chainId);
    if (startBlock === endBlock) {
      pausedEntries.push(`${chainId} ${name} @${startBlock.toLocaleString("en-US")}`);
    } else {
      activeBlockRows.push([
        chainId.toString(),
        name,
        startBlock.toLocaleString("en-US"),
        endBlock.toLocaleString("en-US"),
      ]);
    }
  });
  const bundleBlocksTable = renderTable(
    ["chainId", "chain", "start", "end"],
    ["right", "left", "right", "right"],
    activeBlockRows
  );
  const pausedLine = pausedEntries.length > 0 ? `\n🥶 paused: ${pausedEntries.join(" · ")}` : "";

  // ----- Pool rebalance table -----
  const tokenDecimals = (chainId: number, token: Address): number | undefined => {
    try {
      return hubPoolClient.getTokenInfoForAddress(token, chainId).decimals;
    } catch {
      return undefined;
    }
  };
  const tokenSymbol = (chainId: number, token: Address): string => {
    try {
      return hubPoolClient.getTokenInfoForAddress(token, chainId).symbol;
    } catch {
      return "UNKNOWN";
    }
  };
  const formatLeafAmount = (chainId: number, token: Address, weiVal: BigNumber | string): string => {
    const decimals = tokenDecimals(chainId, token);
    if (decimals === undefined) {
      return weiVal.toString();
    }
    return formatBalanceAmount(weiVal, decimals, /* suppressZero */ true);
  };

  const poolRebalanceRows: string[][] = [];
  const quietLeafEntries: string[] = [];
  poolRebalanceLeaves.forEach((leaf) => {
    const chainId: number = leaf.chainId;
    const l1Tokens: EvmAddress[] = leaf.l1Tokens ?? [];
    const netSendAmounts: (BigNumber | string)[] = leaf.netSendAmounts ?? [];
    const runningBalances: (BigNumber | string)[] = leaf.runningBalances ?? [];
    const bundleLpFees: (BigNumber | string)[] = leaf.bundleLpFees ?? [];
    const chainName = getNetworkName(chainId);

    const tokenRows: string[][] = [];
    l1Tokens.forEach((token, i) => {
      const netStr = formatLeafAmount(hubPoolChainId, token, netSendAmounts[i] ?? "0");
      const runStr = formatLeafAmount(hubPoolChainId, token, runningBalances[i] ?? "0");
      const lpStr = formatLeafAmount(hubPoolChainId, token, bundleLpFees[i] ?? "0");
      if (netStr === "" && runStr === "" && lpStr === "") {
        return;
      }
      tokenRows.push([tokenSymbol(hubPoolChainId, token), netStr, runStr, lpStr]);
    });

    if (tokenRows.length === 0) {
      quietLeafEntries.push(`${chainId} ${chainName}`);
      return;
    }

    tokenRows.forEach((row, i) => {
      poolRebalanceRows.push([i === 0 ? chainId.toString() : "", i === 0 ? chainName : "", ...row]);
    });
  });

  const poolRebalanceTable =
    poolRebalanceRows.length > 0
      ? renderTable(
          ["chainId", "chain", "token", "netSendAmounts", "runningBalances", "bundleLpFees"],
          ["right", "left", "left", "decimal", "decimal", "decimal"],
          poolRebalanceRows
        )
      : "(no pool rebalance activity)";
  const quietLine = quietLeafEntries.length > 0 ? `\nquiet leaves (all zero): ${quietLeafEntries.join(" · ")}` : "";

  // ----- Slow relay summary (kept compact; full leaves still go to debug) -----
  const slowRelayLine =
    slowRelayLeaves.length > 0
      ? `*SlowRelay* root: \`${shortenHexString(slowRelayRoot)}\` (${slowRelayLeaves.length} leaves — see debug log)`
      : "*SlowRelay*: No slow relay leaves";

  return [
    "*Bundle blocks*",
    "```",
    bundleBlocksTable,
    "```" + pausedLine,
    "",
    `*PoolRebalance* root: \`${shortenHexString(poolRebalanceRoot)}\``,
    "```",
    poolRebalanceTable,
    "```" + quietLine,
    "",
    `*RelayerRefund* root: \`${shortenHexString(relayerRefundRoot)}\` (see debug log for per-leaf detail)`,
    slowRelayLine,
  ].join("\n");
}

export function prettyPrintLeaves<T extends PoolRebalanceLeaf | RelayerRefundLeaf | SlowFillLeaf>(
  logger: winston.Logger,
  tree: MerkleTree<T>,
  leaves: T[],
  logType = "Pool rebalance"
): void {
  leaves.forEach((leaf, index) => {
    const prettyLeaf = Object.entries(leaf).reduce<Record<string, unknown>>((result, [key, value]) => {
      // Check if leaf value is list of BN's or single BN.
      if (Array.isArray(value) && BigNumber.isBigNumber(value[0])) {
        result[key] = value.map((val) => val.toString());
      } else if (BigNumber.isBigNumber(value)) {
        result[key] = value.toString();
      } else if (typeof value === "number") {
        result[key] = value;
      } else if (Array.isArray(value) && isDefined(value[0]) && Address.isAddress(value[0])) {
        result[key] = value.map((val) => val.toNative());
      } else if (Address.isAddress(value)) {
        result[key] = value.toNative();
      } else {
        result[key] = value;
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
