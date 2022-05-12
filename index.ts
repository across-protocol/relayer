import { delay, Logger, winston } from "./src/utils";

import { runRelayer } from "./src/relayer";
import { runDataworker } from "./src/dataworker";
import { runMonitor } from "./src/monitor";

let logger: winston.Logger;

export async function run(): Promise<void> {
  logger = Logger;
  if (process.argv.includes("--relayer")) await runRelayer(Logger);
  else if (process.argv.includes("--dataworker")) await runDataworker(Logger);
  else if (process.argv.includes("--monitor")) await runMonitor(Logger);
  else console.log("Select either relayer, dataworker or monitor to run!");
}

if (require.main === module) {
  run()
    .then(() => {
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error({ at: "InfrastructureEntryPoint", message: "There was an error in the main entry point!", error });
      await delay(5);
      await run();
    });
}
