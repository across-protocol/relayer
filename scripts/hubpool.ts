import assert from "assert";
import * as contracts from "@across-protocol/contracts-v2";
import { BigNumber, Contract, ethers, Wallet } from "ethers";
import minimist from "minimist";
import { config } from "dotenv";
import { getDeployedContract, getNetworkName, getNodeUrlList, getSigner } from "../src/utils";

const { WETH9__factory: WETH9 } = contracts;
const { MaxUint256, One: bnOne } = ethers.constants;
const { formatEther, formatUnits } = ethers.utils;

// https://nodejs.org/api/process.html#exit-codes
const NODE_SUCCESS = 0;
const NODE_INPUT_ERR = 9;
const NODE_APP_ERR = 127; // user-defined

const testChains = [5, 280];
const chains = [1, 10, 137, 324, 8453, 42161];

function bnMax(a: BigNumber, b: BigNumber): BigNumber {
  const result = a.sub(b);
  return result.isZero() || result.gt(0) ? a : b;
}

function resolveHubChainId(spokeChainId: number): number {
  if (chains.includes(spokeChainId)) {
    return 1;
  }

  assert(testChains.includes(spokeChainId), `Unsupported SpokePool chain ID: ${spokeChainId}`);
  return 5;
}

async function getConfigStore(chainId: number): Promise<Contract> {
  const contractName = "AcrossConfigStore";
  const hubPoolChainId = resolveHubChainId(chainId);

  const configStore = getDeployedContract(contractName, hubPoolChainId);
  const provider = new ethers.providers.StaticJsonRpcProvider(getNodeUrlList(hubPoolChainId, 1)[0]);
  return configStore.connect(provider);
}

async function getHubPoolContract(chainId: number): Promise<Contract> {
  const contractName = "HubPool";
  const hubPoolChainId = resolveHubChainId(chainId);

  const hubPool = getDeployedContract(contractName, hubPoolChainId);
  const provider = new ethers.providers.StaticJsonRpcProvider(getNodeUrlList(hubPoolChainId, 1)[0]);
  return hubPool.connect(provider);
}

async function dispute(args: Record<string, number | string>, signer: Wallet): Promise<boolean> {
  const ethBuffer = "0.1"; // Spare ether required to pay for gas.

  const chainId = Number(args.chainId);
  const { force, txnHash } = args;

  const network = getNetworkName(chainId);
  const hubPool = await getHubPoolContract(chainId);
  signer = signer.connect(hubPool.provider);
  const [bondTokenAddress, bondAmount, proposal, liveness, latestBlock] = await Promise.all([
    hubPool.bondToken(),
    hubPool.bondAmount(),
    hubPool.rootBundleProposal(),
    hubPool.liveness(),
    hubPool.provider.getBlock("latest"),
  ]);

  const filter = hubPool.filters.ProposeRootBundle();
  const avgBlockTime = 12.5; // @todo import
  const fromBlock = Math.floor(latestBlock.number - (liveness - avgBlockTime));
  const bondToken = WETH9.connect(bondTokenAddress, hubPool.provider);
  const [bondBalance, decimals, symbol, allowance, proposals] = await Promise.all([
    bondToken.balanceOf(signer.address),
    bondToken.decimals(),
    bondToken.symbol(),
    bondToken.allowance(signer.address, hubPool.address),
    hubPool.queryFilter(filter, fromBlock, latestBlock.number),
  ]);

  /* Resolve the existing proposal to dump its information. */
  const { poolRebalanceRoot, relayerRefundRoot, slowRelayRoot, challengePeriodEndTimestamp } = proposal;
  const rootBundleProposal = proposals.find(({ args }) => {
    return (
      args.poolRebalanceRoot === poolRebalanceRoot &&
      args.relayerRefundRoot === relayerRefundRoot &&
      args.slowRelayRoot === slowRelayRoot
    );
  });
  const fields = {
    address: bondToken.address,
    symbol,
    amount: formatUnits(bondAmount, decimals),
    balance: formatUnits(bondBalance, decimals),
  };

  // @dev This works fine but is hackish. Might be nice to refactor later.
  const proposalKeys = Object.keys(proposal).filter((key) => isNaN(Number(key)));
  const _proposal = {
    blockNumber: rootBundleProposal?.blockNumber,
    transactionHash: rootBundleProposal?.transactionHash,
    ...Object.fromEntries(proposalKeys.map((k) => [k, proposal[k]])),
  };

  const padLeft = [...Object.keys(fields), ...Object.keys(_proposal)].reduce(
    (acc, cur) => (cur.length > acc ? cur.length : acc),
    0
  );
  console.log(
    `${network} HubPool Dispute Bond:\n` +
      Object.entries(fields)
        .map(([k, v]) => `\t${k.padEnd(padLeft)} : ${v}`)
        .join("\n") +
      "\n"
  );

  if (rootBundleProposal === undefined) {
    console.log(
      `Warning: No matching root bundle proposal found between ${network} blocks ${fromBlock}, ${latestBlock.number}.`
    );
  } else {
    console.log(
      `${network} Root Bundle Proposal:\n` +
        Object.entries(_proposal)
          .map(([k, v]) => `\t${k.padEnd(padLeft)} : ${v}`)
          .join("\n") +
        "\n"
    );
  }

  if (allowance.lt(bondAmount)) {
    console.log(`Approving ${network} HubPool @ ${hubPool.address} to transfer ${symbol}.`);
    const approval = await bondToken.connect(signer).approve(hubPool.address, MaxUint256);
    console.log(`Approval: ${approval.hash}...`);
    await approval.wait();
  }

  if (bondBalance.lt(bondAmount)) {
    const buffer = ethers.utils.parseEther(ethBuffer);
    const ethBalance = await signer.getBalance();
    if (ethBalance.lt(bondAmount.add(buffer))) {
      const minDeposit = bondAmount.add(buffer).sub(ethBalance).sub(bondBalance);
      console.log(
        `Cannot dispute - insufficient ${symbol} balance.` + ` Deposit at least ${formatUnits(minDeposit, 18)} ETH.`
      );
      return false;
    }
    const depositAmount = bnMax(bondAmount.sub(bondBalance), bnOne); // Enforce minimum 1 Wei for test.
    console.log(`Depositing ${formatEther(depositAmount)} @ ${bondToken.address}.`);
    const deposit = await bondToken.connect(signer).deposit({ value: depositAmount });
    console.log(`Deposit: ${deposit.hash}...`);
    await deposit.wait();
  }
  if (latestBlock.timestamp >= challengePeriodEndTimestamp && !force) {
    console.log("Nothing to dispute: no active propopsal.");
    return txnHash === undefined;
  }

  // The txn hash of the proposal must be supplied in order to dispute.
  // If no hash was supplied, request the user to re-run with the applicable hash.
  if (txnHash !== rootBundleProposal.transactionHash && !force) {
    if (txnHash !== undefined) {
      console.log(`Invalid proposal transaction hash supplied: ${txnHash}.`);
    }
    console.log(
      "To dispute, re-run with the following transaction hash (WARNING: THIS *WILL* SUBMIT A DISPUTE):\n\n" +
        `\t--txnHash ${rootBundleProposal.transactionHash}\n`
    );
    return txnHash === undefined;
  }

  const dispute = await hubPool.connect(signer).disputeRootBundle();
  console.log(`Disputing ${network} HubPool proposal: ${dispute.hash}.`);
  await dispute.wait();
  console.log("Disputed HubPool proposal.");

  return true;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function search(args: Record<string, number | string>, _signer: Wallet): Promise<boolean> {
  const eventName = args.event as string;
  const fromBlock = Number(args.fromBlock) || undefined;
  const toBlock = Number(args.toBlock) || undefined;
  const chainId = Number(args.chainId);

  if (!isNaN(fromBlock) && !isNaN(toBlock) && toBlock < fromBlock) {
    throw new Error(`Invalid block range: ${fromBlock}, ${toBlock}`);
  }

  const [configStore, hubPool] = await Promise.all([getConfigStore(chainId), getHubPoolContract(chainId)]);

  const filter = hubPool.filters[eventName]?.();
  if (filter === undefined) {
    throw new Error(`Unrecognised HubPool event (${eventName})`);
  }

  const events = await hubPool.queryFilter(filter, fromBlock, toBlock);
  const CHAIN_ID_INDICES = ethers.utils.formatBytes32String("CHAIN_ID_INDICES");
  for (const { transactionHash, blockNumber, data, topics } of events) {
    const [block, liveness, _chainIds] = await Promise.all([
      hubPool.provider.getBlock(blockNumber),
      hubPool.liveness({ blockTag: blockNumber }),
      configStore.globalConfig(CHAIN_ID_INDICES, { blockTag: blockNumber }),
    ]);

    const DEFAULT_CHAIN_IDS = chainId === 1 ? chains : testChains;
    const chainIds = _chainIds.length > 0 ? JSON.parse(_chainIds.replaceAll('"', "")) : DEFAULT_CHAIN_IDS;

    const args = hubPool.interface.parseLog({ data, topics }).args;
    const eventArgs = Object.keys(args).filter((key) => isNaN(Number(key)));
    const dateStr = new Date(Number(block.timestamp * 1000)).toUTCString();

    const fields = {
      blockNumber,
      timestamp: `${block.timestamp} (${dateStr})`,
      transactionHash,
      liveness,
      chainIds: chainIds.join(","),
      ...Object.fromEntries(eventArgs.map((arg) => [arg, args[arg]])),
    };
    const padLeft = Object.keys(fields).reduce((acc, cur) => (cur.length > acc ? cur.length : acc), 0);
    console.log(
      Object.entries(fields)
        .map(([k, v]) => `${k.padEnd(padLeft)} : ${v}`)
        .join("\n") + "\n"
    );
  }

  return true;
}

function usage(badInput?: string): boolean {
  let usageStr = badInput ? `\nUnrecognized input: "${badInput}".\n\n` : "";
  const walletOpts = "mnemonic|privateKey";
  const runtimeArgs = {
    dispute: ["--chainId", "[--txnHash <proposalHash>]"],
    search: ["--chainId", "--event <eventName>", "[--fromBlock <fromBlock>]", "[--toBlock <toBlock>]"],
  };

  usageStr += "Usage:\n";
  usageStr += Object.entries(runtimeArgs)
    .map(([k, v]) => `\tyarn hubpool --wallet <${walletOpts}> ${k} ${v.join(" ")}`)
    .join("\n");

  console.log(usageStr);
  return badInput === undefined ? false : true;
}

async function run(argv: string[]): Promise<number> {
  const opts = {
    string: ["chainId", "transactionHash", "event", "fromBlock", "toBlock", "wallet"],
    boolean: ["force"],
    default: {
      chainId: 1,
      event: "ProposeRootBundle",
      wallet: "mnemonic",
      force: false,
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
    return usage(args.wallet) ? NODE_SUCCESS : NODE_INPUT_ERR;
  }

  let result: boolean;
  switch (argv[0]) {
    case "dispute":
      result = await dispute(args, signer);
      break;
    case "search":
      result = await search(args, signer);
      break;
    default:
      return usage() ? NODE_SUCCESS : NODE_INPUT_ERR;
  }

  return result ? NODE_SUCCESS : NODE_APP_ERR;
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then(async (result) => {
      process.exitCode = result;
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      process.exitCode = NODE_APP_ERR;
    });
}
