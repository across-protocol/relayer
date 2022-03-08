import winston from "winston";
import { Logger } from "@uma/financial-templates-lib";
import { config } from "dotenv";
config();

import { getProvider, getSigner } from "./utils";
import { RelayerConfig } from "./RelayerConfig";

export async function run(logger: winston.Logger): Promise<void> {
  const config = new RelayerConfig(process.env);
  logger.debug({ at: "Relayer#index", message: "Relayer starting🚀", config });

  const provider = getProvider(1);
  console.log("provider", provider);

  const signer = getSigner();
  console.log("signer", signer);
}

if (require.main === module) {
  run(Logger)
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      Logger.error({ at: "Relayer#index", message: "Relayer execution error🚨", error });
      process.exit(1);
    });
}
