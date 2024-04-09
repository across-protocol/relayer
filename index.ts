import minimist from "minimist";
import { config, delay, retrieveSignerFromCLIArgs, help, Logger, usage, winston } from "./src/utils";
import { runRelayer } from "./src/relayer";
import { runDataworker } from "./src/dataworker";
import { runMonitor } from "./src/monitor";
import { runFinalizer } from "./src/finalizer";
import { version } from "./package.json";

let logger: winston.Logger;

export async function run(args: { [k: string]: boolean | string }): Promise<void> {
  logger = Logger;

  const cmds = {
    dataworker: runDataworker,
    finalizer: runFinalizer,
    help: help,
    monitor: runMonitor,
    relayer: runRelayer,
  };

  // todo Make the mode of operation an operand, rather than an option.
  // i.e. ts-node ./index.ts [options] <relayer|...>
  // Note: ts does not produce a narrow type from Object.keys, so we have to help.
  const cmd = Object.keys(cmds).find((_cmd) => !!args[_cmd]);

  if (cmd === "help") {
    cmds[cmd]();
  } // no return
  else if (cmd === undefined) {
    usage("");
  } // no return
  else if (typeof args["wallet"] !== "string" || args["wallet"].length === 0) {
    // todo: Update usage() to provide a hint that wallet is missing/malformed.
    usage(""); // no return
  } else {
    // One global signer for use with a specific per-chain provider.
    // todo: Support a void signer for monitor mode (only) if no wallet was supplied.
    const signer = await retrieveSignerFromCLIArgs();
    await cmds[cmd](logger, signer);
  }
}

if (require.main === module) {
  // Inject version into process.env so CommonConfig and all subclasses inherit it.
  process.env.ACROSS_BOT_VERSION = version;
  config();

  const opts = {
    boolean: ["dataworker", "finalizer", "help", "monitor", "relayer"],
    string: ["wallet", "keys", "address"],
    default: { wallet: "secret" },
    alias: { h: "help" },
    unknown: usage,
  };

  const args = minimist(process.argv.slice(2), opts);

  run(args)
    .then(() => {
      process.exitCode = 0;
    })
    .catch(async (error) => {
      process.exitCode = 1;
      logger.error({
        at: "index",
        message: "There was an execution error!",
        reason: error,
        e: error,
        error,
        notificationPath: "across-error",
      });
      await delay(2);
    });
}
