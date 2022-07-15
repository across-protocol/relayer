import minimist from "minimist";
import { delay, help, Logger, usage, winston } from "./src/utils";
import { runRelayer } from "./src/relayer";
import { runDataworker } from "./src/dataworker";
import { runMonitor } from "./src/monitor";
import { runFinalizer } from "./src/finalizer";

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

  /* todo Make the mode of operation an operand, rather than an option.
   * i.e. ts-node ./index.ts [options] <relayer|...>
   */
  const cmd = Object.keys(cmds).find((_cmd) => !!args[_cmd]);

  if (cmd === "help") cmds[cmd](); // no return
  else if (cmd === undefined) usage(""); // no return
  else if (typeof args["wallet"] !== "string" || args["wallet"].length === 0) {
    // todo: Update usage() to provide a hint that wallet is missing/malformed.
    usage(""); // no return
  } else {
    await cmds[cmd](logger);
  }
}

if (require.main === module) {
  const opts = {
    boolean: ["dataworker", "finalizer", "help", "monitor", "relayer"],
    string: ["wallet"],
    alias: { h: "help" },
    unknown: usage,
  };
  const args = minimist(process.argv.slice(2), opts);

  run(args)
    .then(() => {
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error({
        at: "InfrastructureEntryPoint",
        message: "There was an error in the main entry point!",
        error,
        notificationPath: "across-error",
      });
      await delay(5);
      await run(args);
    });
}
