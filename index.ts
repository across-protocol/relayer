import { delay, Logger } from "@uma/financial-templates-lib";

import { runRelayer } from "./src/relayer";
import { runDataworker } from "./src/dataworker";

export async function run(): Promise<void> {
  if (process.argv.includes("--relayer")) await runRelayer(Logger);
  else if (process.argv.includes("--dataworker")) await runDataworker(Logger);
  else console.log("Select either relayer OR dataworker");
}

if (require.main === module) {
  run()
    .then(() => {
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      await delay(5);
      process.exit(1);
    });
}
