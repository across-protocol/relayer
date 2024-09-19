import minimist from "minimist";
import { WETH9__factory as WETH9 } from "@across-protocol/contracts";
import { constants as sdkConsts } from "@across-protocol/sdk";
import { ethers, Signer } from "ethers";
import { config } from "dotenv";
import { BigNumber, bnOne, bnUint256Max, formatEther, formatUnits, getNetworkName, getSigner } from "../src/utils";
import * as utils from "./utils";

const { PROTOCOL_DEFAULT_CHAIN_ID_INDICES } = sdkConsts;

const { NODE_SUCCESS, NODE_INPUT_ERR, NODE_APP_ERR } = utils;

function bnMax(a: BigNumber, b: BigNumber): BigNumber {
  const result = a.sub(b);
  return result.isZero() || result.gt(0) ? a : b;
}

async function dispute(args: Record<string, number | string>, signer: Signer): Promise<boolean> {
  const ethBuffer = "0.1"; // Spare ether required to pay for gas.

  const signerAddr = await signer.getAddress();
  const chainId = Number(args.chainId);
  const { force, txnHash } = args;

  const network = getNetworkName(chainId);
  const hubPool = await utils.getContract(chainId, "HubPool");
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
    bondToken.balanceOf(signerAddr),
    bondToken.decimals(),
    bondToken.symbol(),
    bondToken.allowance(signerAddr, hubPool.address),
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
    const approval = await bondToken.connect(signer).approve(hubPool.address, bnUint256Max);
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
      "To dispute, re-run with the following transaction hash (WARNING: THIS *WILL* SUBMIT A DISPUTE):\n" +
        `\n\t--txnHash ${rootBundleProposal.transactionHash}\n` +
        "\nFor example:\n" +
        `\n\tyarn dispute --txnHash ${rootBundleProposal.transactionHash}\n`
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
async function search(args: Record<string, number | string>, _signer: Signer): Promise<boolean> {
  const eventName = args.event as string;
  const fromBlock = Number(args.fromBlock) || undefined;
  const toBlock = Number(args.toBlock) || undefined;
  const chainId = Number(args.chainId);

  if (!isNaN(fromBlock) && !isNaN(toBlock) && toBlock < fromBlock) {
    throw new Error(`Invalid block range: ${fromBlock}, ${toBlock}`);
  }

  const [configStore, hubPool] = await Promise.all([
    utils.getContract(chainId, "AcrossConfigStore"),
    utils.getContract(chainId, "HubPool"),
  ]);

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

    // If the ConfigStore doesn't have CHAIN_ID_INDICES defined at the relevant block, sub in the implicit initial
    // value. This is only applicable to production and will be incorrect on Görli. Görli will soon be deprecated,
    // at which point it won't be relevant anyway.
    const chainIds =
      _chainIds.length > 0 ? JSON.parse(_chainIds.replaceAll('"', "")) : PROTOCOL_DEFAULT_CHAIN_ID_INDICES;

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
      wallet: "secret",
      force: false,
    },
    alias: {
      transactionHash: "txnHash",
    },
    unknown: usage,
  };
  const args = minimist(argv.slice(1), opts);

  config();

  const cmd = argv[0];
  let signer: Signer;
  try {
    const keyType = ["dispute"].includes(cmd) ? args.wallet : "void";
    signer = await getSigner({ keyType, cleanEnv: true });
  } catch (err) {
    return usage(args.wallet) ? NODE_SUCCESS : NODE_INPUT_ERR;
  }

  let result: boolean;
  switch (cmd) {
    case "dispute":
      result = await dispute(args, signer);
      break;
    case "search":
      result = await search(args, signer);
      break;
    default:
      return usage(cmd) ? NODE_SUCCESS : NODE_INPUT_ERR;
  }

  return result ? NODE_SUCCESS : NODE_APP_ERR;
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then(async (result) => (process.exitCode = result))
    .catch(async (error) => {
      console.error("Process exited with", error);
      process.exitCode = NODE_APP_ERR;
    });
}
