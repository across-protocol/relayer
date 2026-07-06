import minimist from "minimist";
import { config } from "dotenv";
import { Contract, ethers, Signer } from "ethers";
import { CHAIN_IDs } from "@across-protocol/constants";
import { constants as sdkConsts, utils as sdkUtils } from "@across-protocol/sdk";
import { ExpandedERC20__factory as ERC20 } from "@across-protocol/sdk/typechain";
import { FillStatus, RelayData } from "../src/interfaces";
import { TransactionClient } from "../src/clients";
import {
  BigNumber,
  blockExplorerLink,
  bnZero,
  chainIsEvm,
  ConvertDecimals,
  convertRelayDataParamsToBytes32,
  disconnectRedisClients,
  exit,
  formatUnits,
  getNetworkName,
  getProvider,
  getSigner,
  isDefined,
  Logger as logger,
  toAddressType,
} from "../src/utils";
import * as utils from "./utils";

const { NODE_SUCCESS, NODE_INPUT_ERR, NODE_APP_ERR } = utils;
const { AddressZero } = ethers.constants;
const { formatBytes32String } = ethers.utils;

const DEPOSIT_EVENT = "FundsDeposited";

/**
 * For each requested token, deposit on the HubPool chain to every chain with an active pool rebalance route, then
 * submit a corresponding slow fill request on each destination chain. This guarantees that the next root bundle
 * emits a pool rebalance leaf for every (chain, token) pair, so that updated spokeTargetBalances (i.e. 0) take
 * effect and all SpokePool balances are returned to the HubPool. Intended for winding down LP support for a token;
 * run after the relevant ConfigStore updateTokenConfig() rate model & spoke target update has been executed, and
 * before the corresponding pool rebalance routes are removed.
 *
 * Deposits are made with outputAmount == inputAmount (0 relayer fee), so a fast fill is unprofitable and the
 * deposit should remain unfilled until the slow fill executes via the root bundle.
 */

type SlowFillRoute = {
  token: utils.ERC20; // HubPool chain token.
  destinationChainId: number;
  destinationToken: string;
  destinationDecimals: number;
  inputAmount: BigNumber;
  outputAmount: BigNumber;
};

async function getGlobalConfigArray(configStore: Contract, key: string): Promise<number[]> {
  const raw: string = await configStore.globalConfig(formatBytes32String(key));
  // Some historical values are string-quoted (e.g. '["10","137"]'), so strip quotes before parsing.
  return raw.length > 0 ? JSON.parse(raw.replaceAll('"', "")).map(Number) : [];
}

/**
 * Sanity-check that the token's ConfigStore config has already been updated to wind the token down (zeroed rate
 * model, no spokeTargetBalances). If not, deposits made now would be bundled with the old LP fee and spoke targets,
 * defeating the purpose of the exercise.
 */
async function tokenConfigUpdated(configStore: Contract, l1Token: string): Promise<boolean> {
  let tokenConfig: { rateModel?: Record<string, string>; spokeTargetBalances?: Record<string, unknown> };
  try {
    tokenConfig = JSON.parse(await configStore.l1TokenConfig(l1Token));
  } catch {
    return false;
  }

  const rateModelZeroed = ["R0", "R1", "R2"].every((k) => tokenConfig.rateModel?.[k] === "0");
  const spokeTargetsCleared = Object.keys(tokenConfig.spokeTargetBalances ?? {}).length === 0;
  return rateModelZeroed && spokeTargetsCleared;
}

/**
 * Resolve the set of chains with an active pool rebalance route for l1Token, excluding the hub chain itself and
 * any chain that is disabled or lite (slow fills cannot be requested for lite chain destinations).
 */
async function getActiveRouteChainIds(
  hubPool: Contract,
  configStore: Contract,
  hubChainId: number,
  l1Token: string
): Promise<{ chainId: number; destinationToken: string }[]> {
  const [chainIds, disabledChainIds, liteChainIds] = await Promise.all(
    ["CHAIN_ID_INDICES", "DISABLED_CHAINS", "LITE_CHAIN_ID_INDICES"].map((key) =>
      getGlobalConfigArray(configStore, key)
    )
  );

  const candidates = chainIds.filter(
    (chainId) => chainId !== hubChainId && !disabledChainIds.includes(chainId) && !liteChainIds.includes(chainId)
  );

  const routes = await Promise.all(
    candidates.map(async (chainId) => ({
      chainId,
      destinationToken: await hubPool.poolRebalanceRoute(chainId, l1Token),
    }))
  );

  return routes
    .filter(({ destinationToken }) => destinationToken !== AddressZero)
    .filter(({ chainId }) => {
      if (!chainIsEvm(chainId)) {
        console.log(`Skipping non-EVM chain ${getNetworkName(chainId)} (${chainId}); not supported by this script.`);
        return false;
      }
      return true;
    });
}

async function resolveRoutes(
  hubPool: Contract,
  configStore: Contract,
  hubChainId: number,
  symbol: string,
  amount: string,
  destinationChainIds: number[]
): Promise<SlowFillRoute[]> {
  const token = utils.resolveToken(symbol, hubChainId);
  const inputAmount = ethers.utils.parseUnits(amount, token.decimals);

  let routes = await getActiveRouteChainIds(hubPool, configStore, hubChainId, token.address);
  if (destinationChainIds.length > 0) {
    routes = routes.filter(({ chainId }) => destinationChainIds.includes(chainId));
  }

  return Promise.all(
    routes.map(async ({ chainId, destinationToken }) => {
      const provider = await getProvider(chainId);
      const erc20 = new Contract(destinationToken, ERC20.abi, provider);
      const destinationDecimals = Number(await erc20.decimals());
      return {
        token,
        destinationChainId: chainId,
        destinationToken,
        destinationDecimals,
        inputAmount,
        outputAmount: ConvertDecimals(token.decimals, destinationDecimals)(inputAmount),
      };
    })
  );
}

function printRoute(route: SlowFillRoute, hubChainId: number): void {
  const { token, destinationChainId, destinationToken, inputAmount } = route;
  console.log(
    `\t${token.symbol.padEnd(6)} ${getNetworkName(hubChainId)} -> ${getNetworkName(destinationChainId)}` +
      ` (${destinationChainId})` +
      `\n\t\tinputToken       : ${token.address}` +
      `\n\t\tdestinationToken : ${destinationToken}` +
      `\n\t\tamount           : ${formatUnits(inputAmount, token.decimals)} ${token.symbol}`
  );
}

/**
 * Submit a deposit on the hub chain SpokePool for the route, then submit the corresponding slow fill request on
 * the destination chain SpokePool. Returns true on success (or if a slow fill request already exists).
 */
async function depositAndRequestSlowFill(
  route: SlowFillRoute,
  hubChainId: number,
  signer: Signer,
  recipientOverride?: string
): Promise<boolean> {
  const { token, destinationChainId, destinationToken, inputAmount, outputAmount } = route;
  const [origin, destination] = [getNetworkName(hubChainId), getNetworkName(destinationChainId)];

  const provider = await getProvider(hubChainId);
  const originSigner = signer.connect(provider);
  const depositor = toAddressType(await originSigner.getAddress(), hubChainId);
  const recipient = toAddressType(recipientOverride ?? depositor.toEvmAddress(), destinationChainId);
  if (!recipient.isValidOn(destinationChainId)) {
    console.log(`Invalid recipient address for chain ${destinationChainId}: (${recipient}).`);
    return false;
  }

  const spokePool = (await utils.getSpokePoolContract(hubChainId)).connect(originSigner);
  const txnClient = new TransactionClient(logger, [signer]);

  // Set quoteTimestamp to the current SpokePool time and take the maximum permissible fillDeadline. The slow fill
  // request must land on the destination chain before the fillDeadline expires.
  const [currentTime, fillDeadlineBuffer] = await Promise.all([
    spokePool.getCurrentTime(),
    spokePool.fillDeadlineBuffer(),
  ]);
  const quoteTimestamp = Number(currentTime);
  const fillDeadline = quoteTimestamp + Number(fillDeadlineBuffer);

  const inputToken = toAddressType(token.address, hubChainId);
  const outputToken = toAddressType(destinationToken, destinationChainId);
  const exclusiveRelayer = toAddressType(AddressZero, destinationChainId);

  const [depositResponse] = await txnClient.submit(hubChainId, [
    {
      contract: spokePool,
      chainId: hubChainId,
      method: "deposit",
      args: [
        depositor.toBytes32(),
        recipient.toBytes32(),
        inputToken.toBytes32(),
        outputToken.toBytes32(),
        inputAmount,
        outputAmount,
        destinationChainId,
        exclusiveRelayer.toBytes32(),
        quoteTimestamp,
        fillDeadline,
        0, // exclusivityParameter
        sdkConsts.EMPTY_MESSAGE,
      ],
      message: "SpokePool deposit",
      mrkdwn: `Deposit ${formatUnits(inputAmount, token.decimals)} ${token.symbol} ${origin} -> ${destination}`,
      ensureConfirmation: true,
    },
  ]);
  if (!isDefined(depositResponse)) {
    console.log(`Deposit submission for ${token.symbol} ${origin} -> ${destination} failed.`);
    return false;
  }
  const receipt = await depositResponse.wait();
  console.log(`Deposit confirmed: ${blockExplorerLink(receipt.transactionHash, hubChainId)}.`);

  // Reconstruct the relay data from the emitted FundsDeposited event to guarantee that the slow fill request
  // hashes to the on-chain deposit.
  const fundsDeposited = spokePool.interface.getEventTopic(DEPOSIT_EVENT);
  const depositLog = receipt.logs.find(
    ({ address, topics }) => address === spokePool.address && topics[0] === fundsDeposited
  );
  if (!isDefined(depositLog)) {
    console.log(`No ${DEPOSIT_EVENT} event found in txn ${receipt.transactionHash}.`);
    return false;
  }
  const { args: depositArgs } = spokePool.interface.parseLog(depositLog);

  const relayData: RelayData = {
    originChainId: hubChainId,
    depositor: toAddressType(depositArgs.depositor, hubChainId),
    recipient: toAddressType(depositArgs.recipient, destinationChainId),
    depositId: depositArgs.depositId,
    inputToken: toAddressType(depositArgs.inputToken, hubChainId),
    inputAmount: depositArgs.inputAmount,
    outputToken: toAddressType(depositArgs.outputToken, destinationChainId),
    outputAmount: depositArgs.outputAmount,
    message: depositArgs.message,
    fillDeadline: depositArgs.fillDeadline,
    exclusiveRelayer: toAddressType(depositArgs.exclusiveRelayer, destinationChainId),
    exclusivityDeadline: depositArgs.exclusivityDeadline,
  };
  const relayDataHash = sdkUtils.getRelayDataHash(relayData, destinationChainId);
  console.log(`Deposit ${depositArgs.depositId} (relayDataHash ${relayDataHash}) confirmed on ${origin}.`);

  const destProvider = await getProvider(destinationChainId);
  const destSigner = signer.connect(destProvider);
  const destSpokePool = (await utils.getSpokePoolContract(destinationChainId)).connect(destSigner);

  const fillStatus = Number(await destSpokePool.fillStatuses(relayDataHash));
  if (fillStatus !== FillStatus.Unfilled) {
    const status = FillStatus[fillStatus];
    console.log(`Deposit ${depositArgs.depositId} already has ${destination} fill status ${status}; skipping.`);
    // An existing slow fill request still achieves the objective; an outright fill does not.
    return fillStatus === FillStatus.RequestedSlowFill;
  }

  const [slowFillResponse] = await txnClient.submit(destinationChainId, [
    {
      contract: destSpokePool,
      chainId: destinationChainId,
      method: "requestSlowFill",
      args: [convertRelayDataParamsToBytes32(relayData)],
      message: "Requested slow fill for deposit.",
      mrkdwn: `Requested ${destination} slow fill for ${origin} depositId ${depositArgs.depositId}.`,
      ensureConfirmation: true,
    },
  ]);
  if (!isDefined(slowFillResponse)) {
    console.log(`Slow fill request for depositId ${depositArgs.depositId} on ${destination} failed.`);
    return false;
  }
  const slowFillReceipt = await slowFillResponse.wait();
  console.log(
    `Slow fill request confirmed: ${blockExplorerLink(slowFillReceipt.transactionHash, destinationChainId)}.`
  );

  return true;
}

async function run(args: Record<string, string | boolean>, signer: Signer): Promise<boolean> {
  const hubChainId = CHAIN_IDs.MAINNET;
  const symbols = String(args.tokens)
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => symbol.length > 0);
  const destinationChainIds = String(args.chainIds ?? "")
    .split(",")
    .filter((chainId) => chainId.length > 0)
    .map(Number);
  const amount = String(args.amount);
  const execute = Boolean(args.execute);
  const recipient = isDefined(args.recipient) ? String(args.recipient) : undefined;

  if (destinationChainIds.length > 0 && !utils.validateChainIds(destinationChainIds)) {
    console.log(`Invalid set of chain IDs (${destinationChainIds.join(", ")}).`);
    return false;
  }

  const [hubPool, configStore] = await Promise.all([
    utils.getContract(hubChainId, "HubPool"),
    utils.getContract(hubChainId, "AcrossConfigStore"),
  ]);

  const signerAddr = await signer.getAddress();
  const provider = await getProvider(hubChainId);

  // Resolve all routes up-front and print the plan.
  const routes: SlowFillRoute[] = [];
  for (const symbol of symbols) {
    const tokenRoutes = await resolveRoutes(hubPool, configStore, hubChainId, symbol, amount, destinationChainIds);
    if (tokenRoutes.length === 0) {
      console.log(`No active pool rebalance routes found for ${symbol}; skipping.`);
      continue;
    }

    const { token } = tokenRoutes[0];
    if (!(await tokenConfigUpdated(configStore, token.address))) {
      console.log(
        `WARNING: ${symbol} ConfigStore config still has a non-zero rate model and/or spokeTargetBalances.` +
          " Has the updateTokenConfig() transaction been executed?"
      );
      if (execute && !(await utils.askYesNoQuestion(`Proceed with ${symbol} anyway?`))) {
        continue;
      }
    }
    routes.push(...tokenRoutes);
  }

  if (routes.length === 0) {
    console.log("Nothing to do.");
    return false;
  }

  console.log(`\nPlanned deposits + slow fill requests (signer ${signerAddr}):`);
  routes.forEach((route) => printRoute(route, hubChainId));

  // Report signer balances: per-token requirements on the hub chain, and native gas on each destination.
  const symbolTotals: Record<string, { token: utils.ERC20; total: BigNumber }> = {};
  routes.forEach(({ token, inputAmount }) => {
    symbolTotals[token.symbol] ??= { token, total: bnZero };
    symbolTotals[token.symbol].total = symbolTotals[token.symbol].total.add(inputAmount);
  });

  let fundingOk = true;
  console.log(`\n${getNetworkName(hubChainId)} balances required:`);
  for (const { token, total } of Object.values(symbolTotals)) {
    const balance = await new Contract(token.address, ERC20.abi, provider).balanceOf(signerAddr);
    const sufficient = balance.gte(total);
    fundingOk &&= sufficient;
    console.log(
      `\t${token.symbol.padEnd(6)} ${formatUnits(total, token.decimals)}` +
        ` (balance ${formatUnits(balance, token.decimals)})${sufficient ? "" : " ***INSUFFICIENT***"}`
    );
  }

  console.log("\nDestination gas balances:");
  for (const chainId of [...new Set(routes.map(({ destinationChainId }) => destinationChainId))]) {
    const balance = await (await getProvider(chainId)).getBalance(signerAddr);
    if (balance.eq(bnZero)) {
      fundingOk = false;
    }
    console.log(
      `\t${getNetworkName(chainId).padEnd(10)} ${formatUnits(balance, 18)}${balance.eq(bnZero) ? " ***EMPTY***" : ""}`
    );
  }

  if (!execute) {
    console.log("\nDry run complete. Re-run with --execute to submit transactions.");
    return true;
  }
  if (!fundingOk && !(await utils.askYesNoQuestion("\nSigner appears underfunded. Proceed anyway?"))) {
    return false;
  }

  // Approve the hub chain SpokePool once per token for the aggregate deposit amount.
  const spokePool = await utils.getSpokePoolContract(hubChainId);
  const originSigner = signer.connect(provider);
  for (const { token, total } of Object.values(symbolTotals)) {
    const erc20 = new Contract(token.address, ERC20.abi, originSigner);
    const allowance = await erc20.allowance(signerAddr, spokePool.address);
    if (allowance.lt(total)) {
      console.log(`Approving SpokePool for ${formatUnits(total, token.decimals)} ${token.symbol}...`);
      const approval = await erc20.approve(spokePool.address, total);
      await approval.wait();
      console.log(`Approval complete: ${blockExplorerLink(approval.hash, hubChainId)}.`);
    }
  }

  const results: { route: SlowFillRoute; success: boolean }[] = [];
  for (const route of routes) {
    const { token, destinationChainId } = route;
    const proceed = await utils.askYesNoQuestion(
      `\nDeposit ${formatUnits(route.inputAmount, token.decimals)} ${token.symbol}` +
        ` ${getNetworkName(hubChainId)} -> ${getNetworkName(destinationChainId)} and request slow fill?`
    );
    if (!proceed) {
      continue;
    }

    let success = false;
    try {
      success = await depositAndRequestSlowFill(route, hubChainId, signer, recipient);
    } catch (error) {
      console.log(`Error on ${token.symbol} -> ${getNetworkName(destinationChainId)}: ${error}`);
    }
    results.push({ route, success });
  }

  console.log("\nSummary:");
  results.forEach(({ route, success }) =>
    console.log(
      `\t${route.token.symbol.padEnd(6)} -> ${getNetworkName(route.destinationChainId).padEnd(10)}:` +
        ` ${success ? "OK" : "FAILED"}`
    )
  );

  return results.every(({ success }) => success);
}

function usage(badInput?: string): boolean {
  const usageStr =
    (badInput ? `\nUnrecognized input: "${badInput}".\n\n` : "") +
    `
    For each requested token, deposit on the HubPool chain to every chain with an active pool rebalance route, then
    submit a corresponding slow fill request on the destination chain. Used to force pool rebalance leaves for every
    (chain, token) pair when winding down LP support for a token. Run after the token's ConfigStore config has been
    zeroed out, and before its pool rebalance routes are removed.

    Usage:
    \tyarn tsx ./scripts/depositAndRequestSlowFill --wallet <mnemonic|privateKey|gckms>
    \t\t[--tokens ACX,WGHO,UMA]  Comma-separated token symbols (default: ACX,WGHO,UMA).
    \t\t[--amount 1]             Deposit amount per route, in whole tokens (default: 1).
    \t\t[--chainIds 10,137]      Restrict to these destination chains (default: all active routes).
    \t\t[--recipient <address>]  Slow fill recipient (default: depositor).
    \t\t[--execute]              Submit transactions (default: dry run).
  `.slice(1);
  console.log(usageStr);

  return !isDefined(badInput);
}

async function main(argv: string[]): Promise<number> {
  const opts = {
    string: ["tokens", "amount", "chainIds", "recipient", "wallet"],
    boolean: ["execute"],
    default: {
      tokens: "ACX,WGHO,UMA",
      amount: "1",
      execute: false,
      wallet: "secret",
    },
    unknown: usage,
  };
  const args = minimist(argv, opts);

  config();
  let signer: Signer;
  try {
    signer = await getSigner({ keyType: args.wallet, cleanEnv: true });
  } catch {
    return usage(args.wallet) ? NODE_SUCCESS : NODE_INPUT_ERR;
  }

  const result = await run(args, signer);
  return result ? NODE_SUCCESS : NODE_APP_ERR;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(async (result) => {
      process.exitCode = result;
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      process.exitCode = NODE_APP_ERR;
    })
    .finally(async () => {
      await disconnectRedisClients();
      exit(Number(process.exitCode));
    });
}
