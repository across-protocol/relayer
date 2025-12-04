import minimist from "minimist";
import {
  config,
  delay,
  exit,
  retrieveSignerFromCLIArgs,
  help,
  Logger,
  usage,
  waitForLogger,
  stringifyThrownValue,
} from "./src/utils";
import { runRelayer, runRebalancer, runInventoryManager } from "./src/relayer";
import { runDataworker, runDisputerWatchdog } from "./src/dataworker";
import { runMonitor } from "./src/monitor";
import { runFinalizer } from "./src/finalizer";
import { version } from "./package.json";
import { runRefiller } from "./src/refiller";
import { runHyperliquidExecutor, runHyperliquidFinalizer } from "./src/hyperliquid";

let logger: typeof Logger;
let cmd: string;

const CMDS = {
  dataworker: runDataworker,
  "disputer-watchdog": runDisputerWatchdog,
  finalizer: runFinalizer,
  help: help,
  monitor: runMonitor,
  refiller: runRefiller,
  relayer: runRelayer,
  rebalancer: runRebalancer,
  hlExecutor: runHyperliquidExecutor,
  hlFinalizer: runHyperliquidFinalizer,
  inventoryManager: runInventoryManager,
};

export async function run(args: { [k: string]: boolean | string }): Promise<void> {
  logger = Logger;

  // todo Make the mode of operation an operand, rather than an option.
  // i.e. ts-node ./index.ts [options] <relayer|...>
  // Note: ts does not produce a narrow type from Object.keys, so we have to help.
  cmd = Object.keys(CMDS).find((_cmd) => !!args[_cmd]);

  if (cmd === "help") {
    CMDS[cmd]();
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
    await CMDS[cmd](logger, signer);
  }
}

if (require.main === module) {
  // Inject version into process.env so CommonConfig and all subclasses inherit it.
  process.env.ACROSS_BOT_VERSION = version;
  config();

  const opts = {
    boolean: Object.keys(CMDS),
    string: ["wallet", "keys", "address", "binanceSecretKey"],
    default: { wallet: "secret" },
    alias: { h: "help" },
    unknown: usage,
  };

  const args = minimist(process.argv.slice(2), opts);

  let exitCode = 0;
  run(args)
    .catch(async (error) => {
      exitCode = 1;
      const stringifiedError = stringifyThrownValue(error);
      logger.error({
        at: cmd ?? "unknown process",
        message: "There was an execution error!",
        error: stringifiedError,
        args,
        notificationPath: "across-error",
      });
    })
    .finally(async () => {
      await waitForLogger(logger);
      await delay(5); // Wait 5s for logger to flush.
      exit(exitCode);
    });
}
