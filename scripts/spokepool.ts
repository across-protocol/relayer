import assert from "assert";
import * as contracts from "@across-protocol/contracts-v2";
import { LogDescription } from "@ethersproject/abi";
import { BigNumber, Contract, ethers, Wallet } from "ethers";
import minimist from "minimist";
import { groupBy } from "lodash";
import { config } from "dotenv";
import { getDeployedContract, getNetworkName, getNodeUrlList, resolveTokenSymbols } from "../src/utils";

type ERC20 = {
  address: string;
  decimals: number;
  symbol: string;
};

const { MaxUint256, Zero } = ethers.constants;

const testChains = [5, 280];
const chains = [1, 10, 137, 324, 42161];

const padding = 20;

function formatAddress(address: string, maxWidth = 18): string {
  const separator = "...";
  const textLen = maxWidth - separator.length;
  return (
    address.substring(0, Math.ceil(textLen / 2)) +
    "..." +
    address.substring(address.length - Math.floor(textLen / 2), address.length)
  );
}

function printDeposit(log: LogDescription): void {
  const originChainId = log.args.originChainId as number;
  const destinationChainId = log.args.destinationChainId as number;
  const depositor = log.args.depositor as string;
  const recipient = log.args.depositor as string;
  const originToken = log.args.originToken;
  const amount = log.args.amount as BigNumber;

  const tokenSymbol = resolveTokenSymbols([originToken], originChainId)[0];
  console.log(
    `Fill for ${getNetworkName(originChainId)} deposit # ${log.args.depositId}\n` +
      `\t${"Depositor".padEnd(padding)}: ${formatAddress(depositor, 18)}\n` +
      `\t${"Recipient".padEnd(padding)}: ${formatAddress(recipient, 18)}\n` +
      `\t${"Origin chain".padEnd(padding)}: ${getNetworkName(originChainId).toString().padStart(18)}\n` +
      `\t${"Destination chain".padEnd(padding)}: ${getNetworkName(destinationChainId).padStart(18)}\n` +
      `\t${"Token".padEnd(padding)}: ${tokenSymbol.padStart(18)}\n` +
      `\t${"Amount".padEnd(padding)}: ${amount.toString().padStart(18)}\n` +
      `\t${"Relayer Fee".padEnd(padding)}: ${log.args.relayerFeePct.toString().padStart(18)}\n`
  );
}

function printFill(log: LogDescription): void {
  const originChainId = log.args.originChainId as number;
  const destinationChainId = log.args.destinationChainId as number;
  const depositor = log.args.depositor as string;
  const recipient = log.args.depositor as string;
  const destinationToken = log.args.destinationToken;
  const amount = log.args.amount as BigNumber;
  const totalFilledAmount = log.args.totalFilledAmount as BigNumber;

  const tokenSymbol = resolveTokenSymbols([destinationToken], destinationChainId)[0];
  const totalFilledPct = `${totalFilledAmount.mul(100).div(amount)} %`;
  console.log(
    `Fill for ${getNetworkName(originChainId)} deposit # ${log.args.depositId}\n` +
      `\t${"Depositor".padEnd(padding)}: ${formatAddress(depositor, 18)}\n` +
      `\t${"Recipient".padEnd(padding)}: ${formatAddress(recipient, 18)}\n` +
      `\t${"Origin chain".padEnd(padding)}: ${getNetworkName(originChainId).toString().padStart(18)}\n` +
      `\t${"Destination chain".padEnd(padding)}: ${getNetworkName(destinationChainId).padStart(18)}\n` +
      `\t${"Token".padEnd(padding)}: ${tokenSymbol.padStart(18)}\n` +
      `\t${"Amount".padEnd(padding)}: ${amount.toString().padStart(18)}\n` +
      `\t${"Fill Amount".padEnd(padding)}: ${log.args.fillAmount.toString().padStart(18)}\n` +
      `\t${"Relayer Fee".padEnd(padding)}: ${log.args.relayerFeePct.toString().padStart(18)}\n` +
      `\t${"LP Fee".padEnd(padding)}: ${log.args.realizedLpFeePct.toString().padStart(18)}\n` +
      `\t${"Filled".padEnd(padding)}: ${totalFilledPct.padStart(18)}\n`
  );
}

function getTokenAddress(symbol: string, chainId: number): ERC20 {
  const token = contracts.TOKEN_SYMBOLS_MAP[symbol];
  if (token === undefined) {
    throw new Error(`Token ${symbol} unrecognised`);
  }

  const { addresses, decimals } = token;
  const address = addresses[chainId];
  if (address === undefined) {
    throw new Error(`Token ${symbol} not supported on chain ID ${chainId}`);
  }

  return { address: addresses[chainId], decimals, symbol };
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
  const fromChainId = Number(args.from);
  const toChainId = Number(args.to);
  const recipient = args.recipient ?? depositor;
  const baseAmount = Number(args.amount);
  const tokenSymbol = (args.token as string).toUpperCase();

  const provider = new ethers.providers.StaticJsonRpcProvider(getNodeUrlList(fromChainId, 1)[0]);
  signer = signer.connect(provider);
  const spokePool = (await getSpokePoolContract(fromChainId)).connect(signer);

  const token = getTokenAddress(tokenSymbol, fromChainId);
  const amount = ethers.utils.parseUnits(baseAmount.toString(), token.decimals);

  const erc20 = new Contract(token.address, contracts.ExpandedERC20__factory.abi, signer);
  const allowance = await erc20.allowance(depositor, spokePool.address);
  if (amount.gt(allowance)) {
    const approvalAmount = amount.mul(5);
    const approval = await erc20.approve(spokePool.address, approvalAmount);
    console.log(`Approving SpokePool for ${approvalAmount} ${tokenSymbol}: ${approval.hash}.`);
    await approval.wait();
    console.log("Approval complete...");
  }

  const relayerFeePct = Zero;
  const maxCount = MaxUint256;
  const quoteTimestamp = Math.round(Date.now() / 1000);

  console.log(
    `Submitting deposit on chain ID ${fromChainId}\n` +
      `\t${"originChainId".padEnd(padding)}: ${fromChainId}\n` +
      `\t${"destinationChainId".padEnd(padding)}: ${toChainId}\n` +
      `\t${"depositor".padEnd(padding)}: ${depositor}\n` +
      `\t${"recipient".padEnd(padding)}: ${recipient}\n` +
      `\t${"relayerFeePct".padEnd(padding)}: ${relayerFeePct}\n` +
      `\t${"quoteTimestamp".padEnd(padding)}: ${quoteTimestamp}\n`
  );
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
  console.log("Submitted deposit:");
  const receipt = await deposit.wait();
  receipt.logs
    .filter((log) => log.address === spokePool.address)
    .forEach((_log) => {
      const log = spokePool.interface.parseLog(_log);
      console.log(
        `\t${"depositId".padEnd(padding)}: ${log.args.depositId}\n` +
          `\t${"transactionHash".padEnd(padding)}: ${_log.transactionHash}\n`
      );
    });

  return true;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function dumpConfig(args: Record<string, number | string>, _signer: Wallet): Promise<boolean> {
  const chainId = Number(args.chainId);
  const _spokePool = await getSpokePoolContract(chainId);

  const hubChainId = resolveHubChainId(chainId);
  const spokeProvider = new ethers.providers.StaticJsonRpcProvider(getNodeUrlList(chainId, 1)[0]);
  const spokePool = _spokePool.connect(spokeProvider);

  const [spokePoolChainId, hubPoolAddress, admin, wethAddress, _currentTime] = await Promise.all([
    spokePool.chainId(),
    spokePool.hubPool(),
    spokePool.crossDomainAdmin(),
    spokePool.wrappedNativeToken(),
    spokePool.getCurrentTime(),
  ]);

  // deploymentBlock = deployments[chainId.toString()].SpokePool.blockNumber;
  // const adminAlias = ethers.utils.getAddress(ethers.BigNumber.from(admin).add(zkUtils.L1_TO_L2_ALIAS_OFFSET).toHexString());

  if (chainId !== Number(spokePoolChainId)) {
    throw new Error(`Chain ${chainId} SpokePool mismatch: ${spokePoolChainId} != ${chainId} (${spokePool.address})`);
  }

  const adminAlias = "...tbd";
  const currentTime = Number(_currentTime);
  const currentTimeStr = new Date(Number(currentTime) * 1000).toUTCString();

  console.log(
    `Dumping chain ${chainId} SpokePool config:\n` +
      `\t${"HubPool chain ID".padEnd(padding)}: ${hubChainId}\n` +
      `\t${"HubPool address".padEnd(padding)}: ${hubPoolAddress}\n` +
      `\t${"Cross-domain admin".padEnd(padding)}: ${admin}\n` +
      `\t${"Cross-domain alias".padEnd(padding)}: ${adminAlias}\n` +
      `\t${"WETH".padEnd(padding)}: ${wethAddress}\n` +
      `\t${"Current time".padEnd(padding)}: ${currentTimeStr} (${currentTime})\n`
  );

  return true;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function fetchTxn(args: Record<string, number | string>, _signer: Wallet): Promise<boolean> {
  const { txnHash } = args;
  const chainId = Number(args.chainId);

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
  const depositArgs = "--from <originChainId> --to <destinationChainId>" + " --token <tokenSymbol> --amount <amount>";
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
    default: {
      wallet: "mnemonic",
    },
    alias: {
      transactionHash: "txnHash",
    },
    unknown: usage,
  };
  const args = minimist(argv.slice(1), opts);

  config();

  let signer: Wallet;
  switch (args.wallet) {
    case "mnemonic":
      signer = Wallet.fromMnemonic(process.env.MNEMONIC);
      break;
    case "privateKey":
      signer = new Wallet(process.env.PRIVATE_KEY);
      break;
    default:
      usage(args.wallet); // no return
  }
  ["MNEMONIC", "PRIVATE_KEY"].forEach((envVar) => (process.env[envVar] = ""));

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
