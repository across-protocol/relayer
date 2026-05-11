/*
Live tail of TransactionManager request/response Pub/Sub traffic.

Usage:
  yarn ts-node ./scripts/inspectTxnPubsub.ts --chain 11155111
  yarn ts-node ./scripts/inspectTxnPubsub.ts --chain 11155111 --id req-abc
  yarn ts-node ./scripts/inspectTxnPubsub.ts --chain 11155111 --failures-only

Args:
  --chain <id>          required
  --id <reqId>          filter to a specific correlation id
  --failures-only       filter to ok:false messages (responses only)
  --url <url>           redis URL (default REDIS_URL)
*/

import minimist from "minimist";
import winston from "winston";
import { connectRedisClient, disconnectRedisClient } from "../src/utils/Redis";
import { decodeRequest, decodeResponse } from "../src/transactionManager/wire";

interface CliArgs {
  chain: number;
  id?: string;
  failuresOnly: boolean;
  url: string | undefined;
}

const logger = winston.createLogger({
  level: "info",
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

function parseArgs(): CliArgs {
  const argv = minimist(process.argv.slice(2), {
    string: ["url", "id"],
    boolean: ["failures-only"],
  });
  if (!argv.chain) {
    throw new Error("--chain is required");
  }
  return {
    chain: Number(argv.chain),
    id: typeof argv.id === "string" ? argv.id : undefined,
    failuresOnly: Boolean(argv["failures-only"]),
    url: typeof argv.url === "string" ? argv.url : undefined,
  };
}

function isRequestChannel(channel: string): boolean {
  return channel.startsWith("txn:requests:");
}

function render(channel: string, raw: string, args: CliArgs): void {
  try {
    const payload = isRequestChannel(channel) ? decodeRequest(raw) : decodeResponse(raw);
    if (args.id !== undefined && payload.id !== args.id) {
      return;
    }
    if (args.failuresOnly && (payload as { ok?: boolean }).ok !== false) {
      return;
    }
    process.stdout.write(`\n[${channel}]\n${JSON.stringify(payload, null, 2)}\n`);
  } catch (err) {
    logger.warn({
      at: "inspect",
      message: "decode failed",
      channel,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const client = await connectRedisClient(logger, args.url);

  const reqPattern = `txn:requests:${args.chain}:*`;
  const respPattern = `txn:responses:${args.chain}:*`;
  logger.info({ at: "inspect", message: "subscribing", patterns: [reqPattern, respPattern] });

  const listener = (msg: string, channel: string): void => render(channel, msg, args);
  await client.pSubscribe(reqPattern, listener);
  await client.pSubscribe(respPattern, listener);

  let stop = false;
  const onSignal = (): void => {
    stop = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  while (!stop) {
    await new Promise((r) => setTimeout(r, 250));
  }

  await client.pUnsubscribe(reqPattern, listener);
  await client.pUnsubscribe(respPattern, listener);
  await disconnectRedisClient(client, logger);
  logger.info({ at: "inspect", message: "stopped" });
}

void main().catch((err) => {
  logger.error({ at: "inspect", message: "fatal", error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
