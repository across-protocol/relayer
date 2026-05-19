/*
Parallel-broadcast test of the TransactionManager loop. Fires N submits via
Promise.all and validates that the manager processes them in stream order with
consecutive nonces.

Setup mirrors testTxnManagerErc20:

  TXN_MANAGER_CHAIN_ID=11155111 yarn ts-node ./index.ts --transactionManager --wallet=secret

  TRANSACTION_CLIENT_BROADCAST=redis \
    yarn ts-node ./scripts/testTxnManagerParallel.ts \
      --chainId 11155111 \
      --token 0x... \
      --to 0x... \
      --count 5 \
      --wallet=secret

The script intentionally uses amount=0 so balance isn't a constraint.

What it asserts:
- All N submits resolve (no failures).
- Hashes are unique.
- Nonces are consecutive (manager's _runTransaction nonceBySigner state).
- Optionally `--wait` to also confirm each receipt.
*/

import minimist from "minimist";
import winston from "winston";
import { ERC20, ethers, getProvider, retrieveSignerFromCLIArgs } from "../src/utils";
import {
  AugmentedTransaction,
  TransactionClient,
  initTransactionBackend,
  disposeTransactionBackend,
} from "../src/clients/TransactionClient";

const logger = winston.createLogger({
  level: "info",
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

interface CliArgs {
  chainId: number;
  token: string;
  to: string;
  count: number;
  wait: boolean;
}

function parseArgs(): CliArgs {
  const argv = minimist(process.argv.slice(2), {
    string: ["chainId", "token", "to", "count"],
    boolean: ["wait"],
    default: { count: "3" },
  });
  for (const k of ["chainId", "token", "to"]) {
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
  const count = Number(argv.count);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`Invalid --count: ${argv.count}`);
  }
  return {
    chainId: Number(argv.chainId),
    token: argv.token,
    to: argv.to,
    count,
    wait: Boolean(argv.wait),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();

  const baseSigner = await retrieveSignerFromCLIArgs();
  const eoa = await baseSigner.getAddress();
  const provider = await getProvider(args.chainId);
  const signer = baseSigner.connect(provider);
  logger.info({ at: "test", message: "wallet connected", eoa, chainId: args.chainId, count: args.count });

  const callerId = `test-parallel-${Date.now()}`;
  await initTransactionBackend(logger, "redis", callerId);
  const txnClient = new TransactionClient(logger);

  const erc20 = new ethers.Contract(args.token, ERC20.abi, signer);
  const symbol = await erc20.symbol();

  // Build N independent AugmentedTransactions. Each transfers 0 tokens, so
  // balance isn't a constraint — only nonce ordering.
  const augTxns: AugmentedTransaction[] = Array.from({ length: args.count }, (_, idx) => ({
    contract: erc20,
    chainId: args.chainId,
    method: "transfer",
    args: [args.to, ethers.BigNumber.from(0)],
    message: `parallel-test-${idx + 1}`,
  }));

  logger.info({ at: "test", message: `Firing ${args.count} parallel submits…`, symbol });

  // Track per-submit completion so a hang shows which ones are still pending.
  const pending = new Set<number>(augTxns.map((_, idx) => idx + 1));
  const watchdog = setInterval(() => {
    if (pending.size > 0) {
      logger.warn({ at: "test", message: "Still awaiting ACK", pending: [...pending] });
    }
  }, 10_000);

  const t0 = Date.now();
  const results = await Promise.all(
    augTxns.map(async (txn, idx) => {
      const tStart = Date.now();
      try {
        const [response] = await txnClient.submit(args.chainId, [txn]);
        pending.delete(idx + 1);
        return { idx: idx + 1, hash: response.hash, nonce: response.nonce, ackMs: Date.now() - tStart, response };
      } catch (err) {
        pending.delete(idx + 1);
        logger.error({
          at: "test",
          message: "submit() rejected",
          idx: idx + 1,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    })
  );
  clearInterval(watchdog);

  const totalMs = Date.now() - t0;
  for (const r of results) {
    logger.info({ at: "test", message: "ACK", idx: r.idx, nonce: r.nonce, hash: r.hash, ackMs: r.ackMs });
  }

  // ---- assertions ----
  const sorted = [...results].sort((a, b) => a.nonce - b.nonce);
  const baseNonce = sorted[0].nonce;
  const expectedNonces = sorted.map((_, i) => baseNonce + i);
  const actualNonces = sorted.map((r) => r.nonce);
  const consecutive = expectedNonces.every((n, i) => n === actualNonces[i]);
  const hashes = new Set(results.map((r) => r.hash));
  const uniqueHashes = hashes.size === results.length;

  logger.info({
    at: "test",
    message: "results",
    totalMs,
    baseNonce,
    nonces: actualNonces,
    consecutive,
    uniqueHashes,
  });

  if (!consecutive) {
    throw new Error(`Non-consecutive nonces: ${JSON.stringify(actualNonces)}`);
  }
  if (!uniqueHashes) {
    throw new Error(`Duplicate hashes among ${results.length} results`);
  }

  if (args.wait) {
    const tWait = Date.now();
    const receipts = await Promise.all(
      results.map(async (r) => {
        const receipt = await r.response.wait();
        return {
          idx: r.idx,
          nonce: r.nonce,
          hash: receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          status: receipt.status,
        };
      })
    );
    for (const r of receipts) {
      logger.info({ at: "test", message: "final", ...r });
    }
    logger.info({ at: "test", message: "all confirmed", confirmationMs: Date.now() - tWait });
  }

  await disposeTransactionBackend();
}

void main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ at: "test", message: "fatal", error: err instanceof Error ? err.stack : String(err) });
    process.exit(1);
  });
