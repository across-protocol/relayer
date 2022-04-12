import { delay, Logger } from "@uma/financial-templates-lib";

import { runRelayer } from "./src/relayer";

export async function run(): Promise<void> {
  if (process.argv.includes("--relayer")) await runRelayer(Logger);
  else if (process.argv.includes("--dataworker")) console.log("NOT YET IMPLEMENTED");
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
