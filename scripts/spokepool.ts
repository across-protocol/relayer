import assert from "assert";
import * as contracts from "@across-protocol/contracts-v2";
import { LogDescription } from "@ethersproject/abi";
import { Contract, ethers, Wallet } from "ethers";
import minimist from "minimist";
import { groupBy } from "lodash";
import { config } from "dotenv";
import { getDeployedContract, getNetworkName, getNodeUrlList, getSigner, resolveTokenSymbols } from "../src/utils";

type ERC20 = {
  address: string;
  decimals: number;
  symbol: string;
};

const { MaxUint256, Zero } = ethers.constants;
const { isAddress } = ethers.utils;

const testChains = [5, 280];
const chains = [1, 10, 137, 324, 8453, 42161];

function validateChainIds(chainIds: number[]): boolean {
  const knownChainIds = [...chains, ...testChains];
  return chainIds.every((chainId) => {
    const ok = knownChainIds.includes(chainId);
    if (!ok) {
      console.log(`Invalid chain ID: ${chainId}`);
    }
    return ok;
  });
}

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

/**
 * Resolves an ERC20 type from a chain ID, and symbol or address.
 * @param token The address or symbol of the token to resolve.
 * @param chainId The chain ID to resolve the token on.
 * @returns The ERC20 attributes of the token.
 */
function resolveToken(token: string, chainId: number): ERC20 {
  // `token` may be an address or a symbol. Normalise it to a symbol for easy lookup.
  const symbol = !isAddress(token)
    ? token.toUpperCase()
    : Object.values(contracts.TOKEN_SYMBOLS_MAP).find(({ addresses }) => addresses[chainId] === token)?.symbol;

  const _token = contracts.TOKEN_SYMBOLS_MAP[symbol];
  if (_token === undefined) {
    throw new Error(`Token ${token} on chain ID ${chainId} unrecognised`);
  }

  return {
    address: _token.addresses[chainId],
    decimals: _token.decimals,
    symbol: _token.symbol,
  };
}

function resolveHubChainId(spokeChainId: number): number {
  if (chains.includes(spokeChainId)) {
    return 1;
  }

  assert(testChains.includes(spokeChainId), `Unsupported SpokePool chain ID: ${spokeChainId}`);
  return 5;
}

async function getHubPoolContract(chainId: number): Promise<Contract> {
  const contractName = "HubPool";
  const hubPoolChainId = resolveHubChainId(chainId);

  const hubPool = getDeployedContract(contractName, hubPoolChainId);
  const provider = new ethers.providers.StaticJsonRpcProvider(getNodeUrlList(hubPoolChainId, 1)[0]);
  return hubPool.connect(provider);
}

async function getSpokePoolContract(chainId: number): Promise<Contract> {
  const hubPool = await getHubPoolContract(chainId);
  const spokePoolAddr = (await hubPool.crossChainContracts(chainId))[1];

  const contract = new Contract(spokePoolAddr, contracts.SpokePool__factory.abi);
  return contract;
}

async function deposit(args: Record<string, number | string>, signer: Wallet): Promise<boolean> {
  const depositor = await signer.getAddress();
  const [fromChainId, toChainId, baseAmount] = [Number(args.from), Number(args.to), Number(args.amount)];
  const recipient = (args.recipient as string) ?? depositor;

  if (!validateChainIds([fromChainId, toChainId])) {
    usage(); // no return
  }
  const network = getNetworkName(fromChainId);

  if (!isAddress(recipient)) {
    console.log(`Invalid recipient address (${recipient})`);
    usage(); // no return
  }

  const token = resolveToken(args.token as string, fromChainId);
  const tokenSymbol = token.symbol.toUpperCase();
  const amount = ethers.utils.parseUnits(baseAmount.toString(), args.decimals ? 0 : token.decimals);

  const provider = new ethers.providers.StaticJsonRpcProvider(getNodeUrlList(fromChainId, 1)[0]);
  signer = signer.connect(provider);
  const spokePool = (await getSpokePoolContract(fromChainId)).connect(signer);

  const erc20 = new Contract(token.address, contracts.ExpandedERC20__factory.abi, signer);
  const allowance = await erc20.allowance(depositor, spokePool.address);
  if (amount.gt(allowance)) {
    const approvalAmount = amount.mul(5);
    const approval = await erc20.approve(spokePool.address, approvalAmount);
    console.log(`Approving SpokePool for ${approvalAmount} ${tokenSymbol}: ${approval.hash}.`);
    await approval.wait();
    console.log("Approval complete...");
  }

  const relayerFeePct = Zero; // @todo: Make configurable.
  const maxCount = MaxUint256;
  const quoteTimestamp = Math.round(Date.now() / 1000);

  const deposit = await spokePool.deposit(
    recipient,
    token.address,
    amount,
    toChainId,
    relayerFeePct,
    quoteTimestamp,
    "0x",
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
  const _spokePool = await getSpokePoolContract(chainId);

  const hubChainId = resolveHubChainId(chainId);
  const spokeProvider = new ethers.providers.StaticJsonRpcProvider(getNodeUrlList(chainId, 1)[0]);
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

  if (!validateChainIds([chainId])) {
    usage(); // no return
  }

  if (txnHash === undefined || typeof txnHash !== "string" || txnHash.length != 66 || !txnHash.startsWith("0x")) {
    throw new Error(`Missing or malformed transaction hash: ${txnHash}`);
  }

  const provider = new ethers.providers.StaticJsonRpcProvider(getNodeUrlList(chainId, 1)[0]);
  const spokePool = await getSpokePoolContract(chainId);

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
  const depositOpts = ["from", "to", "token", "amount", "recipient"];
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
