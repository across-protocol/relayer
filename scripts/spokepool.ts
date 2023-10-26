import axios, { isAxiosError } from "axios";
import minimist from "minimist";
import { constants as sdkConsts, utils as sdkUtils } from "@across-protocol/sdk-v2";
import { ExpandedERC20__factory as ERC20 } from "@across-protocol/contracts-v2";
import { LogDescription } from "@ethersproject/abi";
import { Contract, ethers, Wallet } from "ethers";
import { groupBy } from "lodash";
import { config } from "dotenv";
import { BigNumber, formatFeePct, getNetworkName, getSigner, isDefined, resolveTokenSymbols, toBN } from "../src/utils";
import * as utils from "./utils";

type relayerFeeQuery = {
  originChainId: number;
  destinationChainId: number;
  token: string;
  amount: string;
  recipientAddress?: string;
  message?: string;
};

const { ACROSS_API_HOST = "across.to" } = process.env;

const { fixedPointAdjustment: fixedPoint } = sdkUtils;
const { MaxUint256, Zero } = ethers.constants;
const { isAddress } = ethers.utils;

function printDeposit(log: LogDescription): void {
  const { originChainId, originToken } = log.args;
  const eventArgs = Object.keys(log.args).filter((key) => isNaN(Number(key)));
  const padLeft = eventArgs.reduce((acc, cur) => (cur.length > acc ? cur.length : acc), 0);

  const fields = {
    tokenSymbol: resolveTokenSymbols([originToken], originChainId)[0],
    ...Object.fromEntries(eventArgs.map((key) => [key, log.args[key]])),
  };
  console.log(
    `Deposit # ${log.args.depositId} on ${getNetworkName(originChainId)}:\n` +
      Object.entries(fields)
        .map(([k, v]) => `\t${k.padEnd(padLeft)} : ${v}`)
        .join("\n") +
      "\n"
  );
}

function printFill(log: LogDescription): void {
  const { originChainId, destinationChainId, destinationToken, amount, totalFilledAmount } = log.args;
  const eventArgs = Object.keys(log.args).filter((key) => isNaN(Number(key)));
  const padLeft = eventArgs.reduce((acc, cur) => (cur.length > acc ? cur.length : acc), 0);

  const fields = {
    tokenSymbol: resolveTokenSymbols([destinationToken], destinationChainId)[0],
    totalFilledPct: `${totalFilledAmount.mul(100).div(amount)} %`,
    ...Object.fromEntries(eventArgs.map((key) => [key, log.args[key]])),
  };
  console.log(
    `Fill for ${getNetworkName(originChainId)} deposit # ${log.args.depositId}:\n` +
      Object.entries(fields)
        .map(([k, v]) => `\t${k.padEnd(padLeft)} : ${v}`)
        .join("\n") +
      "\n"
  );
}

async function getRelayerFeePct(params: relayerFeeQuery, timeout = 5000): Promise<BigNumber> {
  const path = "api/suggested-fees";
  const url = `https://${ACROSS_API_HOST}/${path}`;

  try {
    const quote = await axios.get(url, { timeout, params });
    if (!isDefined(quote.data["relayFeePct"])) {
      throw new Error("relayFeePct missing from suggested-fees response");
    }
    return toBN(quote.data["relayFeePct"]);
  } catch (err) {
    if (isAxiosError(err) && err.response.status >= 400) {
      throw new Error(`Failed to get quote for deposit (${err.response.data})`);
    }
    throw err;
  }
}

async function getRelayerQuote(
  fromChainId: number,
  toChainId: number,
  token: utils.ERC20,
  amount: BigNumber,
  recipient?: string,
  message?: string
): Promise<BigNumber> {
  const tokenFormatter = sdkUtils.createFormatFunction(2, 4, false, token.decimals);
  let relayerFeePct = Zero;
  let quoteAccepted = false;
  do {
    relayerFeePct = await getRelayerFeePct({
      token: token.address,
      originChainId: fromChainId,
      destinationChainId: toChainId,
      amount: amount.toString(),
      recipientAddress: recipient,
      message
    });

    const feeAmount = amount.mul(relayerFeePct).div(fixedPoint);
    const quote =
      `Relayer fee quote for ${tokenFormatter(amount)} ${token.symbol} ${fromChainId} -> ${toChainId}:` +
      ` ${formatFeePct(relayerFeePct)} % (${tokenFormatter(feeAmount)} ${token.symbol})`;
    quoteAccepted = await utils.askYesNoQuestion(quote);
  } while (!quoteAccepted);

  return relayerFeePct;
}

async function deposit(args: Record<string, number | string>, signer: Wallet): Promise<boolean> {
  const depositor = await signer.getAddress();
  const [fromChainId, toChainId, baseAmount] = [Number(args.from), Number(args.to), Number(args.amount)];
  const recipient = (args.recipient as string) ?? depositor;
  const message = (args.message as string) ?? sdkConsts.EMPTY_MESSAGE;

  if (!utils.validateChainIds([fromChainId, toChainId])) {
    usage(); // no return
  }
  const network = getNetworkName(fromChainId);

  if (!isAddress(recipient)) {
    console.log(`Invalid recipient address (${recipient})`);
    usage(); // no return
  }

  const token = utils.resolveToken(args.token as string, fromChainId);
  const tokenSymbol = token.symbol.toUpperCase();
  const amount = ethers.utils.parseUnits(baseAmount.toString(), args.decimals ? 0 : token.decimals);

  const provider = new ethers.providers.StaticJsonRpcProvider(utils.getProviderUrl(fromChainId));
  signer = signer.connect(provider);
  const spokePool = (await utils.getSpokePoolContract(fromChainId)).connect(signer);

  const erc20 = new Contract(token.address, ERC20.abi, signer);
  const allowance = await erc20.allowance(depositor, spokePool.address);
  if (amount.gt(allowance)) {
    const approvalAmount = amount.mul(5);
    const approval = await erc20.approve(spokePool.address, approvalAmount);
    console.log(`Approving SpokePool for ${approvalAmount} ${tokenSymbol}: ${approval.hash}.`);
    await approval.wait();
    console.log("Approval complete...");
  }
  const maxCount = MaxUint256;
  const relayerFeePct = isDefined(args.relayerFeePct)
    ? toBN(args.relayerFeePct)
    : await getRelayerQuote(fromChainId, toChainId, token, amount, recipient, message);

  const deposit = await spokePool.depositNow(
    recipient,
    token.address,
    amount,
    toChainId,
    relayerFeePct,
    message,
    maxCount
  );
  const { hash: transactionHash } = deposit;
  console.log(`Submitting ${tokenSymbol} deposit on ${network}: ${transactionHash}.`);
  const receipt = await deposit.wait();

  receipt.logs
    .filter((log) => log.address === spokePool.address)
    .forEach((log) => printDeposit(spokePool.interface.parseLog(log)));

  return true;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function dumpConfig(args: Record<string, number | string>, _signer: Wallet): Promise<boolean> {
  const chainId = Number(args.chainId);
  const _spokePool = await utils.getSpokePoolContract(chainId);

  const hubChainId = utils.resolveHubChainId(chainId);
  const spokeProvider = new ethers.providers.StaticJsonRpcProvider(utils.getProviderUrl(chainId));
  const spokePool = _spokePool.connect(spokeProvider);

  const [spokePoolChainId, hubPool, crossDomainAdmin, weth, _currentTime] = await Promise.all([
    spokePool.chainId(),
    spokePool.hubPool(),
    spokePool.crossDomainAdmin(),
    spokePool.wrappedNativeToken(),
    spokePool.getCurrentTime(),
  ]);

  if (chainId !== Number(spokePoolChainId)) {
    throw new Error(`Chain ${chainId} SpokePool mismatch: ${spokePoolChainId} != ${chainId} (${spokePool.address})`);
  }

  const currentTime = `${_currentTime} (${new Date(Number(_currentTime) * 1000).toUTCString()})`;

  const fields = {
    hubChainId,
    hubPool,
    crossDomainAdmin,
    weth,
    currentTime,
  };

  // @todo: Support handlers for chain-specific configuration (i.e. address of bridge to L1).

  const padLeft = Object.keys(fields).reduce((acc, cur) => (cur.length > acc ? cur.length : acc), 0);
  console.log(
    `${getNetworkName(chainId)} SpokePool configuration:\n` +
      Object.entries(fields)
        .map(([k, v]) => `\t${k.padEnd(padLeft)} : ${v}`)
        .join("\n") +
      "\n"
  );

  return true;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function fetchTxn(args: Record<string, number | string>, _signer: Wallet): Promise<boolean> {
  const { txnHash } = args;
  const chainId = Number(args.chainId);

  if (!utils.validateChainIds([chainId])) {
    usage(); // no return
  }

  if (txnHash === undefined || typeof txnHash !== "string" || txnHash.length != 66 || !txnHash.startsWith("0x")) {
    throw new Error(`Missing or malformed transaction hash: ${txnHash}`);
  }

  const provider = new ethers.providers.StaticJsonRpcProvider(utils.getProviderUrl(chainId));
  const spokePool = await utils.getSpokePoolContract(chainId);

  const txn = await provider.getTransactionReceipt(txnHash);
  const fundsDeposited = spokePool.interface.getEventTopic("FundsDeposited");
  const filledRelay = spokePool.interface.getEventTopic("FilledRelay");
  const logs = txn.logs.filter(({ address }) => address === spokePool.address);
  const { deposits = [], fills = [] } = groupBy(logs, ({ topics }) => {
    switch (topics[0]) {
      case fundsDeposited:
        return "deposits";
      case filledRelay:
        return "fills";
    }
  });

  deposits.forEach((deposit) => {
    printDeposit(spokePool.interface.parseLog(deposit));
  });

  fills.forEach((fill) => {
    printFill(spokePool.interface.parseLog(fill));
  });

  return true;
}

function usage(badInput?: string): boolean {
  let usageStr = badInput ? `\nUnrecognized input: "${badInput}".\n\n` : "";
  const walletOpts = "mnemonic|privateKey";
  const depositArgs =
    "--from <originChainId> --to <destinationChainId>" +
    " --token <tokenSymbol> --amount <amount> [--recipient <recipient>] [--decimals]";
  const dumpConfigArgs = "--chainId";
  const fetchArgs = "--chainId <chainId> --txnHash <txnHash>";
  const fillArgs = "--from <originChainId> --hash <depositHash>";

  const pad = "deposit".length;
  usageStr += `
    Usage:
    \tyarn ts-node ./scripts/spokepool --wallet <${walletOpts}> ${"deposit".padEnd(pad)} ${depositArgs}
    \tyarn ts-node ./scripts/spokepool --wallet <${walletOpts}> ${"dump".padEnd(pad)} ${dumpConfigArgs}
    \tyarn ts-node ./scripts/spokepool --wallet <${walletOpts}> ${"fetch".padEnd(pad)} ${fetchArgs}
    \tyarn ts-node ./scripts/spokepool --wallet <${walletOpts}> ${"fill".padEnd(pad)} ${fillArgs}
  `.slice(1); // Skip leading newline
  console.log(usageStr);

  // eslint-disable-next-line no-process-exit
  process.exit(badInput === undefined ? 0 : 9);
  // not reached
}

async function run(argv: string[]): Promise<boolean> {
  const configOpts = ["chainId"];
  const depositOpts = ["from", "to", "token", "amount", "recipient", "relayerFeePct", "message"];
  const fetchOpts = ["chainId", "transactionHash"];
  const fillOpts = [];
  const opts = {
    string: ["wallet", ...configOpts, ...depositOpts, ...fetchOpts, ...fillOpts],
    boolean: ["decimals"], // @dev tbd whether this is good UX or not...may need to change.
    default: {
      wallet: "mnemonic",
      decimals: false,
    },
    alias: {
      transactionHash: "txnHash",
    },
    unknown: usage,
  };
  const args = minimist(argv.slice(1), opts);

  config();

  let signer: Wallet;
  try {
    signer = await getSigner({ keyType: args.wallet, cleanEnv: true });
  } catch (err) {
    usage(args.wallet); // no return
  }

  switch (argv[0]) {
    case "deposit":
      return await deposit(args, signer);
    case "dump":
      return await dumpConfig(args, signer);
    case "fetch":
      return await fetchTxn(args, signer);
    case "fill":
      // @todo Not supported yet...
      usage(); // no return
      break; // ...keep the linter less dissatisfied!
    default:
      usage(); // no return
  }
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then(async () => {
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      // eslint-disable-next-line no-process-exit
      process.exit(1);
    });
}
