/*
End-to-end test of the TransactionManager broker loop with an ERC20.transfer.
Acts as a minimal caller bot that submits via redis instead of direct RPC.

Setup (two terminals + redis):

  # 1. Redis (e.g. docker run -p 6379:6379 redis)

  # 2. Manager — owns the wallet, listens on txn:requests:<chainId>:<eoa>
  TXN_MANAGER_CHAIN_ID=11155111 \
    yarn ts-node ./index.ts --transactionManager --wallet=secret

  # 3. This script — same wallet (so the EOA matches), submits via redis
  TRANSACTION_CLIENT_BROADCAST=redis \
    yarn ts-node ./scripts/testTxnManagerErc20.ts \
      --chainId 11155111 \
      --token 0x... \
      --to 0x... \
      --amount 1000000 \
      --wait \
      --wallet=secret

  # Optional: tail traffic in a 4th terminal
  yarn ts-node ./scripts/inspectTxnStream.ts --chain 11155111 --requests --responses

Notes:
- The shim and manager must use the SAME wallet (same EOA), since the
  request stream is keyed by the caller's `txn.contract.signer` EOA and the
  manager only listens on its own EOA's stream.
- The caller-side broadcast mode is forced via TRANSACTION_CLIENT_BROADCAST=redis;
  the script doesn't read CommonConfig.
*/

import minimist from "minimist";
import winston from "winston";
import { ERC20, ethers, getProvider, retrieveSignerFromCLIArgs, toBN } from "../src/utils";
import {
  AugmentedTransaction,
  TransactionClient,
  initTransactionBackend,
  disposeTransactionBackend,
} from "../src/clients/TransactionClient";

const logger = winston.createLogger({
  level: "debug",
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

interface CliArgs {
  chainId: number;
  token: string;
  to: string;
  amount: string;
  wait: boolean;
}

function parseArgs(): CliArgs {
  const argv = minimist(process.argv.slice(2), {
    string: ["chainId", "token", "to", "amount"],
    boolean: ["wait"],
  });
  for (const k of ["chainId", "token", "to", "amount"]) {
    if (!argv[k]) {
      throw new Error(`--${k} is required`);
    }
  }
  if (!ethers.utils.isAddress(argv.token)) {
    throw new Error(`Invalid --token: ${argv.token}`);
  }
  if (!ethers.utils.isAddress(argv.to)) {
    throw new Error(`Invalid --to: ${argv.to}`);
  }
  return {
    chainId: Number(argv.chainId),
    token: argv.token,
    to: argv.to,
    amount: argv.amount,
    wait: Boolean(argv.wait),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();

  const baseSigner = await retrieveSignerFromCLIArgs();
  const eoa = await baseSigner.getAddress();
  const provider = await getProvider(args.chainId);
  const signer = baseSigner.connect(provider);
  logger.info({ at: "test", message: "wallet connected", eoa, chainId: args.chainId });

  const callerId = `test-caller-${Date.now()}`;
  await initTransactionBackend(logger, "redis", callerId);
  const txnClient = new TransactionClient(logger);

  const erc20 = new ethers.Contract(args.token, ERC20.abi, signer);
  const [decimals, symbol] = await Promise.all([erc20.decimals(), erc20.symbol()]);
  const human = ethers.utils.formatUnits(args.amount, decimals);
  logger.info({
    at: "test",
    message: `Submitting transfer of ${human} ${symbol} → ${args.to}`,
    token: args.token,
    callerId,
  });

  const augTxn: AugmentedTransaction = {
    contract: erc20,
    chainId: args.chainId,
    method: "transfer",
    args: [args.to, toBN(args.amount)],
    message: `test-erc20-transfer ${human} ${symbol}`,
    mrkdwn: `transfer ${human} ${symbol} → ${args.to}`,
  };

  const t0 = Date.now();
  const responses = await txnClient.submit(args.chainId, [augTxn]);
  if (responses.length === 0) {
    throw new Error("submit() returned no responses — see preceding log for the underlying failure.");
  }
  const [response] = responses;
  logger.info({
    at: "test",
    message: "ACK received",
    hash: response.hash,
    nonce: response.nonce,
    elapsedMs: Date.now() - t0,
  });

  if (args.wait) {
    const tWait = Date.now();
    const receipt = await response.wait();
    logger.info({
      at: "test",
      message: "final received",
      hash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      status: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
      confirmationMs: Date.now() - tWait,
    });
  }

  await disposeTransactionBackend();
}

void main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ at: "test", message: "fatal", error: err instanceof Error ? err.stack : String(err) });
    process.exit(1);
  });
