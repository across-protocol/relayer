import { Logger } from "@uma/financial-templates-lib";
import { getProvider, getSigner } from "./src/utils";

import { runRelayer } from "./src/relayer";

export async function run(): Promise<void> {
  if (process.argv.includes("--relayer")) await runRelayer(Logger);

  if (process.argv.includes("--dataworker")) console.log("NOT YET IMPLEMENTED");

  console.log("Select either relayer OR dataworker");
}

if (require.main === module) {
  run()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error("Process exited with error", error);
      process.exit(1);
    });
}
